import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryCommitment, signAttestation } from '../../crypto/src/index.js';
import { DAY, T0, TestLedger, h, iso, newIdentity, uuid } from '../../testing/src/fixtures.js';
import type { Identity } from '../../testing/src/fixtures.js';
import { attestationBody, detectCircularTradingBetweenPair, findCircularTradingPairs, findingHash, transferEdges } from './circular-trading.js';

let clock = T0;
const tick = (): number => { clock += 1000; return clock; };

function openDeal(ledger: TestLedger, n: number, buyer: Identity, seller: Identity, amount = 1000): string {
  const dealId = uuid(n);
  ledger.append('DealCreated', { deal_id: dealId, buyer: buyer.publicKey, seller: seller.publicKey, amount, criteria_hash: h(`c${n}`), deadline: iso(T0 + 30 * DAY) }, buyer, tick());
  ledger.append('EscrowFunded', { deal_id: dealId, from: buyer.publicKey, amount }, buyer, tick());
  return dealId;
}
const settle = (ledger: TestLedger, dealId: string, signer: Identity, to: Identity, amount: number): void => {
  ledger.append('EscrowReleased', { deal_id: dealId, to: to.publicKey, amount }, signer, tick());
};

test('a release in each direction between two accounts is a finding that references the earliest releases by hash', () => {
  const ledger = new TestLedger();
  const [a, b] = [newIdentity(), newIdentity()];
  const first = openDeal(ledger, 1, a, b);
  settle(ledger, first, a, b, 990);
  const later = openDeal(ledger, 2, a, b);
  settle(ledger, later, a, b, 990);
  const back = openDeal(ledger, 3, b, a, 500);
  settle(ledger, back, b, a, 495);
  const edges = transferEdges(ledger.entries);
  assert.ok(edges.ok);
  if (!edges.ok) return;
  assert.equal(edges.value.length, 3);

  const finding = detectCircularTradingBetweenPair(edges.value, b.publicKey, a.publicKey);
  assert.ok(finding !== null);
  const [low, high] = a.publicKey <= b.publicKey ? [a, b] : [b, a];
  assert.equal(finding.accountA, low.publicKey);
  assert.equal(finding.accountB, high.publicKey);
  const forward = low === a ? finding.forward : finding.reverse;
  assert.equal(forward.dealId, first, 'the earliest release in that direction');
  assert.equal(finding.forward.from, low.publicKey);
  assert.equal(finding.reverse.from, high.publicKey);
  assert.equal(finding.reverse.to, low.publicKey);
  assert.deepEqual(detectCircularTradingBetweenPair(edges.value, a.publicKey, b.publicKey), finding, 'the pair order does not matter');
});

test('one-way flows, refunds and funding alone are no finding', () => {
  const ledger = new TestLedger();
  const [a, b] = [newIdentity(), newIdentity()];
  const paid = openDeal(ledger, 1, a, b);
  settle(ledger, paid, a, b, 990);
  const refunded = openDeal(ledger, 2, b, a, 400);
  settle(ledger, refunded, b, b, 400); // refund to the buyer b: not a trade a<-b
  openDeal(ledger, 3, b, a, 300); // funded, never released
  const edges = transferEdges(ledger.entries);
  assert.ok(edges.ok);
  if (!edges.ok) return;
  assert.equal(edges.value.length, 1);
  assert.equal(detectCircularTradingBetweenPair(edges.value, a.publicKey, b.publicKey), null);
  assert.deepEqual(findCircularTradingPairs(edges.value), []);
  assert.deepEqual(transferEdges([]), { ok: true, value: [] });
});

test('a rotated account keeps its identity: the reverse trade under the new key still closes the circle', () => {
  const ledger = new TestLedger();
  const [a, b, recovery, next] = [newIdentity(), newIdentity(), newIdentity(), newIdentity()];
  const out = openDeal(ledger, 1, a, b);
  settle(ledger, out, a, b, 990);
  const body = { old_pubkey: b.publicKey, new_pubkey: next.publicKey, new_recovery_commitment: recoveryCommitment(next.publicKey) };
  ledger.append('KeyRotated', { ...body, recovery_pubkey: recovery.publicKey, sig: signAttestation('key-rotation', body, recovery.privateKey) }, next, tick());
  const back = openDeal(ledger, 2, next, a, 500);
  settle(ledger, back, next, a, 495);
  const edges = transferEdges(ledger.entries);
  assert.ok(edges.ok);
  if (!edges.ok) return;
  assert.ok(edges.value.every((edge) => edge.from !== b.publicKey && edge.to !== b.publicKey), 'the old key is reported under the new one');
  assert.ok(detectCircularTradingBetweenPair(edges.value, a.publicKey, next.publicKey) !== null);
});

test('a release to the seller after the seller rotated is still a trade', () => {
  const ledger = new TestLedger();
  const [a, b, recovery, next] = [newIdentity(), newIdentity(), newIdentity(), newIdentity()];
  const dealId = openDeal(ledger, 1, a, b);
  const body = { old_pubkey: b.publicKey, new_pubkey: next.publicKey, new_recovery_commitment: recoveryCommitment(next.publicKey) };
  ledger.append('KeyRotated', { ...body, recovery_pubkey: recovery.publicKey, sig: signAttestation('key-rotation', body, recovery.privateKey) }, next, tick());
  settle(ledger, dealId, a, next, 990);
  const edges = transferEdges(ledger.entries);
  assert.ok(edges.ok);
  if (edges.ok) assert.deepEqual(edges.value.map((e) => [e.from, e.to]), [[a.publicKey, next.publicKey]]);
});

test('malformed ledgers are errors: unknown deal, gaps in the receipt sequence, invalid amounts', () => {
  const ledger = new TestLedger();
  const [a, b] = [newIdentity(), newIdentity()];
  settle(ledger, uuid(9), a, b, 10);
  const unknown = transferEdges(ledger.entries);
  assert.ok(!unknown.ok && unknown.error.code === 'STATE');

  const good = new TestLedger();
  const dealId = openDeal(good, 1, a, b);
  settle(good, dealId, a, b, 990);
  const gap = transferEdges([good.entries[0], good.entries[2]].flatMap((e) => (e === undefined ? [] : [e])));
  assert.ok(!gap.ok && gap.error.code === 'RECEIPT_SEQUENCE');

  for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 10.5, 0, -10, -0, Number.MAX_SAFE_INTEGER + 2]) {
    const bad = new TestLedger();
    const id = openDeal(bad, 1, a, b);
    const released = bad.entries.length;
    bad.entries.push({ ...bad.append('EscrowReleased', { deal_id: id, to: b.publicKey, amount: 1 }, a, tick()) });
    const entry = bad.entries[released];
    assert.ok(entry !== undefined);
    const tampered = { ...entry, event: { ...entry.event, payload: { ...entry.event.payload, amount } } } as typeof entry;
    const result = transferEdges([...bad.entries.slice(0, released), tampered]);
    assert.ok(!result.ok && result.error.code === 'AMOUNT', `amount ${String(amount)}`);
  }
});

test('findCircularTradingPairs lists each pair once in a deterministic order, and the finding hash binds the evidence', () => {
  const ledger = new TestLedger();
  const ids = [newIdentity(), newIdentity(), newIdentity(), newIdentity()];
  const [a, b, c, d] = ids as [Identity, Identity, Identity, Identity];
  let n = 1;
  const pay = (from: Identity, to: Identity): void => { const id = openDeal(ledger, n, from, to); n += 1; settle(ledger, id, from, to, 990); };
  pay(c, d); pay(a, b); pay(d, c); pay(b, a); pay(a, c);
  const edges = transferEdges(ledger.entries);
  assert.ok(edges.ok);
  if (!edges.ok) return;
  const found = findCircularTradingPairs(edges.value);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => new Set([f.accountA, f.accountB])), [new Set([c.publicKey, d.publicKey]), new Set([a.publicKey, b.publicKey])]);
  assert.deepEqual(findCircularTradingPairs(edges.value), found, 'deterministic');

  const first = found[0];
  assert.ok(first !== undefined);
  const hash = findingHash(first, ledger.entries.length);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, findingHash(first, ledger.entries.length + 1));
  assert.notEqual(hash, findingHash(found[1] ?? first, ledger.entries.length));
  const body = attestationBody(first, ledger.entries.length);
  assert.equal(body['rule_id'], 'circular-trading-pair');
  assert.equal(typeof body['forward'], 'object');
});
