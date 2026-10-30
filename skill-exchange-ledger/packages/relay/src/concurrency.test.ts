import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyChain } from '../../chain-verifier/src/index.js';
import { eventHash } from '../../crypto/src/index.js';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import { eventOf, h, iso, uuid } from '../../testing/src/fixtures.js';

test('many signers interleaved (and one signer racing itself) yield unique contiguous sequences and per-signer chains', () => {
  const rig = new RelayRig();
  rig.relay.start();
  // Genesis accounts are fixed in the rig; use the cast jurors (genesis) as the concurrent signers.
  const signers = rig.cast.jurors.slice(0, 6);
  for (const who of [...signers, rig.cast.seller]) { rig.now += 10; assert.ok(rig.createAccount(who).ok); }
  // Each signer queues a chain of events built up front from its own tip, then submission order is shuffled.
  const queues = signers.map((who) => {
    const chain: ReturnType<typeof rig.build>[] = [];
    let prev = rig.tips.get(who.publicKey) ?? null;
    for (let i = 0; i < 4; i += 1) {
      const buyer = who;
      const seller = rig.cast.seller;
      const event = eventOf('DealCreated', { deal_id: uuid(1000 + chain.length + signers.indexOf(who) * 10), buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h(`c${i}`), deadline: iso(rig.now + 86400000) }, who, rig.now, prev);
      chain.push(event as never);
      prev = eventHash(event as never);
    }
    return chain;
  });
  // Interleave: round-robin over signers; each signer's own events stay in order.
  const cursor = signers.map(() => 0);
  let accepted = 0;
  for (let round = 0; round < 4; round += 1) for (let s = signers.length - 1; s >= 0; s -= 1) {
    const event = queues[s]?.[cursor[s] ?? 0];
    if (event === undefined) continue;
    const result = rig.relay.submit(event);
    assert.ok(result.ok, JSON.stringify(result));
    cursor[s] = (cursor[s] ?? 0) + 1;
    accepted += 1;
  }
  assert.equal(accepted, 24);
  const entries = rig.store.all();
  assert.equal(new Set(entries.map((e) => e.receipt.sequence)).size, entries.length);
  const keyId = entries[0]?.receipt.keyId ?? '';
  assert.ok(verifyChain(entries, [{ keyId, pubkey: rig.genesisKey.publicKey, validFromSequence: 1, validToSequence: null }]).ok);
});

test('one signer racing itself: of N events built from the same tip exactly one is accepted, the rest are FORK', () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const { buyer, seller } = rig.cast;
  const tip = rig.tips.get(buyer.publicKey) ?? null;
  const candidates = Array.from({ length: 10 }, (_, i) => eventOf('DealCreated', { deal_id: uuid(2000 + i), buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h(`r${i}`), deadline: iso(rig.now + 86400000) }, buyer, rig.now, tip));
  const results = candidates.map((event) => rig.relay.submit(event as never));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.deepEqual(new Set(results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.error.code))), new Set(['FORK']));
  assert.equal(rig.relay.tipSequence, 3);
});

test('submissions made from separate async tasks cannot obtain the same sequence', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const { seller } = rig.cast;
  for (const who of rig.cast.jurors) { rig.now += 5; assert.ok(rig.createAccount(who).ok); }
  const tasks = rig.cast.jurors.map((who) => Promise.resolve().then(() => rig.relay.submit(eventOf('DealCreated', { deal_id: uuid(3000 + rig.cast.jurors.indexOf(who)), buyer: who.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h('t'), deadline: iso(rig.now + 86400000) }, who, rig.now, rig.tips.get(who.publicKey) ?? null) as never)));
  const done = await Promise.all(tasks);
  assert.ok(done.every((r) => r.ok));
  const sequences = rig.store.all().map((e) => e.receipt.sequence);
  assert.deepEqual(sequences, sequences.map((_, i) => i + 1));
});
