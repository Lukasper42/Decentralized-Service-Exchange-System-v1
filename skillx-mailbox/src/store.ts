import { bytesToHex } from './b64.js';
import type { ClockPort, RandomPort, StoreFilePort } from './ports.js';
import {
  ApiError,
  MAILBOX_ID_RE,
  asObject,
  mailboxIdOf,
  parseEnvelope,
  parseKeyBundle,
  parseStoredMessage,
} from './protocol.js';
import type { Envelope, KeyBundle, StoredMessage } from './protocol.js';

const MESSAGE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 200;
const MAX_POSTS_PER_MINUTE = 60;
const MAX_KEYS = 10_000;

export interface StoreDeps {
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly file: StoreFilePort;
}

export type PutKeyResult = 'created' | 'replaced' | 'unchanged';

export class MailboxStore {
  private readonly deps: StoreDeps;
  private readonly keys = new Map<string, KeyBundle>();
  private readonly messages = new Map<string, StoredMessage[]>();
  private readonly seqs = new Map<string, number>();
  private readonly postLog = new Map<string, number[]>();
  private chain: Promise<void> = Promise.resolve();

  private constructor(deps: StoreDeps) {
    this.deps = deps;
  }

  static async load(deps: StoreDeps): Promise<MailboxStore> {
    const store = new MailboxStore(deps);
    const text = await deps.file.read();
    if (text !== null) {
      store.hydrate(text);
    }
    return store;
  }

  getKey(mailboxId: string): KeyBundle | undefined {
    return this.keys.get(mailboxId);
  }

  hasKey(mailboxId: string): boolean {
    return this.keys.has(mailboxId);
  }

  async putKey(bundle: KeyBundle): Promise<PutKeyResult> {
    const mailboxId = mailboxIdOf(bundle.identity_pubkey);
    const existing = this.keys.get(mailboxId);
    if (existing === undefined) {
      if (this.keys.size >= MAX_KEYS) {
        throw new ApiError('RATE_LIMITED', 'too many mailboxes');
      }
      this.keys.set(mailboxId, bundle);
      await this.persist();
      return 'created';
    }
    if (bundle.created_at > existing.created_at) {
      this.keys.set(mailboxId, bundle);
      await this.persist();
      return 'replaced';
    }
    if (bundle.created_at === existing.created_at) {
      return 'unchanged';
    }
    throw new ApiError('CONFLICT', 'key bundle is older than stored one');
  }

  async addMessage(mailboxId: string, envelope: Envelope): Promise<{ id: string }> {
    if (!this.keys.has(mailboxId)) {
      throw new ApiError('NOT_FOUND', 'no key bundle for mailbox');
    }
    const now = this.deps.clock.nowMs();
    this.checkRate(mailboxId, now);
    const { list } = this.clean(mailboxId, now);
    if (list.length >= MAX_MESSAGES) {
      throw new ApiError('RATE_LIMITED', 'mailbox is full');
    }
    const seq = Math.max(this.seqs.get(mailboxId) ?? 0, list[list.length - 1]?.seq ?? 0) + 1;
    const id = bytesToHex(this.deps.random.bytes(16));
    list.push({ seq, id, envelope, stored_at: now });
    this.messages.set(mailboxId, list);
    this.seqs.set(mailboxId, seq);
    const log = this.postLog.get(mailboxId) ?? [];
    log.push(now);
    this.postLog.set(mailboxId, log);
    await this.persist();
    return { id };
  }

  async listMessages(
    mailboxId: string,
    after: number,
    limit: number,
  ): Promise<{ messages: StoredMessage[]; next: number }> {
    const now = this.deps.clock.nowMs();
    const { list, changed } = this.clean(mailboxId, now);
    if (changed) {
      await this.persist();
    }
    const selected = list.filter((m) => m.seq > after).slice(0, limit);
    const last = selected.length > 0 ? selected[selected.length - 1] : undefined;
    return { messages: selected, next: last === undefined ? after : last.seq };
  }

  async deleteMessage(mailboxId: string, messageId: string): Promise<boolean> {
    const now = this.deps.clock.nowMs();
    const { list, changed } = this.clean(mailboxId, now);
    const index = list.findIndex((m) => m.id === messageId);
    if (index < 0) {
      if (changed) {
        await this.persist();
      }
      return false;
    }
    list.splice(index, 1);
    this.messages.set(mailboxId, list);
    await this.persist();
    return true;
  }

  private checkRate(mailboxId: string, now: number): void {
    const log = (this.postLog.get(mailboxId) ?? []).filter((t) => now - t < 60_000);
    this.postLog.set(mailboxId, log);
    if (log.length >= MAX_POSTS_PER_MINUTE) {
      throw new ApiError('RATE_LIMITED', 'too many posts per minute');
    }
  }

  private clean(
    mailboxId: string,
    now: number,
  ): { list: StoredMessage[]; changed: boolean } {
    const existing = this.messages.get(mailboxId) ?? [];
    const kept = existing.filter((m) => now - m.stored_at < MESSAGE_TTL_MS);
    const changed = kept.length !== existing.length;
    if (changed) {
      this.messages.set(mailboxId, kept);
    }
    return { list: kept, changed };
  }

  private persist(): Promise<void> {
    const text = this.serialize();
    const run = this.chain.then(() => this.deps.file.write(text));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private serialize(): string {
    const keys: Record<string, KeyBundle> = {};
    for (const [id, bundle] of this.keys) {
      keys[id] = bundle;
    }
    const messages: Record<string, StoredMessage[]> = {};
    for (const [id, list] of this.messages) {
      messages[id] = list;
    }
    const seq: Record<string, number> = {};
    for (const [id, value] of this.seqs) {
      seq[id] = value;
    }
    return JSON.stringify({ v: 1, keys, messages, seq });
  }

  private hydrate(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('store: invalid json');
    }
    const root = asObject(raw);
    if (root['v'] !== 1) {
      throw new Error('store: invalid version');
    }
    const keysRaw = root['keys'] === undefined ? {} : asObject(root['keys']);
    for (const [id, value] of Object.entries(keysRaw)) {
      if (!MAILBOX_ID_RE.test(id)) {
        throw new Error('store: invalid mailbox id');
      }
      const bundle = parseKeyBundle(value);
      if (mailboxIdOf(bundle.identity_pubkey) !== id) {
        throw new Error('store: mailbox id mismatch');
      }
      this.keys.set(id, bundle);
    }
    const messagesRaw = root['messages'] === undefined ? {} : asObject(root['messages']);
    for (const [id, value] of Object.entries(messagesRaw)) {
      if (!MAILBOX_ID_RE.test(id)) {
        throw new Error('store: invalid mailbox id');
      }
      if (!Array.isArray(value)) {
        throw new Error('store: invalid messages');
      }
      const list: StoredMessage[] = [];
      let previous = 0;
      for (const item of value) {
        const message = parseStoredMessage(item);
        if (message.seq <= previous) {
          throw new Error('store: invalid seq order');
        }
        previous = message.seq;
        list.push(message);
      }
      this.messages.set(id, list);
      const known = this.seqs.get(id) ?? 0;
      this.seqs.set(id, Math.max(known, previous));
    }
    const seqRaw = root['seq'] === undefined ? {} : asObject(root['seq']);
    for (const [id, value] of Object.entries(seqRaw)) {
      if (!MAILBOX_ID_RE.test(id)) {
        throw new Error('store: invalid mailbox id');
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('store: invalid seq counter');
      }
      this.seqs.set(id, Math.max(this.seqs.get(id) ?? 0, value));
    }
  }
}

export { parseEnvelope };
