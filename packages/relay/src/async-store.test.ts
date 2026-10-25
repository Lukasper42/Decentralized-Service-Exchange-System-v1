import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';
import type { LedgerEntry } from './store.js';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import { recoveryCommitment } from '../../crypto/src/index.js';

/** Store whose append completes on a later tick, like a database round trip. */
class SlowStore extends MemoryStore {
  failNext = false;
  override open(): Promise<void> { return Promise.resolve(); }
  override close(): Promise<void> { return Promise.resolve(); }
  override append(entry: LedgerEntry): Promise<void> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (this.failNext) { reject(new Error('connection lost')); return; }
        try { super.append(entry); resolve(); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      }, 1);
    });
  }
}
const accountEvent = (rig: RelayRig, who: RelayRig['cast']['buyer']) => rig.build('AccountCreated', { pubkey: who.publicKey, recovery_commitment: recoveryCommitment(rig.cast.extra[0]?.publicKey ?? who.publicKey), invite_ref: null }, who);

test('submitAsync: concurrent submits over an async store get contiguous sequences and no fork', async () => {
  const store = new SlowStore();
  const rig = new RelayRig(store);
  const started = await rig.relay.startAsync();
  assert.ok(started.ok);
  const a = accountEvent(rig, rig.cast.buyer);
  const b = accountEvent(rig, rig.cast.seller);
  const results = await Promise.all([rig.relay.submitAsync(a), rig.relay.submitAsync(b), rig.relay.submitAsync(a)]);
  assert.ok(results[0]?.ok && results[1]?.ok && results[2]?.ok);
  assert.deepEqual(store.all().map((e) => e.receipt.sequence), [1, 2]);
  assert.equal(results[2]?.ok && results[2].value.duplicate, true);
  await rig.relay.closeAsync();
});

test('submitAsync: a failing append yields STORE_FAILURE, nothing is visible and the relay turns read-only', async () => {
  const store = new SlowStore();
  const rig = new RelayRig(store);
  await rig.relay.startAsync();
  store.failNext = true;
  const result = await rig.relay.submitAsync(accountEvent(rig, rig.cast.buyer));
  assert.ok(!result.ok && result.error.code === 'STORE_FAILURE');
  assert.equal(store.tipSequence(), 0);
  assert.equal(rig.relay.readOnly, true);
  const after = await rig.relay.submitAsync(accountEvent(rig, rig.cast.seller));
  assert.ok(!after.ok && after.error.code === 'READ_ONLY');
});

test('the synchronous API refuses an asynchronous store instead of releasing an unconfirmed receipt', async () => {
  const store = new SlowStore();
  const rig = new RelayRig(store);
  await rig.relay.startAsync();
  const result = rig.relay.submit(accountEvent(rig, rig.cast.buyer));
  assert.ok(!result.ok && result.error.code === 'STORE_FAILURE');
  assert.throws(() => new RelayRig(new SlowStore()).relay.start(), /startAsync/);
});
