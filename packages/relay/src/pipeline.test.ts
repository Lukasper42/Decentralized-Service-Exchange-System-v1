import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptHash } from '../../crypto/src/index.js';
import { verifyChain } from '../../chain-verifier/src/index.js';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import { DAY, T0, eventOf, h, iso, newIdentity, uuid, validPayload } from '../../testing/src/fixtures.js';
import type { RelayResult, SubmitOutcome } from './relay.js';
import { replayLedger } from './relay.js';

const code = (result: RelayResult<SubmitOutcome>): string => (result.ok ? 'OK' : result.error.code);

test('happy path: contiguous signed receipts, verifyChain accepts, replay reproduces the live state hash', () => {
  const rig = new RelayRig();
  rig.bootstrap();
  rig.openDeal(1);
  const entries = rig.store.all();
  assert.equal(entries.length, 5);
  entries.forEach((entry, i) => assert.equal(entry.receipt.sequence, i + 1));
  assert.equal(entries[1]?.receipt.previousReceiptHash, receiptHash(entries[0]?.receipt ?? (null as never)));
  const ranges = [{ keyId: entries[0]?.receipt.keyId ?? '', pubkey: rig.genesisKey.publicKey, validFromSequence: 1, validToSequence: null }];
  assert.ok(verifyChain(entries, ranges).ok);
  const replay = replayLedger(entries, rig.projector);
  assert.ok(replay.ok, JSON.stringify(replay));
  if (replay.ok) assert.equal(replay.value.stateHash, rig.relay.stateHash);
});

test('nothing is written when any pipeline step rejects: store, state hash and tips stay identical', () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const before = { tip: rig.relay.tipSequence, state: rig.relay.stateHash };
  const { buyer, outsider, seller } = rig.cast;
  const good = rig.build('DealCreated', { deal_id: uuid(5), buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h('c'), deadline: iso(rig.now + DAY) }, buyer);
  const tampered = { ...good, payload: { ...good.payload, amount: 5000 } } as unknown;
  const cases: Array<[string, unknown, string]> = [
    ['bad signature', tampered, 'SIGNATURE'],
    ['not an object', 'hello', 'ENVELOPE'],
    ['unknown type', { ...good, type: 'Nope' }, 'UNKNOWN_TYPE'],
    ['skewed timestamp', rig.build('DealAccepted', { deal_id: uuid(5), by: buyer.publicKey }, buyer, rig.now - 10 * 60 * 1000), 'TIMESTAMP'],
    ['unregistered signer', eventOf('DealCreated', { deal_id: uuid(6), buyer: outsider.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h('c'), deadline: iso(rig.now + DAY) }, newIdentity(), rig.now), 'SIGNER_AUTHORITY'],
    ['deal event on unknown deal', rig.build('DealAccepted', { deal_id: uuid(99), by: buyer.publicKey }, buyer), 'STATE'],
    ['rotation of an unknown account', (() => { const next = newIdentity(); return rig.build('KeyRotated', validPayload('KeyRotated', rig.cast, next, rig.now) as never, next); })(), 'STATE'],
    ['float amount', { ...good, payload: { ...good.payload, amount: 1.5 } }, 'PAYLOAD'],
  ];
  for (const [name, input, expected] of cases) {
    const result = rig.relay.submit(input);
    assert.equal(result.ok ? 'OK' : result.error.code, expected, name);
    if (!result.ok) assert.ok(result.error.path.length > 0 || result.error.code === 'ENVELOPE', name);
  }
  assert.deepEqual({ tip: rig.relay.tipSequence, state: rig.relay.stateHash }, before);
  assert.equal(rig.store.all().length, before.tip);
});

test('idempotent resubmission returns the original receipt and appends nothing', () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const event = rig.build('DealCreated', { deal_id: uuid(5), buyer: rig.cast.buyer.publicKey, seller: rig.cast.seller.publicKey, amount: 1000, criteria_hash: h('c'), deadline: iso(rig.now + DAY) }, rig.cast.buyer);
  const first = rig.submitEvent(event);
  assert.ok(first.ok && !first.value.duplicate);
  rig.now += 60_000;
  const again = rig.submitEvent(event);
  assert.ok(again.ok && again.value.duplicate);
  assert.deepEqual(again.ok ? again.value.receipt : null, first.ok ? first.value.receipt : undefined);
  assert.equal(rig.relay.tipSequence, 3);
});

test('signer-tip compare-and-append: a stale tip is CHAIN_LINK, a competing append is FORK, a second genesis is FORK', () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const { buyer, seller } = rig.cast;
  const deal = (n: number) => ({ deal_id: uuid(n), buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h('c'), deadline: iso(rig.now + DAY) });
  const staleBase = rig.tips.get(buyer.publicKey) ?? null;
  assert.equal(code(rig.submit('DealCreated', deal(1), buyer)), 'OK');
  const competing = eventOf('DealCreated', deal(2), buyer, rig.now, staleBase);
  assert.equal(code(rig.submitEvent(competing)), 'FORK');
  const unrelated = eventOf('DealCreated', deal(3), buyer, rig.now, h('not a real tip'));
  assert.equal(code(rig.submitEvent(unrelated)), 'CHAIN_LINK');
  const secondGenesis = eventOf('DealCreated', deal(4), buyer, rig.now, null);
  assert.equal(code(rig.submitEvent(secondGenesis)), 'FORK');
  assert.equal(rig.relay.tipSequence, 3);
});

test('invitations: a valid unused invite creates an account, reuse is REPLAY, unknown or missing invites are POLICY', () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const stranger = newIdentity();
  assert.equal(code(rig.createAccount(stranger)), 'POLICY');
  assert.equal(code(rig.createAccount(stranger, h('unknown invite'))), 'POLICY');
  const inviter = rig.cast.extra[1];
  assert.ok(inviter !== undefined);
  rig.now += 1000;
  rig.must('AccountCreated', { pubkey: inviter.publicKey, recovery_commitment: h('rc'), invite_ref: null }, inviter);
  assert.equal(code(rig.submit('AccountInvited', { invitee: stranger.publicKey, expires: iso(rig.now + DAY) }, rig.cast.buyer)), 'SIGNER_AUTHORITY');
  rig.now += 1000;
  const invited = rig.must('AccountInvited', { invitee: stranger.publicKey, expires: iso(rig.now + DAY) }, inviter);
  const inviteRef = invited.receipt.eventHash;
  const wrongInvitee = newIdentity();
  assert.equal(code(rig.createAccount(wrongInvitee, inviteRef)), 'SIGNER_AUTHORITY');
  assert.equal(code(rig.createAccount(stranger, inviteRef)), 'OK');
  assert.equal(code(rig.createAccount(newIdentity(), inviteRef)), 'REPLAY');
  assert.equal(code(rig.createAccount(stranger, inviteRef)), 'DUPLICATE');
  assert.ok(rig.relay.state.accounts[stranger.publicKey] !== undefined);
});

test('size limit, read-only mode and a relay that was never started', () => {
  const rig = new RelayRig();
  const early = rig.relay.submit({});
  assert.ok(!early.ok && early.error.code === 'READ_ONLY');
  rig.bootstrap();
  const { buyer, seller } = rig.cast;
  const big = rig.build('DealCreated', { deal_id: uuid(1), buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h('c'), deadline: iso(rig.now + DAY) }, buyer);
  const padded = { ...big, extra: 'x'.repeat(5000) };
  const large = rig.relay.submit(padded);
  assert.ok(!large.ok && large.error.code === 'TOO_LARGE');
  rig.relay.setReadOnly(true);
  const blocked = rig.relay.submit(big);
  assert.ok(!blocked.ok && blocked.error.code === 'READ_ONLY');
  rig.relay.setReadOnly(false);
  assert.ok(rig.relay.submit(big).ok);
});

test('receipt time is monotone even if the clock steps backwards', () => {
  const rig = new RelayRig();
  rig.bootstrap();
  rig.now += 10_000;
  rig.openDeal(1);
  const times = rig.store.all().map((e) => Date.parse(e.receipt.acceptedAt));
  const last = times[times.length - 1] ?? 0;
  rig.now = T0 - 60_000;
  const { buyer, seller } = rig.cast;
  const out = rig.relay.submit(eventOf('DealCreated', { deal_id: uuid(8), buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h('c'), deadline: iso(last + DAY) }, buyer, last, rig.tips.get(buyer.publicKey) ?? null));
  assert.ok(out.ok);
  const tail = rig.store.all().map((e) => Date.parse(e.receipt.acceptedAt));
  for (let i = 1; i < tail.length; i += 1) assert.ok((tail[i] ?? 0) >= (tail[i - 1] ?? 0));
});
