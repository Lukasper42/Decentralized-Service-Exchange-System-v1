import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionHash, approvalActionFor, recoveryCommitment, signApproval, signAttestation } from '../../crypto/src/index.js';
import { balanceOf } from '../../domain/src/accounting.js';
import { policyParamsHash } from '../../domain/src/policy.js';
import type { PolicyParams } from '../../domain/src/policy.js';
import type { Approval, Hash, PayloadMap } from '../../domain/src/protocol.js';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import type { Identity } from '../../testing/src/fixtures.js';
import { DAY, h, iso, newIdentity, uuid } from '../../testing/src/fixtures.js';
import { createJuryOracle, selectPool } from '../../domain/src/jury.js';
import { juryContextSource } from '../../domain/src/jury-draws.js';
import { replayLedger } from './relay.js';

function code(result: { ok: boolean; error?: { code: string } }): string {
  return result.ok ? 'OK' : (result.error?.code ?? 'UNKNOWN');
}

function setup(): RelayRig {
  const rig = new RelayRig();
  rig.bootstrap();
  for (const approver of rig.approvers) {
    rig.now += 1000;
    rig.must('AccountCreated', { pubkey: approver.publicKey, recovery_commitment: h('rc'), invite_ref: null }, approver);
  }
  return rig;
}

function approvalsFor(rig: RelayRig, source: Parameters<typeof approvalActionFor>[0], signers: readonly Identity[]): Approval[] {
  const hash = actionHash(approvalActionFor(source));
  return signers.map((s) => signApproval(hash, s.publicKey, s.privateKey));
}

function issuance(rig: RelayRig, overrides: Partial<PayloadMap['CurrencyIssued']> = {}, signers: readonly Identity[] = rig.approvers.slice(0, 2)): PayloadMap['CurrencyIssued'] {
  const fields = { recipient: rig.cast.outsider.publicKey, amount: 500, policy_id: 'rig-grant', basis_hash: h('basis'), grant_kind: 'beta-grant' as const, nonce: h('n1'), ...overrides };
  return { ...fields, approvals: approvalsFor(rig, { type: 'CurrencyIssued', payload: { ...fields, approvals: [] } }, signers) };
}

function spend(rig: RelayRig, overrides: Partial<PayloadMap['TreasurySpend']> = {}): PayloadMap['TreasurySpend'] {
  const fields = { recipient: rig.cast.outsider.publicKey, amount: 300, purpose_hash: h('purpose'), nonce: h('s1'), ...overrides };
  return { ...fields, approvals: approvalsFor(rig, { type: 'TreasurySpend', payload: { ...fields, approvals: [] } }, rig.approvers.slice(0, 2)) };
}

function approver(rig: RelayRig, index: number): Identity {
  const who = rig.approvers[index];
  assert.ok(who !== undefined);
  return who;
}

test('CurrencyIssued credits the recipient and rejects bad approvals, limits, policy ids, replays and unknown recipients', () => {
  const rig = setup();
  rig.now += 1000;
  rig.must('AccountCreated', { pubkey: rig.cast.outsider.publicKey, recovery_commitment: h('rc'), invite_ref: null }, rig.cast.outsider);
  const signer = approver(rig, 0);
  rig.now += 1000;
  rig.must('CurrencyIssued', issuance(rig), signer);
  assert.equal(balanceOf(rig.relay.state.accounting, rig.cast.outsider.publicKey), 500);

  assert.equal(code(rig.submit('CurrencyIssued', issuance(rig), signer)), 'REPLAY');
  assert.equal(code(rig.submit('CurrencyIssued', issuance(rig, { nonce: h('n2') }, rig.approvers.slice(0, 1)), signer)), 'LIMIT');
  assert.equal(code(rig.submit('CurrencyIssued', issuance(rig, { nonce: h('n3'), policy_id: 'other' }), signer)), 'POLICY');
  assert.equal(code(rig.submit('CurrencyIssued', issuance(rig, { nonce: h('n4'), amount: 1_000_001 }), signer)), 'LIMIT');
  assert.equal(code(rig.submit('CurrencyIssued', issuance(rig, { nonce: h('n5') }), rig.cast.buyer)), 'SIGNER_AUTHORITY');
  assert.equal(code(rig.submit('CurrencyIssued', issuance(rig, { nonce: h('n6'), recipient: newIdentity().publicKey }), signer)), 'STATE');
  assert.equal(balanceOf(rig.relay.state.accounting, rig.cast.outsider.publicKey), 500);
});

test('TreasurySpend moves coins out of the treasury and is limited by it', () => {
  const rig = setup();
  rig.now += 1000;
  rig.must('AccountCreated', { pubkey: rig.cast.outsider.publicKey, recovery_commitment: h('rc'), invite_ref: null }, rig.cast.outsider);
  const signer = approver(rig, 1);
  const treasuryBefore = rig.relay.state.accounting.treasury;
  rig.now += 1000;
  rig.must('TreasurySpend', spend(rig), signer);
  assert.equal(rig.relay.state.accounting.treasury, treasuryBefore - 300);
  assert.equal(balanceOf(rig.relay.state.accounting, rig.cast.outsider.publicKey), 300);
  assert.equal(code(rig.submit('TreasurySpend', spend(rig), signer)), 'REPLAY');
  assert.equal(code(rig.submit('TreasurySpend', spend(rig, { nonce: h('s2'), amount: 1_000_001 }), signer)), 'LIMIT');
});

test('a completed deal books funds, the burned fee and reputation; ReputationEvent adds the counterparty delta once', () => {
  const rig = setup();
  const { buyer, seller } = rig.cast;
  const dealId = rig.openDeal(1, 1000);
  rig.now += 1000;
  rig.must('DeliverableSubmitted', { deal_id: dealId, content_hash: h('content'), precheck_ref: null }, seller);
  rig.now += 1000;
  rig.must('DealAccepted', { deal_id: dealId, by: buyer.publicKey }, buyer);
  rig.now += 1000;
  rig.must('EscrowReleased', { deal_id: dealId, to: seller.publicKey, amount: 990 }, buyer);
  rig.now += 1000;
  rig.must('FeeBurned', { deal_id: dealId, amount: 10 }, buyer);

  const state = rig.relay.state;
  assert.equal(balanceOf(state.accounting, seller.publicKey), 1_000_000 + 990);
  assert.equal(balanceOf(state.accounting, buyer.publicKey), 1_000_000 - 1000);
  assert.equal(state.accounting.burned, 10);
  assert.equal(state.reputation.accounts[seller.publicKey]?.completedDeals, 1);
  assert.deepEqual(state.reputation.accounts[buyer.publicKey]?.counterparties, [seller.publicKey]);

  const rating = { account: buyer.publicKey, counterparty: seller.publicKey, deal_id: dealId, delta: 1 as const, reason_hash: h('r') };
  rig.now += 1000;
  rig.must('ReputationEvent', rating, buyer);
  assert.equal(rig.relay.state.reputation.accounts[seller.publicKey]?.rawSum, 1);
  assert.equal(code(rig.submit('ReputationEvent', rating, buyer)), 'DUPLICATE');
  assert.equal(code(rig.submit('ReputationEvent', { ...rating, deal_id: uuid(77) }, buyer)), 'STATE');
});

test('ReputationEvent needs a finished deal', () => {
  const rig = setup();
  const { buyer, seller } = rig.cast;
  const dealId = rig.openDeal(1, 1000);
  rig.now += 1000;
  assert.equal(code(rig.submit('ReputationEvent', { account: buyer.publicKey, counterparty: seller.publicKey, deal_id: dealId, delta: 1, reason_hash: h('r') }, buyer)), 'STATE');
});

test('a deal above the policy limit is rejected', () => {
  const rig = setup();
  const { buyer, seller } = rig.cast;
  rig.now += 1000;
  const result = rig.submit('DealCreated', { deal_id: uuid(5), buyer: buyer.publicKey, seller: seller.publicKey, amount: 1_000_001, criteria_hash: h('c'), deadline: iso(rig.now + DAY) }, buyer);
  assert.equal(code(result), 'LIMIT');
});

test('a deal needs registered buyer and seller; nothing is written for a rejected DealCreated', () => {
  const rig = setup();
  const { buyer, seller, outsider } = rig.cast;
  const tip = rig.relay.tipSequence;
  rig.now += 1000;
  const body = { buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h('c'), deadline: iso(rig.now + DAY) };
  const unknownSeller = rig.submit('DealCreated', { deal_id: uuid(6), ...body, seller: outsider.publicKey }, buyer);
  assert.equal(code(unknownSeller), 'STATE');
  const unknownBuyer = rig.submit('DealCreated', { deal_id: uuid(7), ...body, buyer: outsider.publicKey }, outsider);
  assert.equal(code(unknownBuyer), 'STATE');
  assert.equal(rig.relay.tipSequence, tip);
  assert.equal(code(rig.submit('DealCreated', { deal_id: uuid(8), ...body }, buyer)), 'OK');
});

test('invitations: only active inviters invite, expired invitations cannot be used', () => {
  const rig = setup();
  const inviter = rig.cast.extra[1];
  assert.ok(inviter !== undefined);
  rig.now += 1000;
  rig.must('AccountCreated', { pubkey: inviter.publicKey, recovery_commitment: h('rc'), invite_ref: null }, inviter);
  const guest = newIdentity();
  rig.now += 1000;
  const invited = rig.must('AccountInvited', { invitee: guest.publicKey, expires: iso(rig.now + 10_000) }, inviter);
  rig.now += 20_000;
  assert.equal(code(rig.createAccount(guest, invited.receipt.eventHash)), 'WINDOW');
  assert.equal(code(rig.submit('AccountInvited', { invitee: guest.publicKey, expires: iso(rig.now - 1) }, inviter)), 'WINDOW');
  assert.equal(code(rig.submit('AccountInvited', { invitee: rig.cast.buyer.publicKey, expires: iso(rig.now + DAY) }, inviter)), 'DUPLICATE');
});

test('PolicyUpdated registers a new version that replay reproduces, and a bad document is refused', () => {
  const rig = setup();
  const signer = approver(rig, 0);
  const next: PolicyParams = { ...rig.genesisPolicy(), version: 2, feeBp: 200 };
  const paramsHash: Hash = policyParamsHash(next);
  const fields = { policy_version: 2, params_hash: paramsHash, activation_sequence: 1000 };
  const payload = { ...fields, approvals: approvalsFor(rig, { type: 'PolicyUpdated', payload: { ...fields, approvals: [] } }, rig.approvers.slice(0, 2)) };

  rig.now += 1000;
  assert.equal(code(rig.submit('PolicyUpdated', payload, signer)), 'POLICY');
  rig.policyDocuments.set(paramsHash, next);
  rig.now += 1000;
  rig.must('PolicyUpdated', payload, signer);
  assert.equal(rig.relay.state.policy.entries.length, 2);
  assert.equal(code(rig.submit('PolicyUpdated', payload, signer)), 'REPLAY');

  const replay = replayLedger(rig.store.all(), rig.projector);
  assert.ok(replay.ok);
  if (replay.ok) assert.equal(replay.value.stateHash, rig.relay.stateHash);
});

test('replay of a ledger with issuance, a deal and a reputation event reproduces the state hash', () => {
  const rig = setup();
  rig.now += 1000;
  rig.must('AccountCreated', { pubkey: rig.cast.outsider.publicKey, recovery_commitment: h('rc'), invite_ref: null }, rig.cast.outsider);
  rig.now += 1000;
  rig.must('CurrencyIssued', issuance(rig), approver(rig, 0));
  rig.openDeal(1, 1000);
  const replay = replayLedger(rig.store.all(), rig.projector);
  assert.ok(replay.ok);
  if (replay.ok) assert.equal(replay.value.stateHash, rig.relay.stateHash);
});

test('a dispute freezes its jury pool, the beacon arrives ten receipts later, and only the drawn jury is accepted', () => {
  const rig = setup();
  const { buyer, seller, outsider } = rig.cast;
  for (const juror of [outsider, ...rig.cast.jurors]) {
    rig.now += 1000;
    rig.must('AccountCreated', { pubkey: juror.publicKey, recovery_commitment: h('rc'), invite_ref: null }, juror);
  }
  const dealId = rig.openDeal(1, 1000);
  rig.now += 1000;
  rig.must('DeliverableSubmitted', { deal_id: dealId, content_hash: h('content'), precheck_ref: null }, seller);
  rig.now += 1000;
  rig.must('DealRejected', { deal_id: dealId, by: buyer.publicKey, reason_hash: h('why') }, buyer);
  rig.now += 1000;
  const opened = rig.must('DisputeOpened', { deal_id: dealId, by: buyer.publicKey }, buyer);
  const trigger = opened.receipt.sequence;
  const draw = rig.relay.state.juryDraws[`${dealId}:0`];
  assert.ok(draw !== undefined);
  assert.equal(draw.triggerSequence, trigger);
  assert.equal(draw.beaconReceiptHash, null);
  assert.ok(!draw.candidates.some((c) => c.pubkey === buyer.publicKey || c.pubkey === seller.publicKey));

  const pick = (): readonly string[] => {
    const oracle = createJuryOracle(juryContextSource(rig.relay.state.juryDraws, () => []));
    const drawn = oracle.expectedJurors(dealId, 0);
    assert.ok(drawn.ok);
    return drawn.ok ? drawn.value : [];
  };
  const assign = (jurors: readonly string[]): string => code(rig.submit('JuryAssigned', { deal_id: dealId, jurors: [...jurors], appeal_round: 0 }, outsider));

  // Filler events up to the beacon sequence: the draw cannot be checked yet.
  let filler = 0;
  const addFiller = (): void => {
    rig.now += 1000;
    filler += 1;
    rig.must('DealCreated', { deal_id: uuid(500 + filler), buyer: buyer.publicKey, seller: seller.publicKey, amount: 10, criteria_hash: h(`f${filler}`), deadline: iso(rig.now + 30 * DAY) }, buyer);
  };
  while (rig.relay.tipSequence < trigger + 9) addFiller();
  const early = rig.cast.jurors.slice(0, 3).map((j) => j.publicKey);
  rig.now += 1000;
  assert.equal(assign(early), 'WINDOW');
  addFiller();
  assert.equal(rig.relay.tipSequence, trigger + 10);
  assert.equal(rig.relay.state.juryDraws[`${dealId}:0`]?.beaconReceiptHash, null);

  // The next accepted event carries the receipt hash of the beacon sequence.
  rig.now += 1000;
  rig.must('DealCreated', { deal_id: uuid(999), buyer: buyer.publicKey, seller: seller.publicKey, amount: 10, criteria_hash: h('last'), deadline: iso(rig.now + 30 * DAY) }, buyer);
  const beacon = rig.relay.state.juryDraws[`${dealId}:0`]?.beaconReceiptHash;
  assert.ok(typeof beacon === 'string');
  const beaconEntry = rig.store.all().find((e) => e.receipt.sequence === trigger + 11);
  assert.equal(beacon, beaconEntry?.receipt.previousReceiptHash);

  const drawn = pick();
  assert.equal(drawn.length, 3);
  assert.equal(assign([...drawn].reverse()), 'JURY_MISMATCH');
  rig.now += 1000;
  assert.equal(assign(drawn), 'OK');

  const replay = replayLedger(rig.store.all(), rig.projector);
  assert.ok(replay.ok);
  if (replay.ok) assert.equal(replay.value.stateHash, rig.relay.stateHash);
});

function rotation(rig: RelayRig, oldKey: Identity, next: Identity, recovery: Identity | undefined = rig.cast.extra[0]): PayloadMap['KeyRotated'] {
  assert.ok(recovery !== undefined);
  const body = { old_pubkey: oldKey.publicKey, new_pubkey: next.publicKey, new_recovery_commitment: recoveryCommitment(next.publicKey) };
  return { ...body, recovery_pubkey: recovery.publicKey, sig: signAttestation('key-rotation', body, recovery.privateKey) };
}

test('KeyRotated freezes the old key at once and the new key takes over after the delay, with everything moved', () => {
  const rig = setup();
  const { buyer, seller } = rig.cast;
  const dealId = rig.openDeal(1, 1000);
  const next = newIdentity();

  rig.now += 1000;
  rig.must('KeyRotated', rotation(rig, buyer, next), next);
  assert.equal(rig.relay.state.pendingRotations.length, 1);

  // Frozen: the old key can do nothing, a second rotation is refused, the new key is not an account yet.
  rig.now += 1000;
  assert.equal(code(rig.submit('DealCreated', { deal_id: uuid(50), buyer: buyer.publicKey, seller: seller.publicKey, amount: 10, criteria_hash: h('c'), deadline: iso(rig.now + DAY) }, buyer)), 'STATE');
  assert.equal(code(rig.submit('KeyRotated', rotation(rig, buyer, newIdentity()), newIdentity())), 'SIGNER_AUTHORITY');
  const rival = newIdentity();
  assert.equal(code(rig.submit('KeyRotated', rotation(rig, buyer, rival), rival)), 'DUPLICATE');
  assert.equal(balanceOf(rig.relay.state.accounting, buyer.publicKey), 1_000_000 - 1000);

  // After the delay the first event of the new key activates the rotation.
  rig.now += 3 * DAY;
  rig.must('DeliverableSubmitted', { deal_id: dealId, content_hash: h('content'), precheck_ref: null }, seller);
  const state = rig.relay.state;
  assert.equal(state.pendingRotations.length, 0);
  assert.equal(state.retiredKeys[buyer.publicKey], next.publicKey);
  assert.ok(state.accounts[next.publicKey] !== undefined);
  assert.ok(state.accounts[buyer.publicKey] === undefined);
  assert.equal(state.deals[dealId]?.buyer, next.publicKey);
  assert.equal(balanceOf(state.accounting, next.publicKey), 1_000_000 - 1000);
  assert.equal(balanceOf(state.accounting, buyer.publicKey), 0);
  assert.ok(state.reputation.accounts[next.publicKey] !== undefined);
  assert.deepEqual(state.reputation.accounts[seller.publicKey]?.counterparties, []);

  // The new key acts as the buyer; the retired key is dead for good.
  rig.now += 1000;
  rig.must('DealAccepted', { deal_id: dealId, by: next.publicKey }, next);
  assert.equal(code(rig.submit('DealAccepted', { deal_id: dealId, by: buyer.publicKey }, buyer)), 'STATE');
  assert.equal(code(rig.createAccount(buyer)), 'DUPLICATE');

  const replay = replayLedger(rig.store.all(), rig.projector);
  assert.ok(replay.ok);
  if (replay.ok) assert.equal(replay.value.stateHash, rig.relay.stateHash);
});

test('KeyRotated needs the recovery key, a valid signature and a non-governance account', () => {
  const rig = setup();
  const next = newIdentity();
  const wrongRecovery = rig.cast.extra[1];
  assert.ok(wrongRecovery !== undefined);
  rig.now += 1000;
  assert.equal(code(rig.submit('KeyRotated', rotation(rig, rig.cast.buyer, next, wrongRecovery), next)), 'SIGNER_AUTHORITY');
  const forged = { ...rotation(rig, rig.cast.buyer, next), new_recovery_commitment: h('other') };
  assert.equal(code(rig.submit('KeyRotated', forged, next)), 'ATTESTATION');
  assert.equal(code(rig.submit('KeyRotated', rotation(rig, newIdentity(), next), next)), 'STATE');
  const approver = rig.approvers[0];
  assert.ok(approver !== undefined);
  assert.equal(code(rig.submit('KeyRotated', rotation(rig, approver, next), next)), 'POLICY');
  assert.equal(rig.relay.state.pendingRotations.length, 0);
});

/** Dispute with a frozen pool and the beacon in place; returns what the jury tests need. */
function disputeWithBeacon(rig: RelayRig): { dealId: string; drawn: readonly string[]; oracle: ReturnType<typeof createJuryOracle> } {
  const { buyer, seller, outsider } = rig.cast;
  for (const juror of [outsider, ...rig.cast.jurors]) {
    rig.now += 1000;
    rig.must('AccountCreated', { pubkey: juror.publicKey, recovery_commitment: h('rc'), invite_ref: null }, juror);
  }
  const dealId = rig.openDeal(1, 1000);
  rig.now += 1000;
  rig.must('DeliverableSubmitted', { deal_id: dealId, content_hash: h('content'), precheck_ref: null }, seller);
  rig.now += 1000;
  rig.must('DealRejected', { deal_id: dealId, by: buyer.publicKey, reason_hash: h('why') }, buyer);
  rig.now += 1000;
  const opened = rig.must('DisputeOpened', { deal_id: dealId, by: buyer.publicKey }, buyer);
  for (let filler = 1; rig.relay.tipSequence < opened.receipt.sequence + 11; filler += 1) {
    rig.now += 1000;
    rig.must('DealCreated', { deal_id: uuid(600 + filler), buyer: buyer.publicKey, seller: seller.publicKey, amount: 10, criteria_hash: h(`f${filler}`), deadline: iso(rig.now + 30 * DAY) }, buyer);
  }
  const oracle = createJuryOracle(juryContextSource(rig.relay.state.juryDraws, (id, round) => (Object.hasOwn(rig.relay.state.deals, id) ? rig.relay.state.deals[id]?.seatedJurors ?? [] : []).filter(() => round === 0 || round === 1)));
  const drawn = oracle.expectedJurors(dealId, 0);
  assert.ok(drawn.ok);
  return { dealId, drawn: drawn.ok ? drawn.value : [], oracle };
}

test('JurorReplaced end to end: a juror who misses the window is replaced by the deterministic candidate and the dispute resolves', () => {
  const rig = setup();
  const { outsider } = rig.cast;
  const { dealId, drawn, oracle } = disputeWithBeacon(rig);
  rig.now += 1000;
  rig.must('JuryAssigned', { deal_id: dealId, jurors: [...drawn], appeal_round: 0 }, outsider);
  const identityOf = (pubkey: string): Identity => {
    const found = [outsider, ...rig.cast.jurors, ...rig.approvers].find((j) => j.publicKey === pubkey);
    assert.ok(found !== undefined);
    return found;
  };
  const vote = (juror: string, side: 'buyer' | 'seller'): string => {
    const who = identityOf(juror);
    const body = { deal_id: dealId, juror, vote: side, appeal_round: 0 };
    return code(rig.submit('JuryVoted', { ...body, sig: signAttestation('jury-vote', body, who.privateKey) } as never, who));
  };
  const [first, second, missing] = drawn;
  assert.ok(first !== undefined && second !== undefined && missing !== undefined);
  rig.now += 1000;
  assert.equal(vote(first, 'buyer'), 'OK');
  rig.now += 1000;
  assert.equal(vote(second, 'buyer'), 'OK');

  // Inside the window a replacement is refused; resolution is refused without a full quorum.
  const replacement = rig.relay.state.deals[dealId] === undefined ? null : oracle.expectedReplacement(dealId, 0, missing);
  assert.ok(replacement !== null && replacement.ok);
  const replacementKey = replacement.ok ? replacement.value : '';
  assert.equal(code(rig.submit('JurorReplaced', { deal_id: dealId, appeal_round: 0, missing_juror: missing, replacement: replacementKey }, outsider)), 'WINDOW');
  assert.equal(code(rig.submit('DisputeResolved', { deal_id: dealId, outcome: 'buyer', appeal_round: 0 }, outsider)), 'STATE');

  // After the window the deterministic candidate replaces the missing juror; anyone else is refused.
  rig.now += 3 * DAY + 1000;
  const wrong = rig.cast.jurors.map((j) => j.publicKey).find((k) => !drawn.includes(k) && k !== replacementKey);
  assert.ok(wrong !== undefined);
  assert.equal(code(rig.submit('JurorReplaced', { deal_id: dealId, appeal_round: 0, missing_juror: missing, replacement: wrong }, outsider)), 'JURY_MISMATCH');
  const replaced = rig.relay.state.deals[dealId];
  assert.ok(replaced !== undefined && replaced.jurors.includes(missing));
  rig.must('JurorReplaced', { deal_id: dealId, appeal_round: 0, missing_juror: missing, replacement: replacementKey }, outsider);
  const seated = rig.relay.state.deals[dealId];
  assert.ok(seated !== undefined && seated.jurors.includes(replacementKey) && !seated.jurors.includes(missing));

  // The replacement gets a fresh window and votes; the late juror can no longer vote; the dispute resolves.
  rig.now += 1000;
  assert.equal(vote(missing, 'seller'), 'JURY_MISMATCH');
  assert.equal(vote(replacementKey, 'buyer'), 'OK');
  rig.now += 1000;
  rig.must('DisputeResolved', { deal_id: dealId, outcome: 'buyer', appeal_round: 0 }, outsider);
  assert.equal(rig.relay.state.deals[dealId]?.status, 'resolved');

  const replay = replayLedger(rig.store.all(), rig.projector);
  assert.ok(replay.ok);
  if (replay.ok) assert.equal(replay.value.stateHash, rig.relay.stateHash);
});

class TieredRig extends RelayRig {
  static tiers: ReadonlyArray<{ minDeals: number; minCounterparties: number; minAccountAgeDays: number; requirePositiveBalance: boolean }> = [];
  override genesisPolicy(): PolicyParams {
    const params = super.genesisPolicy();
    return { ...params, jury: { ...params.jury, tiers: TieredRig.tiers } };
  }
}

test('fallback tiers: a strict tier without enough jurors falls back to the next tier, and without any fitting tier the draw fails with POLICY', () => {
  const strict = { minDeals: 20, minCounterparties: 5, minAccountAgeDays: 60, requirePositiveBalance: true };
  const lax = { minDeals: 0, minCounterparties: 0, minAccountAgeDays: 0, requirePositiveBalance: false };

  TieredRig.tiers = [strict, lax];
  const rig = new TieredRig();
  rig.bootstrap();
  for (const approver of rig.approvers) { rig.now += 1000; rig.must('AccountCreated', { pubkey: approver.publicKey, recovery_commitment: h('rc'), invite_ref: null }, approver); }
  const { dealId, drawn } = disputeWithBeacon(rig);
  assert.equal(drawn.length, 3);
  const context = juryContextSource(rig.relay.state.juryDraws, () => []).contextFor(dealId, 0);
  assert.ok(context.ok);
  const pool = context.ok ? selectPool(context.value, 0) : null;
  assert.ok(pool !== null && pool.ok);
  assert.equal(pool.ok ? pool.value.tierIndex : -1, 1, 'the second (fallback) tier was used');
  rig.now += 1000;
  rig.must('JuryAssigned', { deal_id: dealId, jurors: [...drawn], appeal_round: 0 }, rig.cast.outsider);

  TieredRig.tiers = [strict];
  const strictOnly = new TieredRig();
  strictOnly.bootstrap();
  for (const approver of strictOnly.approvers) { strictOnly.now += 1000; strictOnly.must('AccountCreated', { pubkey: approver.publicKey, recovery_commitment: h('rc'), invite_ref: null }, approver); }
  for (const juror of [strictOnly.cast.outsider, ...strictOnly.cast.jurors]) { strictOnly.now += 1000; strictOnly.must('AccountCreated', { pubkey: juror.publicKey, recovery_commitment: h('rc'), invite_ref: null }, juror); }
  const strictDeal = strictOnly.openDeal(1, 1000);
  strictOnly.now += 1000;
  strictOnly.must('DeliverableSubmitted', { deal_id: strictDeal, content_hash: h('content'), precheck_ref: null }, strictOnly.cast.seller);
  strictOnly.now += 1000;
  strictOnly.must('DealRejected', { deal_id: strictDeal, by: strictOnly.cast.buyer.publicKey, reason_hash: h('why') }, strictOnly.cast.buyer);
  strictOnly.now += 1000;
  const strictOpened = strictOnly.must('DisputeOpened', { deal_id: strictDeal, by: strictOnly.cast.buyer.publicKey }, strictOnly.cast.buyer);
  for (let filler = 1; strictOnly.relay.tipSequence < strictOpened.receipt.sequence + 11; filler += 1) {
    strictOnly.now += 1000;
    strictOnly.must('DealCreated', { deal_id: uuid(700 + filler), buyer: strictOnly.cast.buyer.publicKey, seller: strictOnly.cast.seller.publicKey, amount: 10, criteria_hash: h(`s${filler}`), deadline: iso(strictOnly.now + 30 * DAY) }, strictOnly.cast.buyer);
  }
  const failing = createJuryOracle(juryContextSource(strictOnly.relay.state.juryDraws, () => [])).expectedJurors(strictDeal, 0);
  assert.ok(!failing.ok && failing.error.code === 'POLICY');
  TieredRig.tiers = [];
});
