import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAttestation } from '../../crypto/src/index.js';
import { DAY, T0, eventOf, h, iso, newCast, uuid } from '../../testing/src/fixtures.js';
import type { Cast, Identity } from '../../testing/src/fixtures.js';
import { applyDealEvent } from './deal-machine.js';
import type { DealState, TransitionResult } from './deal-machine.js';
import type { DealContext, DealPolicyView, Movement } from './ports.js';
import type { ErrorCode, EventType, PayloadMap, Pubkey } from './protocol.js';
import { err, ok } from './protocol.js';
import type { Result } from './protocol.js';

const E = 1000;
const FEE = 10;
const APPEAL_FEE = 100;
const DEAL = uuid(7);

class Harness {
  readonly cast: Cast = newCast();
  state: DealState | undefined;
  readonly movements: Movement[] = [];
  readonly balances = new Map<Pubkey, number>();
  effectiveCheckers = new Set<Pubkey>();
  jurorPayout = 10;
  round0: Identity[]; round1: Identity[];
  replacements = new Map<Pubkey, Pubkey>();
  juryOverride: Result<readonly Pubkey[]> | null = null;
  lastError: { code: ErrorCode; path: string } | null = null;
  constructor() {
    this.round0 = this.cast.jurors.slice(0, 3);
    this.round1 = this.cast.jurors.slice(3, 8);
    this.balances.set(this.cast.buyer.publicKey, 5000);
    this.balances.set(this.cast.seller.publicKey, 5000);
  }
  get buyer(): Identity { return this.cast.buyer; }
  get seller(): Identity { return this.cast.seller; }
  get outsider(): Identity { return this.cast.outsider; }
  ctx(): DealContext {
    const policy: DealPolicyView = {
      feeBp: 100, appealFeeBp: 1000, autoAcceptWindowMs: 7 * DAY, disputeWindowMs: 7 * DAY, appealWindowMs: 3 * DAY, voteWindowMs: 3 * DAY, jurorPayoutAmount: this.jurorPayout,
      isEffectiveChecker: (key) => this.effectiveCheckers.has(key),
    };
    return {
      policy,
      funds: { spendable: (account) => this.balances.get(account) ?? 0 },
      jury: {
        expectedJurors: (_deal, round) => this.juryOverride ?? ok((round === 0 ? this.round0 : this.round1).map((j) => j.publicKey)),
        expectedReplacement: (_deal, _round, missing) => { const r = this.replacements.get(missing); return r === undefined ? err('POLICY', 'pool too small', 'jury') : ok(r); },
      },
    };
  }
  /** Apply an event at acceptedAt = T0 + atMs (the claimed timestamp is deliberately unrelated). */
  try<T extends EventType>(type: T, payload: PayloadMap[T], signer: Identity, atMs: number, claimedMs: number = T0): TransitionResult {
    const event = eventOf(type, payload, signer, claimedMs);
    const result = applyDealEvent(this.state, event as never, { sequence: 1, acceptedAt: iso(T0 + atMs) }, this.ctx());
    return result;
  }
  /** Apply and require success, committing state and movements. */
  do<T extends EventType>(type: T, payload: PayloadMap[T], signer: Identity, atMs: number): DealState {
    const result = this.try(type, payload, signer, atMs);
    if (!result.ok) throw new Error(`${type} rejected: ${result.error.code} ${result.error.message}`);
    this.state = result.value.state;
    this.movements.push(...result.value.movements);
    return result.value.state;
  }
  fail<T extends EventType>(type: T, payload: PayloadMap[T], signer: Identity, atMs: number, expected: ErrorCode): void {
    const result = this.try(type, payload, signer, atMs);
    assert.equal(result.ok, false, `${type} should be rejected with ${expected}`);
    if (!result.ok) { assert.equal(result.error.code, expected, `${type}: ${result.error.message}`); assert.ok(result.error.path.length > 0); }
  }
  // ---- lifecycle helpers (times are offsets from T0) ----
  create(deadlineMs = 30 * DAY): void {
    this.do('DealCreated', { deal_id: DEAL, buyer: this.buyer.publicKey, seller: this.seller.publicKey, amount: E, criteria_hash: h('criteria'), deadline: iso(T0 + deadlineMs) }, this.buyer, 0);
  }
  consentPayload(): PayloadMap['DealConsented'] {
    const s = this.state;
    if (s === undefined) throw new Error('no deal');
    const body = { deal_id: s.dealId, buyer: s.buyer, seller: s.seller, amount: s.amount, criteria_hash: s.criteriaHash, deadline: s.deadline };
    return { deal_id: DEAL, seller: this.seller.publicKey, consent_sig: signAttestation('deal-consent', body, this.seller.privateKey) };
  }
  consent(at = 1000): void { this.do('DealConsented', this.consentPayload(), this.seller, at); }
  fund(at = 2000): void { this.do('EscrowFunded', { deal_id: DEAL, from: this.buyer.publicKey, amount: E }, this.buyer, at); }
  deliver(at = 3000): void { this.do('DeliverableSubmitted', { deal_id: DEAL, content_hash: h('content'), precheck_ref: null }, this.seller, at); }
  toDelivered(): void { this.create(); this.consent(); this.fund(); this.deliver(); }
  accept(at = 4000): void { this.do('DealAccepted', { deal_id: DEAL, by: this.buyer.publicKey }, this.buyer, at); }
  reject(at = 4000): void { this.do('DealRejected', { deal_id: DEAL, by: this.buyer.publicKey, reason_hash: h('reason') }, this.buyer, at); }
  dispute(at = 5000): void { this.do('DisputeOpened', { deal_id: DEAL, by: this.seller.publicKey }, this.seller, at); }
  assign(round: 0 | 1, at: number): void {
    const jurors = (round === 0 ? this.round0 : this.round1).map((j) => j.publicKey);
    this.do('JuryAssigned', { deal_id: DEAL, jurors, appeal_round: round }, this.outsider, at);
  }
  vote(juror: Identity, vote: 'buyer' | 'seller', round: 0 | 1, at: number): void {
    const sig = signAttestation('jury-vote', { deal_id: DEAL, juror: juror.publicKey, vote, appeal_round: round }, juror.privateKey);
    this.do('JuryVoted', { deal_id: DEAL, juror: juror.publicKey, vote, appeal_round: round, sig }, juror, at);
  }
  /** Round-0 dispute fully decided at time `at`; returns the resolution time. */
  decideRound0(outcome: 'buyer' | 'seller', at = 7000): number {
    this.toDelivered(); this.reject(); this.dispute(); this.assign(0, 6000);
    this.round0.forEach((j, i) => this.vote(j, i === 0 ? (outcome === 'buyer' ? 'seller' : 'buyer') : outcome, 0, 6500 + i));
    this.do('DisputeResolved', { deal_id: DEAL, outcome, appeal_round: 0 }, this.outsider, at);
    return at;
  }
  sellerRelease(at: number): void { this.do('EscrowReleased', { deal_id: DEAL, to: this.seller.publicKey, amount: E - FEE }, this.outsider, at); }
  refund(at: number): void { this.do('EscrowReleased', { deal_id: DEAL, to: this.buyer.publicKey, amount: E }, this.outsider, at); }
  burn(signer: Identity, at: number): void { this.do('FeeBurned', { deal_id: DEAL, amount: FEE }, signer, at); }
  appeal(by: Identity, at: number): void { this.do('AppealOpened', { deal_id: DEAL, by: by.publicKey, fee_amount: APPEAL_FEE }, by, at); }
  sum(kinds: Movement['kind'][]): number { return this.movements.filter((m) => kinds.includes(m.kind)).reduce((total, m) => total + m.amount, 0); }
}

test('A16: events that are not deal events, or have no deal, return distinct STATE errors; duplicates return DUPLICATE', () => {
  const h1 = new Harness();
  h1.fail('DealAccepted', { deal_id: DEAL, by: h1.buyer.publicKey }, h1.buyer, 0, 'STATE');
  const missing = h1.try('DealAccepted', { by: h1.buyer.publicKey } as never, h1.buyer, 0);
  assert.equal(!missing.ok && missing.error.code, 'STATE');
  const missingPath = h1.try('DealAccepted', { by: h1.buyer.publicKey } as never, h1.buyer, 0);
  assert.equal(!missingPath.ok && missingPath.error.path, 'payload.deal_id');
  h1.fail('TreasurySpend', { recipient: h1.buyer.publicKey, amount: 5, purpose_hash: h('p'), nonce: h('n'), approvals: [] }, h1.buyer, 0, 'STATE');
  h1.create();
  h1.fail('DealCreated', { deal_id: DEAL, buyer: h1.buyer.publicKey, seller: h1.seller.publicKey, amount: E, criteria_hash: h('criteria'), deadline: iso(T0 + 30 * DAY) }, h1.buyer, 0, 'DUPLICATE');
  const fresh = new Harness();
  fresh.fail('DealCreated', { deal_id: DEAL, buyer: fresh.buyer.publicKey, seller: fresh.seller.publicKey, amount: E, criteria_hash: h('c'), deadline: iso(T0 + DAY) }, fresh.seller, 0, 'SIGNER_AUTHORITY');
  fresh.fail('DealCreated', { deal_id: DEAL, buyer: fresh.buyer.publicKey, seller: fresh.seller.publicKey, amount: 1, criteria_hash: h('c'), deadline: iso(T0 + DAY) }, fresh.buyer, 0, 'AMOUNT');
  fresh.fail('DealCreated', { deal_id: DEAL, buyer: fresh.buyer.publicKey, seller: fresh.seller.publicKey, amount: E, criteria_hash: h('c'), deadline: iso(T0) }, fresh.buyer, 0, 'WINDOW');
  const bad = applyDealEvent(undefined, eventOf('DealCreated', { deal_id: DEAL, buyer: fresh.buyer.publicKey, seller: fresh.seller.publicKey, amount: E, criteria_hash: h('c'), deadline: iso(T0 + DAY) }, fresh.buyer, T0) as never, { sequence: 1, acceptedAt: 'yesterday' }, fresh.ctx());
  assert.equal(!bad.ok && bad.error.code, 'TIMESTAMP');
});

test('A16: specific codes — ATTESTATION, INSUFFICIENT_FUNDS, AMOUNT, SIGNER_AUTHORITY, WINDOW, POLICY, JURY_MISMATCH', () => {
  const m = new Harness();
  m.create();
  m.fail('DealConsented', { ...m.consentPayload(), consent_sig: signAttestation('deal-consent', { other: 1 }, m.seller.privateKey) }, m.seller, 1000, 'ATTESTATION');
  m.fail('DealConsented', m.consentPayload(), m.outsider, 1000, 'SIGNER_AUTHORITY');
  m.consent();
  m.balances.set(m.buyer.publicKey, E - 1);
  m.fail('EscrowFunded', { deal_id: DEAL, from: m.buyer.publicKey, amount: E }, m.buyer, 2000, 'INSUFFICIENT_FUNDS');
  m.balances.set(m.buyer.publicKey, 5000);
  m.fail('EscrowFunded', { deal_id: DEAL, from: m.buyer.publicKey, amount: E - 1 }, m.buyer, 2000, 'AMOUNT');
  m.fail('EscrowFunded', { deal_id: DEAL, from: m.buyer.publicKey, amount: E }, m.seller, 2000, 'SIGNER_AUTHORITY');
  m.fail('EscrowFunded', { deal_id: DEAL, from: m.buyer.publicKey, amount: E }, m.buyer, 30 * DAY, 'WINDOW');
  m.fund();
  m.fail('EscrowFunded', { deal_id: DEAL, from: m.buyer.publicKey, amount: E }, m.buyer, 2500, 'DUPLICATE');
  m.fail('DealExpired', { deal_id: DEAL, by: m.buyer.publicKey }, m.buyer, 31 * DAY, 'STATE');
  const j = new Harness();
  j.toDelivered(); j.reject(); j.dispute();
  j.juryOverride = err('POLICY', 'eligible pool too small', 'jury');
  j.fail('JuryAssigned', { deal_id: DEAL, jurors: j.round0.map((x) => x.publicKey), appeal_round: 0 }, j.outsider, 6000, 'POLICY');
  j.juryOverride = err('WINDOW', 'beacon receipt not yet available', 'jury');
  j.fail('JuryAssigned', { deal_id: DEAL, jurors: j.round0.map((x) => x.publicKey), appeal_round: 0 }, j.outsider, 6000, 'WINDOW');
  j.juryOverride = null;
  j.fail('JuryAssigned', { deal_id: DEAL, jurors: j.round0.map((x) => x.publicKey).reverse(), appeal_round: 0 }, j.outsider, 6000, 'JURY_MISMATCH');
});

function atDelivered(): Harness { const m = new Harness(); m.toDelivered(); return m; }
function atDisputed(): Harness { const m = atDelivered(); m.reject(); m.dispute(); return m; }

test('A3: only the deal seller may submit the deliverable', () => {
  const m = new Harness();
  m.create(); m.consent(); m.fund();
  const payload = { deal_id: DEAL, content_hash: h('content'), precheck_ref: null };
  m.fail('DeliverableSubmitted', payload, m.outsider, 3000, 'SIGNER_AUTHORITY');
  m.fail('DeliverableSubmitted', payload, m.buyer, 3000, 'SIGNER_AUTHORITY');
  assert.equal(m.state?.status, 'escrowed');
  m.deliver();
  assert.equal(m.state?.status, 'delivered');
  m.fail('DeliverableSubmitted', payload, m.seller, 3500, 'DUPLICATE');
});

test('A4/E12: precheck must reference the delivered content; unlisted checkers are recorded but ineffective', () => {
  const m = new Harness();
  m.create(); m.consent(); m.fund();
  const checker = m.cast.checker;
  const precheck = (hash: string, signer: Identity = checker) => ({ deal_id: DEAL, content_hash: hash, result: 'pass' as const, checker_id: checker.publicKey, sig: signAttestation('precheck', { deal_id: DEAL, content_hash: hash, result: 'pass', checker_id: checker.publicKey }, signer.privateKey) });
  m.fail('PrecheckCompleted', precheck(h('content')), checker, 2500, 'STATE');
  m.deliver();
  m.fail('PrecheckCompleted', precheck(h('older')), checker, 3500, 'STATE');
  m.fail('PrecheckCompleted', precheck(h('content')), m.outsider, 3500, 'SIGNER_AUTHORITY');
  m.do('PrecheckCompleted', precheck(h('content')), checker, 3500);
  assert.equal(m.state?.status, 'delivered');
  assert.equal(m.state?.prechecks[0]?.effective, false);
  m.effectiveCheckers.add(checker.publicKey);
  m.do('PrecheckCompleted', precheck(h('content')), checker, 3600);
  assert.equal(m.state?.prechecks[1]?.effective, true);
  assert.equal(m.movements.length, 1, 'prechecks never move funds');
  m.accept();
  m.fail('PrecheckCompleted', precheck(h('content')), checker, 4500, 'STATE');
});

test('A5/E4: seller settlement is E-F then FeeBurned(F) by the same signer; wrong amounts, signers and duplicates are rejected', () => {
  const m = atDelivered(); m.accept();
  const to = m.seller.publicKey;
  m.fail('EscrowReleased', { deal_id: DEAL, to, amount: 1 }, m.outsider, 5000, 'AMOUNT');
  m.fail('EscrowReleased', { deal_id: DEAL, to, amount: E }, m.outsider, 5000, 'AMOUNT');
  m.fail('EscrowReleased', { deal_id: DEAL, to, amount: E - FEE + 1 }, m.outsider, 5000, 'AMOUNT');
  m.fail('EscrowReleased', { deal_id: DEAL, to: m.buyer.publicKey, amount: E - FEE }, m.outsider, 5000, 'STATE');
  m.fail('FeeBurned', { deal_id: DEAL, amount: FEE }, m.outsider, 5000, 'STATE');
  m.sellerRelease(5000);
  assert.equal(m.state?.status, 'release_pending_fee');
  m.fail('EscrowReleased', { deal_id: DEAL, to, amount: E - FEE }, m.outsider, 5001, 'DUPLICATE');
  m.fail('FeeBurned', { deal_id: DEAL, amount: FEE }, m.buyer, 5001, 'SIGNER_AUTHORITY');
  m.fail('FeeBurned', { deal_id: DEAL, amount: FEE + 1 }, m.outsider, 5001, 'AMOUNT');
  m.fail('FeeBurned', { deal_id: DEAL, amount: FEE - 1 }, m.outsider, 5001, 'AMOUNT');
  m.burn(m.outsider, 5001);
  assert.equal(m.state?.status, 'completed');
  m.fail('FeeBurned', { deal_id: DEAL, amount: FEE }, m.outsider, 5002, 'DUPLICATE');
  m.fail('EscrowReleased', { deal_id: DEAL, to, amount: E - FEE }, m.outsider, 5002, 'DUPLICATE');
  assert.equal(m.sum(['escrow_release_to_seller', 'fee_burn']), E);
  assert.deepEqual(m.movements.map((x) => x.kind), ['escrow_lock', 'escrow_release_to_seller', 'fee_burn']);
});

test('A5: a refund to the buyer after a dispute is fee-free and terminal', () => {
  const m = new Harness();
  const at = m.decideRound0('buyer');
  const wait = at + 3 * DAY + 1;
  m.fail('EscrowReleased', { deal_id: DEAL, to: m.buyer.publicKey, amount: E - FEE }, m.outsider, wait, 'AMOUNT');
  m.fail('EscrowReleased', { deal_id: DEAL, to: m.seller.publicKey, amount: E - FEE }, m.outsider, wait, 'STATE');
  m.refund(wait);
  assert.equal(m.state?.status, 'refunded');
  m.fail('FeeBurned', { deal_id: DEAL, amount: FEE }, m.outsider, wait + 1, 'STATE');
  assert.equal(m.sum(['escrow_refund_to_buyer']), E);
  assert.equal(m.movements.some((x) => x.kind === 'fee_burn'), false);
});

test('A6: deadlines use receipt.acceptedAt, never the signer-claimed timestamp', () => {
  const D = 10 * DAY;
  const m = new Harness();
  m.create(D); m.consent();
  m.fail('EscrowFunded', { deal_id: DEAL, from: m.buyer.publicKey, amount: E }, m.buyer, D, 'WINDOW');
  // claimed timestamp is long before the deadline, but the receipt is at the deadline
  assert.equal(m.try('EscrowFunded', { deal_id: DEAL, from: m.buyer.publicKey, amount: E }, m.buyer, D, T0 + 1).ok, false);
  m.fund(D - 1);
  m.fail('DeliverableSubmitted', { deal_id: DEAL, content_hash: h('content'), precheck_ref: null }, m.seller, D, 'WINDOW');
  const refund = { deal_id: DEAL, to: m.buyer.publicKey, amount: E };
  // claimed timestamp equals the deadline while the receipt is earlier: must still be rejected
  const early = m.try('EscrowReleased', refund, m.outsider, D - 1, T0 + D);
  assert.equal(!early.ok && early.error.code, 'WINDOW');
  // claimed timestamp is early but the receipt is at the deadline: accepted
  const late = m.try('EscrowReleased', refund, m.outsider, D, T0);
  assert.equal(late.ok, true);
  const expired = new Harness();
  expired.create(D);
  const tooEarly = expired.try('DealExpired', { deal_id: DEAL, by: expired.buyer.publicKey }, expired.buyer, D - 1, T0 + D + DAY);
  assert.equal(!tooEarly.ok && tooEarly.error.code, 'WINDOW');
  assert.equal(expired.try('DealExpired', { deal_id: DEAL, by: expired.buyer.publicKey }, expired.buyer, D, T0).ok, true);
});

test('E5: auto-accept only strictly after 7 days; accept and reject are allowed through the boundary', () => {
  const delivered = 3000;
  const boundary = delivered + 7 * DAY;
  const a = atDelivered();
  a.fail('DealAutoAccepted', { deal_id: DEAL, by: a.seller.publicKey }, a.seller, boundary, 'WINDOW');
  a.fail('DealAutoAccepted', { deal_id: DEAL, by: a.seller.publicKey }, a.buyer, boundary + 1, 'SIGNER_AUTHORITY');
  a.do('DealAutoAccepted', { deal_id: DEAL, by: a.seller.publicKey }, a.seller, boundary + 1);
  assert.equal(a.state?.status, 'accepted');
  a.fail('DealAutoAccepted', { deal_id: DEAL, by: a.seller.publicKey }, a.seller, boundary + 2, 'DUPLICATE');
  a.sellerRelease(boundary + 2);
  const onBoundary = atDelivered(); onBoundary.accept(boundary);
  assert.equal(onBoundary.state?.status, 'accepted');
  const rejectBoundary = atDelivered(); rejectBoundary.reject(boundary);
  assert.equal(rejectBoundary.state?.status, 'rejected');
  const late = atDelivered();
  late.fail('DealAccepted', { deal_id: DEAL, by: late.buyer.publicKey }, late.buyer, boundary + 1, 'WINDOW');
  late.fail('DealRejected', { deal_id: DEAL, by: late.buyer.publicKey, reason_hash: h('r') }, late.buyer, boundary + 1, 'WINDOW');
  late.fail('DealAccepted', { deal_id: DEAL, by: late.buyer.publicKey }, late.seller, 4000, 'SIGNER_AUTHORITY');
  const rejected = atDelivered(); rejected.reject();
  rejected.fail('DealAutoAccepted', { deal_id: DEAL, by: rejected.seller.publicKey }, rejected.seller, boundary + 1, 'STATE');
});

test('E6: disputes only after rejection and through 7 days; without a dispute the buyer is refunded after the window', () => {
  const rejectedAt = 4000;
  const boundary = rejectedAt + 7 * DAY;
  const ok1 = atDelivered(); ok1.reject();
  ok1.fail('DisputeOpened', { deal_id: DEAL, by: ok1.outsider.publicKey }, ok1.outsider, 5000, 'SIGNER_AUTHORITY');
  ok1.fail('DisputeOpened', { deal_id: DEAL, by: ok1.buyer.publicKey }, ok1.seller, 5000, 'SIGNER_AUTHORITY');
  ok1.do('DisputeOpened', { deal_id: DEAL, by: ok1.buyer.publicKey }, ok1.buyer, boundary);
  assert.equal(ok1.state?.status, 'disputed');
  const late = atDelivered(); late.reject();
  late.fail('DisputeOpened', { deal_id: DEAL, by: late.buyer.publicKey }, late.buyer, boundary + 1, 'WINDOW');
  late.fail('EscrowReleased', { deal_id: DEAL, to: late.buyer.publicKey, amount: E }, late.outsider, boundary, 'WINDOW');
  late.refund(boundary + 1);
  assert.equal(late.state?.status, 'refunded');
  const none = atDelivered();
  none.fail('DisputeOpened', { deal_id: DEAL, by: none.buyer.publicKey }, none.buyer, 5000, 'STATE');
  none.accept();
  none.fail('DisputeOpened', { deal_id: DEAL, by: none.buyer.publicKey }, none.buyer, 5000, 'STATE');
});

test('E17: expiry only without escrow; funding and delivery respect state order', () => {
  const D = 10 * DAY;
  const m = new Harness();
  m.create(D);
  m.fail('EscrowFunded', { deal_id: DEAL, from: m.buyer.publicKey, amount: E }, m.buyer, 1000, 'STATE');
  m.fail('DeliverableSubmitted', { deal_id: DEAL, content_hash: h('c'), precheck_ref: null }, m.seller, 1000, 'STATE');
  m.fail('DealExpired', { deal_id: DEAL, by: m.buyer.publicKey }, m.buyer, D - 1, 'WINDOW');
  m.fail('DealExpired', { deal_id: DEAL, by: m.outsider.publicKey }, m.outsider, D, 'SIGNER_AUTHORITY');
  m.fail('DealExpired', { deal_id: DEAL, by: m.seller.publicKey }, m.buyer, D, 'SIGNER_AUTHORITY');
  m.consent();
  m.do('DealExpired', { deal_id: DEAL, by: m.seller.publicKey }, m.seller, D);
  assert.equal(m.state?.status, 'expired');
  assert.deepEqual(m.movements, []);
  m.fail('DealConsented', m.consentPayload(), m.seller, D + 1, 'STATE');
  m.fail('EscrowReleased', { deal_id: DEAL, to: m.buyer.publicKey, amount: E }, m.outsider, D + 1, 'STATE');
  m.fail('DealExpired', { deal_id: DEAL, by: m.buyer.publicKey }, m.buyer, D + 1, 'DUPLICATE');
  const funded = new Harness();
  funded.create(D); funded.consent(); funded.fund();
  funded.fail('DealExpired', { deal_id: DEAL, by: funded.buyer.publicKey }, funded.buyer, D, 'STATE');
});

test('A7: after round 0 release waits for the appeal window; only the loser appeals once, with the exact fee', () => {
  const m = new Harness();
  const at = m.decideRound0('seller');
  const boundary = at + 3 * DAY;
  m.fail('EscrowReleased', { deal_id: DEAL, to: m.seller.publicKey, amount: E - FEE }, m.outsider, at + 1, 'WINDOW');
  m.fail('EscrowReleased', { deal_id: DEAL, to: m.seller.publicKey, amount: E - FEE }, m.outsider, boundary, 'WINDOW');
  m.fail('AppealOpened', { deal_id: DEAL, by: m.seller.publicKey, fee_amount: APPEAL_FEE }, m.seller, at + 1, 'SIGNER_AUTHORITY');
  m.fail('AppealOpened', { deal_id: DEAL, by: m.outsider.publicKey, fee_amount: APPEAL_FEE }, m.outsider, at + 1, 'SIGNER_AUTHORITY');
  m.fail('AppealOpened', { deal_id: DEAL, by: m.buyer.publicKey, fee_amount: APPEAL_FEE - 1 }, m.buyer, at + 1, 'AMOUNT');
  m.fail('AppealOpened', { deal_id: DEAL, by: m.buyer.publicKey, fee_amount: E }, m.buyer, at + 1, 'AMOUNT');
  m.fail('AppealOpened', { deal_id: DEAL, by: m.buyer.publicKey, fee_amount: APPEAL_FEE }, m.buyer, boundary + 1, 'WINDOW');
  m.balances.set(m.buyer.publicKey, APPEAL_FEE - 1);
  m.fail('AppealOpened', { deal_id: DEAL, by: m.buyer.publicKey, fee_amount: APPEAL_FEE }, m.buyer, boundary, 'INSUFFICIENT_FUNDS');
  m.balances.set(m.buyer.publicKey, 5000);
  m.appeal(m.buyer, boundary);
  assert.equal(m.state?.status, 'appealed');
  assert.deepEqual(m.movements[m.movements.length - 1], { kind: 'appeal_escrow_lock', dealId: DEAL, from: m.buyer.publicKey, amount: APPEAL_FEE });
  m.fail('AppealOpened', { deal_id: DEAL, by: m.buyer.publicKey, fee_amount: APPEAL_FEE }, m.buyer, boundary + 1, 'DUPLICATE');
  m.fail('EscrowReleased', { deal_id: DEAL, to: m.seller.publicKey, amount: E - FEE }, m.outsider, boundary + 10 * DAY, 'STATE');
  const quiet = new Harness();
  const t2 = quiet.decideRound0('seller');
  quiet.sellerRelease(t2 + 3 * DAY + 1);
  assert.equal(quiet.state?.status, 'release_pending_fee');
});

function appealFlow(round1Outcome: 'buyer' | 'seller'): Harness {
  const m = new Harness();
  const at = m.decideRound0('seller');
  m.appeal(m.buyer, at + 1000);
  m.assign(1, at + 2000);
  m.round1.forEach((j, i) => m.vote(j, round1Outcome, 1, at + 3000 + i));
  m.do('DisputeResolved', { deal_id: DEAL, outcome: round1Outcome, appeal_round: 1 }, m.outsider, at + 4000);
  return m;
}

test('A7/E8: round 1 is final; the appeal fee is returned iff the outcome changed, otherwise burned; release follows', () => {
  const changed = appealFlow('buyer');
  const t = 7000 + 4000;
  assert.equal(changed.state?.status, 'resolved_final');
  changed.fail('EscrowReleased', { deal_id: DEAL, to: changed.buyer.publicKey, amount: E }, changed.outsider, t + 1, 'STATE');
  changed.fail('AppealFeeSettled', { deal_id: DEAL, outcome: 'burned', amount: APPEAL_FEE }, changed.outsider, t + 1, 'STATE');
  changed.fail('AppealFeeSettled', { deal_id: DEAL, outcome: 'returned', amount: APPEAL_FEE + 1 }, changed.outsider, t + 1, 'AMOUNT');
  changed.do('AppealFeeSettled', { deal_id: DEAL, outcome: 'returned', amount: APPEAL_FEE }, changed.outsider, t + 1);
  assert.deepEqual(changed.movements[changed.movements.length - 1], { kind: 'appeal_fee_return', dealId: DEAL, to: changed.buyer.publicKey, amount: APPEAL_FEE });
  changed.fail('AppealFeeSettled', { deal_id: DEAL, outcome: 'returned', amount: APPEAL_FEE }, changed.outsider, t + 2, 'DUPLICATE');
  changed.refund(t + 3);
  assert.equal(changed.state?.status, 'refunded');
  assert.equal(changed.sum(['escrow_lock']), E);
  assert.equal(changed.sum(['escrow_refund_to_buyer']), E);
  assert.equal(changed.sum(['appeal_escrow_lock']), changed.sum(['appeal_fee_return', 'appeal_fee_burn']));

  const unchanged = appealFlow('seller');
  unchanged.fail('AppealFeeSettled', { deal_id: DEAL, outcome: 'returned', amount: APPEAL_FEE }, unchanged.outsider, t + 1, 'STATE');
  unchanged.do('AppealFeeSettled', { deal_id: DEAL, outcome: 'burned', amount: APPEAL_FEE }, unchanged.outsider, t + 1);
  assert.deepEqual(unchanged.movements[unchanged.movements.length - 1], { kind: 'appeal_fee_burn', dealId: DEAL, amount: APPEAL_FEE });
  unchanged.sellerRelease(t + 2);
  unchanged.burn(unchanged.outsider, t + 3);
  assert.equal(unchanged.state?.status, 'completed');
  assert.equal(unchanged.sum(['escrow_release_to_seller', 'fee_burn']), E);
});

test('A8: a party can never be a juror, even when the oracle agrees; jurors are unique and round 1 is disjoint', () => {
  const m = atDisputed();
  m.juryOverride = ok([m.buyer.publicKey, ...m.round0.slice(1).map((j) => j.publicKey)]);
  m.fail('JuryAssigned', { deal_id: DEAL, jurors: [m.buyer.publicKey, ...m.round0.slice(1).map((j) => j.publicKey)], appeal_round: 0 }, m.outsider, 6000, 'JURY_MISMATCH');
  const sellerJuror = [m.seller.publicKey, ...m.round0.slice(1).map((j) => j.publicKey)];
  m.juryOverride = ok(sellerJuror);
  m.fail('JuryAssigned', { deal_id: DEAL, jurors: sellerJuror, appeal_round: 0 }, m.outsider, 6000, 'JURY_MISMATCH');
  const dup = [m.round0[0]!.publicKey, m.round0[0]!.publicKey, m.round0[1]!.publicKey];
  m.juryOverride = ok(dup);
  m.fail('JuryAssigned', { deal_id: DEAL, jurors: dup, appeal_round: 0 }, m.outsider, 6000, 'JURY_MISMATCH');
  m.juryOverride = null;
  m.fail('JuryAssigned', { deal_id: DEAL, jurors: m.round1.map((j) => j.publicKey), appeal_round: 1 }, m.outsider, 6000, 'STATE');
  m.fail('JuryAssigned', { deal_id: DEAL, jurors: m.round1.slice(0, 3).map((j) => j.publicKey), appeal_round: 0 }, m.outsider, 6000, 'JURY_MISMATCH');
  m.assign(0, 6000);
  m.fail('JuryAssigned', { deal_id: DEAL, jurors: m.round0.map((j) => j.publicKey), appeal_round: 0 }, m.outsider, 6001, 'DUPLICATE');

  const r1 = new Harness();
  const at = r1.decideRound0('seller');
  r1.appeal(r1.buyer, at + 1);
  r1.round1 = [r1.round0[0]!, ...r1.round1.slice(1)];
  r1.fail('JuryAssigned', { deal_id: DEAL, jurors: r1.round1.map((j) => j.publicKey), appeal_round: 1 }, r1.outsider, at + 2, 'JURY_MISMATCH');
});

test('A8: votes need an assigned juror, the juror as signer, one vote each and the 3-day window; quorum is full and unambiguous', () => {
  const m = atDisputed(); m.assign(0, 6000);
  const [j0, j1, j2] = m.round0 as [Identity, Identity, Identity];
  const sigFor = (juror: Identity, vote: 'buyer' | 'seller') => signAttestation('jury-vote', { deal_id: DEAL, juror: juror.publicKey, vote, appeal_round: 0 }, juror.privateKey);
  m.fail('JuryVoted', { deal_id: DEAL, juror: m.outsider.publicKey, vote: 'buyer', appeal_round: 0, sig: sigFor(m.outsider, 'buyer') }, m.outsider, 6100, 'JURY_MISMATCH');
  m.fail('JuryVoted', { deal_id: DEAL, juror: m.buyer.publicKey, vote: 'buyer', appeal_round: 0, sig: sigFor(m.buyer, 'buyer') }, m.buyer, 6100, 'JURY_MISMATCH');
  m.fail('JuryVoted', { deal_id: DEAL, juror: j0.publicKey, vote: 'buyer', appeal_round: 0, sig: sigFor(j0, 'buyer') }, j1, 6100, 'SIGNER_AUTHORITY');
  m.fail('JuryVoted', { deal_id: DEAL, juror: j0.publicKey, vote: 'buyer', appeal_round: 1, sig: sigFor(j0, 'buyer') }, j0, 6100, 'STATE');
  m.vote(j0, 'buyer', 0, 6100);
  m.fail('JuryVoted', { deal_id: DEAL, juror: j0.publicKey, vote: 'seller', appeal_round: 0, sig: sigFor(j0, 'seller') }, j0, 6200, 'DUPLICATE');
  m.vote(j1, 'seller', 0, 6000 + 3 * DAY);
  m.fail('JuryVoted', { deal_id: DEAL, juror: j2.publicKey, vote: 'buyer', appeal_round: 0, sig: sigFor(j2, 'buyer') }, j2, 6000 + 3 * DAY + 1, 'WINDOW');
  m.fail('DisputeResolved', { deal_id: DEAL, outcome: 'buyer', appeal_round: 0 }, m.outsider, 6300, 'STATE');
  // replacement of the silent juror after the window
  const replacement = m.cast.jurors[9]!;
  m.fail('JurorReplaced', { deal_id: DEAL, appeal_round: 0, missing_juror: j2.publicKey, replacement: replacement.publicKey }, m.outsider, 6000 + 3 * DAY, 'WINDOW');
  m.fail('JurorReplaced', { deal_id: DEAL, appeal_round: 0, missing_juror: j2.publicKey, replacement: replacement.publicKey }, m.outsider, 6000 + 3 * DAY + 1, 'POLICY');
  m.replacements.set(j2.publicKey, replacement.publicKey);
  m.fail('JurorReplaced', { deal_id: DEAL, appeal_round: 0, missing_juror: j0.publicKey, replacement: replacement.publicKey }, m.outsider, 6000 + 3 * DAY + 1, 'STATE');
  m.fail('JurorReplaced', { deal_id: DEAL, appeal_round: 0, missing_juror: m.outsider.publicKey, replacement: replacement.publicKey }, m.outsider, 6000 + 3 * DAY + 1, 'JURY_MISMATCH');
  m.fail('JurorReplaced', { deal_id: DEAL, appeal_round: 0, missing_juror: j2.publicKey, replacement: m.buyer.publicKey }, m.outsider, 6000 + 3 * DAY + 1, 'JURY_MISMATCH');
  m.fail('JurorReplaced', { deal_id: DEAL, appeal_round: 0, missing_juror: j2.publicKey, replacement: j0.publicKey }, m.outsider, 6000 + 3 * DAY + 1, 'JURY_MISMATCH');
  m.fail('JurorReplaced', { deal_id: DEAL, appeal_round: 0, missing_juror: j2.publicKey, replacement: m.cast.jurors[10]!.publicKey }, m.outsider, 6000 + 3 * DAY + 1, 'JURY_MISMATCH');
  const replacedAt = 6000 + 3 * DAY + 1;
  m.do('JurorReplaced', { deal_id: DEAL, appeal_round: 0, missing_juror: j2.publicKey, replacement: replacement.publicKey }, m.outsider, replacedAt);
  m.fail('JuryVoted', { deal_id: DEAL, juror: j2.publicKey, vote: 'buyer', appeal_round: 0, sig: sigFor(j2, 'buyer') }, j2, replacedAt + 1, 'JURY_MISMATCH');
  m.vote(replacement, 'buyer', 0, replacedAt + 3 * DAY);
  m.fail('DisputeResolved', { deal_id: DEAL, outcome: 'seller', appeal_round: 0 }, m.outsider, replacedAt + 3 * DAY + 1, 'JURY_MISMATCH');
  m.fail('DisputeResolved', { deal_id: DEAL, outcome: 'buyer', appeal_round: 1 }, m.outsider, replacedAt + 3 * DAY + 1, 'STATE');
  m.do('DisputeResolved', { deal_id: DEAL, outcome: 'buyer', appeal_round: 0 }, m.outsider, replacedAt + 3 * DAY + 1);
  assert.equal(m.state?.status, 'resolved');
  m.fail('DisputeResolved', { deal_id: DEAL, outcome: 'buyer', appeal_round: 0 }, m.outsider, replacedAt + 3 * DAY + 2, 'DUPLICATE');
});

test('E17: every terminal state is reachable and the emitted movements sum to the original escrow', () => {
  const completed = atDelivered(); completed.accept(); completed.sellerRelease(5000); completed.burn(completed.outsider, 5001);
  assert.equal(completed.state?.status, 'completed');
  assert.equal(completed.sum(['escrow_lock']), E);
  assert.equal(completed.sum(['escrow_release_to_seller', 'fee_burn']), E);

  const autoAccepted = atDelivered(); autoAccepted.do('DealAutoAccepted', { deal_id: DEAL, by: autoAccepted.seller.publicKey }, autoAccepted.seller, 3000 + 7 * DAY + 1);
  autoAccepted.sellerRelease(3000 + 7 * DAY + 2); autoAccepted.burn(autoAccepted.outsider, 3000 + 7 * DAY + 3);
  assert.equal(autoAccepted.state?.status, 'completed');

  const deadlineRefund = new Harness(); deadlineRefund.create(10 * DAY); deadlineRefund.consent(); deadlineRefund.fund(); deadlineRefund.refund(10 * DAY);
  assert.equal(deadlineRefund.state?.status, 'refunded');
  assert.equal(deadlineRefund.sum(['escrow_refund_to_buyer']), E);

  const rejectedRefund = atDelivered(); rejectedRefund.reject(); rejectedRefund.refund(4000 + 7 * DAY + 1);
  assert.equal(rejectedRefund.sum(['escrow_refund_to_buyer']), E);

  const disputeRefund = new Harness(); const at = disputeRefund.decideRound0('buyer'); disputeRefund.refund(at + 3 * DAY + 1);
  assert.equal(disputeRefund.state?.status, 'refunded');
  assert.equal(disputeRefund.sum(['escrow_refund_to_buyer']), E);

  const disputeSeller = new Harness(); const at2 = disputeSeller.decideRound0('seller'); disputeSeller.sellerRelease(at2 + 3 * DAY + 1); disputeSeller.burn(disputeSeller.outsider, at2 + 3 * DAY + 2);
  assert.equal(disputeSeller.state?.status, 'completed');
  assert.equal(disputeSeller.sum(['escrow_release_to_seller', 'fee_burn']), E);

  const expired = new Harness(); expired.create(10 * DAY); expired.do('DealExpired', { deal_id: DEAL, by: expired.buyer.publicKey }, expired.buyer, 10 * DAY);
  assert.equal(expired.state?.status, 'expired');
  assert.equal(expired.movements.length, 0);
});

test('E11: EvidenceRevealed — deal parties only, once per kind, never in an expired deal', () => {
  const m = new Harness(); m.create(10 * DAY);
  const salt = h('salt');
  m.fail('EvidenceRevealed', { deal_id: DEAL, by: m.outsider.publicKey, kind: 'criteria', salt }, m.outsider, 100, 'SIGNER_AUTHORITY');
  m.fail('EvidenceRevealed', { deal_id: DEAL, by: m.seller.publicKey, kind: 'criteria', salt }, m.buyer, 100, 'SIGNER_AUTHORITY');
  m.do('EvidenceRevealed', { deal_id: DEAL, by: m.buyer.publicKey, kind: 'criteria', salt }, m.buyer, 100);
  m.fail('EvidenceRevealed', { deal_id: DEAL, by: m.buyer.publicKey, kind: 'criteria', salt }, m.buyer, 101, 'DUPLICATE');
  m.do('EvidenceRevealed', { deal_id: DEAL, by: m.seller.publicKey, kind: 'criteria', salt }, m.seller, 102);
  m.do('EvidenceRevealed', { deal_id: DEAL, by: m.buyer.publicKey, kind: 'reason', salt }, m.buyer, 103);
  assert.equal(m.state?.status, 'created');
  m.do('DealExpired', { deal_id: DEAL, by: m.buyer.publicKey }, m.buyer, 10 * DAY);
  m.fail('EvidenceRevealed', { deal_id: DEAL, by: m.buyer.publicKey, kind: 'purpose', salt }, m.buyer, 10 * DAY + 1, 'STATE');
});

function payoutsOf(m: Harness): Extract<Movement, { kind: 'juror_payout' }>[] {
  return m.movements.filter((x): x is Extract<Movement, { kind: 'juror_payout' }> => x.kind === 'juror_payout');
}

test('juror pay: DisputeResolved in round 0 pays the three jurors in roster order', () => {
  const m = new Harness();
  m.decideRound0('seller');
  assert.deepEqual(payoutsOf(m), m.round0.map((j) => ({ kind: 'juror_payout', dealId: DEAL, to: j.publicKey, amount: 10 })));
});

test('juror pay: the appeal round pays its five jurors as well', () => {
  const m = appealFlow('buyer');
  const payouts = payoutsOf(m);
  assert.equal(payouts.length, 8);
  assert.deepEqual(payouts.slice(3).map((x) => x.to), m.round1.map((j) => j.publicKey));
  assert.ok(payouts.every((x) => x.amount === 10 && x.dealId === DEAL));
});

test('juror pay: a payout amount of 0 emits no payout movements', () => {
  const m = new Harness();
  m.jurorPayout = 0;
  m.decideRound0('seller');
  assert.equal(payoutsOf(m).length, 0);
});

test('juror pay: a replaced juror who never voted is not paid, the replacement is', () => {
  const m = new Harness();
  m.toDelivered(); m.reject(); m.dispute(); m.assign(0, 6000);
  const [j0, j1, j2] = m.round0 as [Identity, Identity, Identity];
  const replacement = m.cast.jurors[9]!;
  m.vote(j0, 'buyer', 0, 6100);
  m.vote(j1, 'buyer', 0, 6200);
  m.replacements.set(j2.publicKey, replacement.publicKey);
  const replacedAt = 6000 + 3 * DAY + 1;
  m.do('JurorReplaced', { deal_id: DEAL, appeal_round: 0, missing_juror: j2.publicKey, replacement: replacement.publicKey }, m.outsider, replacedAt);
  m.vote(replacement, 'buyer', 0, replacedAt + 1000);
  m.do('DisputeResolved', { deal_id: DEAL, outcome: 'buyer', appeal_round: 0 }, m.outsider, replacedAt + 2000);
  assert.deepEqual(payoutsOf(m).map((x) => x.to), [j0.publicKey, j1.publicKey, replacement.publicKey]);
});

test('juror pay: a rejected DisputeResolved (no full quorum) emits no movements', () => {
  const m = new Harness();
  m.toDelivered(); m.reject(); m.dispute(); m.assign(0, 6000);
  m.vote(m.round0[0]!, 'buyer', 0, 6100);
  const result = m.try('DisputeResolved', { deal_id: DEAL, outcome: 'buyer', appeal_round: 0 }, m.outsider, 6300);
  assert.equal(result.ok, false);
  assert.equal(payoutsOf(m).length, 0);
});
