import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, type Envelope, type KeyBundle, type StoredMessage } from '../protocol.js';
import {
  MailboxStorageUnavailableError,
  SupabaseMailboxStore,
} from '../supabase-store.js';
import type { MailboxClock, MailboxRpcPort } from '../supabase-store.js';
import {
  FakeClock,
  identityOf,
  makeBundle,
  makeEnvelope,
  makeSigner,
} from './helpers.js';

interface FakeRow {
  seq: number;
  id: string;
  envelope: Envelope;
  stored_at: number;
}

class FakeMailboxRpc implements MailboxRpcPort {
  readonly keys = new Map<string, KeyBundle>();
  readonly counters = new Map<string, number>();
  readonly messages = new Map<string, FakeRow[]>();
  readonly posts = new Map<string, number[]>();
  readonly idempotency = new Map<string, Map<string, { requestHash: string; id: string; storedAt: number }>>();
  fail = false;

  async rpc<T = unknown>(
    functionName: string,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    if (this.fail) throw new Error('injected network failure');
    const mailboxIdValue = args['p_mailbox_id'];
    const mailboxId = typeof mailboxIdValue === 'string' ? mailboxIdValue : '';
    const now = Number(args['p_now'] ?? args['p_stored_at'] ?? 0);

    switch (functionName) {
      case 'skillx_runtime_mailbox_get_key':
        return (this.keys.get(mailboxId) ?? null) as T;

      case 'skillx_runtime_mailbox_put_key': {
        const bundle: KeyBundle = {
          v: 1,
          identity_pubkey: String(args['p_identity_pubkey']),
          x_pubkey: String(args['p_x_pubkey']),
          created_at: String(args['p_created_at']),
          sig: String(args['p_sig']),
        };
        const old = this.keys.get(mailboxId);
        if (old === undefined) {
          if (this.keys.size >= 10_000) throw Object.assign(new Error(), { sqlState: 'P0001' });
          this.keys.set(mailboxId, bundle);
          this.counters.set(mailboxId, 0);
          return 'created' as T;
        }
        if (bundle.created_at > old.created_at) {
          this.keys.set(mailboxId, bundle);
          return 'replaced' as T;
        }
        if (bundle.created_at === old.created_at) return 'unchanged' as T;
        throw Object.assign(new Error(), { sqlState: '23505' });
      }

      case 'skillx_runtime_mailbox_add_message_idempotent': {
        if (!this.keys.has(mailboxId)) throw Object.assign(new Error(), { sqlState: 'P0002' });
        const key = args['p_idempotency_key'];
        const requestHash = args['p_request_hash'];
        let records = this.idempotency.get(mailboxId);
        if (records !== undefined) {
          for (const [recordKey, record] of records) {
            if (now - record.storedAt >= 14 * 24 * 60 * 60 * 1000) records.delete(recordKey);
          }
        }
        if (typeof key === 'string') {
          const existing = records?.get(key);
          if (existing !== undefined) {
            if (existing.requestHash !== requestHash) {
              throw Object.assign(new Error(), { sqlState: '23505' });
            }
            return { id: existing.id, duplicate: true } as T;
          }
        }
        const postLog = (this.posts.get(mailboxId) ?? []).filter((time) => now - time < 60_000);
        if (postLog.length >= 60) throw Object.assign(new Error(), { sqlState: 'P0001' });
        const current = (this.messages.get(mailboxId) ?? []).filter((message) => now - message.stored_at < 14 * 24 * 60 * 60 * 1000);
        if (current.length >= 200) throw Object.assign(new Error(), { sqlState: 'P0001' });
        const seq = (this.counters.get(mailboxId) ?? 0) + 1;
        const id = String(args['p_message_id']);
        current.push({
          seq,
          id,
          envelope: args['p_envelope'] as Envelope,
          stored_at: now,
        });
        this.counters.set(mailboxId, seq);
        this.messages.set(mailboxId, current);
        postLog.push(now);
        this.posts.set(mailboxId, postLog);
        if (typeof key === 'string' && typeof requestHash === 'string') {
          if (records === undefined) {
            records = new Map();
            this.idempotency.set(mailboxId, records);
          }
          records.set(key, { requestHash, id, storedAt: now });
        }
        return { id, duplicate: false } as T;
      }

      case 'skillx_runtime_mailbox_list_messages': {
        const after = Number(args['p_after'] ?? 0);
        const limit = Number(args['p_limit'] ?? 100);
        const current = (this.messages.get(mailboxId) ?? []).filter((message) => now - message.stored_at < 14 * 24 * 60 * 60 * 1000);
        this.messages.set(mailboxId, current);
        const selected = current.filter((message) => message.seq > after).slice(0, limit);
        const next = selected.length > 0 ? selected[selected.length - 1]!.seq : after;
        const messages: StoredMessage[] = selected.map((message) => ({
          seq: message.seq,
          id: message.id,
          envelope: message.envelope,
          stored_at: message.stored_at,
        }));
        return { messages, next } as T;
      }

      case 'skillx_runtime_mailbox_delete_message': {
        const messageIdValue = args['p_message_id'];
        const messageId = typeof messageIdValue === 'string' ? messageIdValue : '';
        const current = (this.messages.get(mailboxId) ?? []).filter((message) => now - message.stored_at < 14 * 24 * 60 * 60 * 1000);
        const index = current.findIndex((message) => message.id === messageId);
        if (index < 0) {
          this.messages.set(mailboxId, current);
          return false as T;
        }
        current.splice(index, 1);
        this.messages.set(mailboxId, current);
        return true as T;
      }

      default:
        throw new Error('unexpected RPC function');
    }
  }
}

function makeStore(rpc: FakeMailboxRpc, clock: MailboxClock): SupabaseMailboxStore {
  return new SupabaseMailboxStore(rpc, clock);
}

test('Supabase mailbox adapter stores a key and round-trips encrypted envelopes', async () => {
  const rpc = new FakeMailboxRpc();
  const clock = new FakeClock(1_700_000_000_000);
  const store = makeStore(rpc, clock);
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  const bundle = await makeBundle(signer, clock.nowIso());
  const envelope = makeEnvelope();

  assert.equal(await store.putKey(bundle, mailboxId), 'created');
  assert.deepEqual(await store.getKey(mailboxId), bundle);

  const added = await store.addMessage(mailboxId, envelope);
  const listed = await store.listMessages(mailboxId, 0, 100);
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0]?.id, added.id);
  assert.deepEqual(listed.messages[0]?.envelope, envelope);
  assert.equal(listed.messages[0]?.stored_at, clock.nowMs());
  assert.equal(listed.next, 1);
});

test('Supabase mailbox adapter preserves sequence after delete and expires old messages', async () => {
  const rpc = new FakeMailboxRpc();
  const clock = new FakeClock(1_700_000_000_000);
  const store = makeStore(rpc, clock);
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  await store.putKey(await makeBundle(signer, clock.nowIso()), mailboxId);

  const first = await store.addMessage(mailboxId, makeEnvelope());
  assert.equal(await store.deleteMessage(mailboxId, first.id), true);
  clock.advance(2_000);
  await store.addMessage(mailboxId, makeEnvelope());

  const afterDelete = await store.listMessages(mailboxId, 0, 100);
  assert.equal(afterDelete.messages[0]?.seq, 2);

  clock.advance(15 * 24 * 60 * 60 * 1000);
  const afterExpiry = await store.listMessages(mailboxId, 0, 100);
  assert.equal(afterExpiry.messages.length, 0);
});

test('Supabase mailbox adapter returns the original id for a repeated idempotency key', async () => {
  const rpc = new FakeMailboxRpc();
  const clock = new FakeClock(1_700_000_000_000);
  const store = makeStore(rpc, clock);
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  await store.putKey(await makeBundle(signer, clock.nowIso()), mailboxId);
  const envelope = makeEnvelope();
  const key = 'a'.repeat(32);

  const first = await store.addMessage(mailboxId, envelope, key);
  const repeated = await store.addMessage(mailboxId, envelope, key);

  assert.equal(first.duplicate, false);
  assert.deepEqual(repeated, { id: first.id, duplicate: true });
  const listed = await store.listMessages(mailboxId, 0, 100);
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.next, 1);
});

test('Supabase mailbox adapter rejects a reused key with different content', async () => {
  const rpc = new FakeMailboxRpc();
  const clock = new FakeClock(1_700_000_000_000);
  const store = makeStore(rpc, clock);
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  await store.putKey(await makeBundle(signer, clock.nowIso()), mailboxId);
  const key = 'b'.repeat(32);

  await store.addMessage(mailboxId, makeEnvelope(), key);
  await assert.rejects(
    () => store.addMessage(mailboxId, makeEnvelope(), key),
    (error: unknown) => error instanceof ApiError && error.code === 'CONFLICT',
  );
});

test('concurrent Supabase mailbox retries share one message and sequence', async () => {
  const rpc = new FakeMailboxRpc();
  const clock = new FakeClock(1_700_000_000_000);
  const store = makeStore(rpc, clock);
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  await store.putKey(await makeBundle(signer, clock.nowIso()), mailboxId);
  const envelope = makeEnvelope();
  const key = 'c'.repeat(32);

  const results = await Promise.all([
    store.addMessage(mailboxId, envelope, key),
    store.addMessage(mailboxId, envelope, key),
    store.addMessage(mailboxId, envelope, key),
  ]);

  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 2);
  assert.equal((await store.listMessages(mailboxId, 0, 100)).messages.length, 1);
  assert.equal(rpc.counters.get(mailboxId), 1);
});

test('Supabase mailbox adapter maps missing mailbox and storage failures safely', async () => {
  const rpc = new FakeMailboxRpc();
  const clock = new FakeClock(1_700_000_000_000);
  const store = makeStore(rpc, clock);

  await assert.rejects(
    () => store.addMessage('0'.repeat(64), makeEnvelope()),
    (error: unknown) => error instanceof ApiError && error.code === 'NOT_FOUND',
  );

  rpc.fail = true;
  await assert.rejects(
    () => store.getKey('0'.repeat(64)),
    MailboxStorageUnavailableError,
  );
});
