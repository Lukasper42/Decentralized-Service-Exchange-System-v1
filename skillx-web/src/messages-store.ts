import type { CryptoPort, RandomPort, StoragePort } from './ports.js';
import type { Result } from './types.js';
import { err, ok } from './types.js';
import { b64DecodeStrict, b64Encode } from './crypto.js';

export type MessageDirection = 'in' | 'out';

export interface StoredMessage {
  serverId: string;
  peer: string;
  direction: MessageDirection;
  sentAt: string;
  body: string;
  seq: number | null;
}

interface PersistBlob {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
}

const STORAGE_KEY = 'skillx.messages.v1';
const PBKDF2_ITERATIONS = 600000;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as unknown as ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isPersistBlob(value: unknown): value is PersistBlob {
  if (!isRecord(value)) return false;
  return (
    value['v'] === 1 &&
    typeof value['salt'] === 'string' &&
    typeof value['iv'] === 'string' &&
    typeof value['ct'] === 'string'
  );
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (!isRecord(value)) return false;
  const direction = value['direction'];
  const seq = value['seq'];
  return (
    typeof value['serverId'] === 'string' &&
    typeof value['peer'] === 'string' &&
    (direction === 'in' || direction === 'out') &&
    typeof value['sentAt'] === 'string' &&
    typeof value['body'] === 'string' &&
    (seq === null || (isSafeInt(seq) && seq >= 0))
  );
}

async function deriveKey(
  crypto: CryptoPort,
  password: string,
  salt: Uint8Array,
  usage: KeyUsage
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    ab(utf8(password)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: ab(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

export class MessagesStore {
  private readonly byId = new Map<string, StoredMessage>();

  constructor(
    private readonly crypto: CryptoPort,
    private readonly storage: StoragePort,
    private readonly random: RandomPort
  ) {}

  add(message: StoredMessage): void {
    this.byId.set(message.serverId, message);
  }

  addMany(messages: readonly StoredMessage[]): void {
    for (const message of messages) {
      this.add(message);
    }
  }

  remove(serverId: string): void {
    this.byId.delete(serverId);
  }

  clear(): void {
    this.byId.clear();
  }

  listByPeer(): Map<string, StoredMessage[]> {
    const groups = new Map<string, StoredMessage[]>();
    for (const message of this.byId.values()) {
      const group = groups.get(message.peer);
      if (group === undefined) {
        groups.set(message.peer, [message]);
      } else {
        group.push(message);
      }
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    }
    return groups;
  }

  async persist(password: string): Promise<Result<void>> {
    try {
      const plaintext = JSON.stringify(Array.from(this.byId.values()));
      const salt = this.random.bytes(16);
      const iv = this.random.bytes(12);
      if (salt.length !== 16 || iv.length !== 12) {
        return err('POLICY', 'invalid random output', 'messages.persist');
      }
      const key = await deriveKey(this.crypto, password, salt, 'encrypt');
      const ct = await this.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: ab(iv) },
        key,
        ab(utf8(plaintext))
      );
      const blob: PersistBlob = {
        v: 1,
        salt: b64Encode(salt),
        iv: b64Encode(iv),
        ct: b64Encode(new Uint8Array(ct))
      };
      this.storage.set(STORAGE_KEY, JSON.stringify(blob));
      return ok(undefined);
    } catch {
      return err('POLICY', 'persist failed', 'messages.persist');
    }
  }

  async load(password: string): Promise<Result<boolean>> {
    try {
      const raw = this.storage.get(STORAGE_KEY);
      if (raw === null) return ok(false);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return err('FIELD_FORMAT', 'invalid stored blob', 'messages.load');
      }
      if (!isPersistBlob(parsed)) {
        return err('FIELD_FORMAT', 'invalid stored blob shape', 'messages.load');
      }
      const salt = b64DecodeStrict(parsed.salt);
      const iv = b64DecodeStrict(parsed.iv);
      const ct = b64DecodeStrict(parsed.ct);
      if (salt.length !== 16 || iv.length !== 12) {
        return err('FIELD_FORMAT', 'invalid stored blob crypto fields', 'messages.load');
      }
      const key = await deriveKey(this.crypto, password, salt, 'decrypt');
      const plaintext = await this.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ab(iv) },
        key,
        ab(ct)
      );
      const json = new TextDecoder().decode(new Uint8Array(plaintext));
      const value: unknown = JSON.parse(json);
      if (!Array.isArray(value)) {
        return err('FIELD_FORMAT', 'invalid stored messages', 'messages.load');
      }
      const messages: StoredMessage[] = [];
      for (const entry of value) {
        if (!isStoredMessage(entry)) {
          return err('FIELD_FORMAT', 'invalid stored message', 'messages.load');
        }
        messages.push(entry);
      }
      this.clear();
      this.addMany(messages);
      return ok(true);
    } catch {
      return err('POLICY', 'load failed', 'messages.load');
    }
  }
}
