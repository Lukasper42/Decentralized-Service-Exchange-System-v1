import type { DomainError, ErrorCode, Hash, IsoUtc, Pubkey, SignedEvent } from './protocol.js';
import { AMOUNT_MAX, AMOUNT_MIN } from './protocol.js';
import type { DealContext, Movement, ReceiptMeta } from './ports.js';
import { appealFee, fee } from './amount.js';
import { verifyAttestation } from '../../crypto/src/index.js';

export type { DealContext, Movement, ReceiptMeta } from './ports.js';

export type DealStatus =
  | 'created' | 'consented' | 'escrowed' | 'delivered' | 'accepted' | 'rejected' | 'disputed' | 'resolved'
  | 'appealed' | 'resolved_final' | 'release_pending_fee' | 'completed' | 'refunded' | 'expired';
export type Side = 'buyer' | 'seller';

export interface PrecheckRecord { checker: Pubkey; contentHash: Hash; result: 'pass' | 'fail' | 'inconclusive'; effective: boolean }
export interface ReleaseRecord { signer: Pubkey; to: Pubkey; amount: number; fee: number }
export interface DealState {
  readonly dealId: string;
  readonly status: DealStatus;
  readonly buyer: Pubkey;
  readonly seller: Pubkey;
  /** Agreed amount E. */
  readonly amount: number;
  readonly criteriaHash: Hash;
  readonly deadline: IsoUtc;
  /** Escrowed amount; 0 until EscrowFunded. */
  readonly escrowAmount: number;
  readonly latestContentHash: Hash | null;
  readonly deliveredAt: IsoUtc | null;
  readonly rejectedAt: IsoUtc | null;
  readonly prechecks: readonly PrecheckRecord[];
  readonly appealRound: 0 | 1;
  /** Current roster of the active round, in assignment order, after replacements. */
  readonly jurors: readonly Pubkey[];
  /** Every juror ever seated in round 0 (including replaced ones). */
  readonly round0Jurors: readonly Pubkey[];
  /** Every juror ever seated in the active round (including replaced ones); replacements must be new. */
  readonly seatedJurors: readonly Pubkey[];
  /** Vote deadline per current juror (acceptedAt-based, inclusive). */
  readonly voteDeadlines: Readonly<Record<string, IsoUtc>>;
  readonly votes: Readonly<Record<string, Side>>;
  readonly round0Outcome: Side | null;
  readonly round0ResolvedAt: IsoUtc | null;
  readonly finalOutcome: Side | null;
  readonly appellant: Pubkey | null;
  readonly appealFeeAmount: number | null;
  readonly appealFeeSettled: boolean;
  readonly release: ReleaseRecord | null;
  readonly feeBurned: boolean;
  readonly reveals: readonly { by: Pubkey; kind: string }[];
}

export type TransitionResult =
  | { ok: true; value: { state: DealState; movements: readonly Movement[] } }
  | { ok: false; error: DomainError };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function rejection(code: ErrorCode, message: string, path: string): TransitionResult { return { ok: false, error: { code, message, path } }; }
function accept(state: DealState, movements: readonly Movement[] = []): TransitionResult { return { ok: true, value: { state, movements } }; }
function parseTime(iso: string): number | null {
  if (!ISO.test(iso)) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso ? ms : null;
}
function other(state: DealState, juror: Pubkey): boolean { return juror !== state.buyer && juror !== state.seller; }
function loserOf(winner: Side): Side { return winner === 'buyer' ? 'seller' : 'buyer'; }

/** Apply one structurally valid event (L1) to a deal projection, with every time rule on receipt.acceptedAt. */
export function applyDealEvent(state: DealState | undefined, event: SignedEvent, receipt: ReceiptMeta, ctx: DealContext): TransitionResult {
  const t = parseTime(receipt.acceptedAt);
  if (t === null) return rejection('TIMESTAMP', 'Receipt acceptedAt is not a valid IsoUtc value', 'receipt.acceptedAt');
  switch (event.type) {
    case 'AccountCreated': case 'AccountInvited': case 'KeyRotated': case 'ReputationEvent':
    case 'TreasurySpend': case 'CurrencyIssued': case 'RelayKeyRotated': case 'PolicyUpdated':
      return rejection('STATE', `${event.type} is not a deal event`, 'type');
    case 'DealCreated': return createDeal(state, event, t);
    case 'DealConsented': case 'EscrowFunded': case 'DeliverableSubmitted': case 'PrecheckCompleted': case 'DealAccepted':
    case 'DealRejected': case 'DealAutoAccepted': case 'DealExpired': case 'DisputeOpened': case 'JuryAssigned': case 'JuryVoted':
    case 'JurorReplaced': case 'DisputeResolved': case 'AppealOpened': case 'AppealFeeSettled': case 'EscrowReleased':
    case 'FeeBurned': case 'EvidenceRevealed': {
      const dealId = event.payload.deal_id;
      if (typeof dealId !== 'string') return rejection('STATE', 'Event has no deal_id', 'payload.deal_id');
      if (state === undefined || state.dealId !== dealId) return rejection('STATE', 'Deal does not exist', 'payload.deal_id');
      return transition(state, event, receipt, t, ctx);
    }
    default: { const _x: never = event; return _x; }
  }
}

function createDeal(state: DealState | undefined, event: Extract<SignedEvent, { type: 'DealCreated' }>, t: number): TransitionResult {
  const p = event.payload;
  if (state !== undefined) return rejection('DUPLICATE', 'Deal already exists', 'payload.deal_id');
  if (event.signer !== p.buyer) return rejection('SIGNER_AUTHORITY', 'DealCreated must be signed by the buyer', 'signer');
  if (p.buyer === p.seller) return rejection('PAYLOAD', 'Buyer and seller must differ', 'payload.seller');
  if (!Number.isSafeInteger(p.amount) || p.amount < AMOUNT_MIN || p.amount > AMOUNT_MAX) return rejection('AMOUNT', 'Amount out of range', 'payload.amount');
  const deadline = parseTime(p.deadline);
  if (deadline === null || deadline <= t) return rejection('WINDOW', 'Deadline must be later than acceptedAt', 'payload.deadline');
  return accept({
    dealId: p.deal_id, status: 'created', buyer: p.buyer, seller: p.seller, amount: p.amount, criteriaHash: p.criteria_hash,
    deadline: p.deadline, escrowAmount: 0, latestContentHash: null, deliveredAt: null, rejectedAt: null, prechecks: [],
    appealRound: 0, jurors: [], round0Jurors: [], seatedJurors: [], voteDeadlines: {}, votes: {}, round0Outcome: null,
    round0ResolvedAt: null, finalOutcome: null, appellant: null, appealFeeAmount: null, appealFeeSettled: false,
    release: null, feeBurned: false, reveals: [],
  });
}

type DealEvent = Exclude<SignedEvent, { type: 'AccountCreated' | 'AccountInvited' | 'KeyRotated' | 'ReputationEvent' | 'TreasurySpend' | 'CurrencyIssued' | 'RelayKeyRotated' | 'PolicyUpdated' | 'DealCreated' }>;

function transition(state: DealState, event: DealEvent, receipt: ReceiptMeta, t: number, ctx: DealContext): TransitionResult {
  const policy = ctx.policy;
  const deadline = parseTime(state.deadline);
  if (deadline === null) return rejection('STATE', 'Stored deadline is invalid', 'state.deadline');
  const deliveredAt = state.deliveredAt === null ? null : parseTime(state.deliveredAt);
  const rejectedAt = state.rejectedAt === null ? null : parseTime(state.rejectedAt);
  const resolvedAt0 = state.round0ResolvedAt === null ? null : parseTime(state.round0ResolvedAt);
  const next = (patch: Partial<DealState>): DealState => ({ ...state, ...patch });

  switch (event.type) {
    case 'DealConsented': {
      const p = event.payload;
      if (state.status !== 'created') return rejection(state.status === 'consented' ? 'DUPLICATE' : 'STATE', 'DealConsented requires status created', 'payload.deal_id');
      if (event.signer !== state.seller || p.seller !== state.seller) return rejection('SIGNER_AUTHORITY', 'DealConsented must be signed by the seller', 'signer');
      const body = { deal_id: state.dealId, buyer: state.buyer, seller: state.seller, amount: state.amount, criteria_hash: state.criteriaHash, deadline: state.deadline };
      if (!verifyAttestation('deal-consent', body, p.consent_sig, state.seller)) return rejection('ATTESTATION', 'Invalid deal-consent attestation', 'payload.consent_sig');
      return accept(next({ status: 'consented' }));
    }
    case 'DealExpired': {
      const p = event.payload;
      if (state.status !== 'created' && state.status !== 'consented') return rejection(state.status === 'expired' ? 'DUPLICATE' : 'STATE', 'DealExpired requires an unfunded deal', 'payload.deal_id');
      if ((event.signer !== state.buyer && event.signer !== state.seller) || p.by !== event.signer) return rejection('SIGNER_AUTHORITY', 'DealExpired must be signed by a party with by=signer', 'signer');
      if (t < deadline) return rejection('WINDOW', 'Deal has not reached its deadline', 'receipt.acceptedAt');
      return accept(next({ status: 'expired' }));
    }
    case 'EscrowFunded': {
      const p = event.payload;
      if (state.status !== 'consented') return rejection(state.escrowAmount > 0 ? 'DUPLICATE' : 'STATE', 'EscrowFunded requires status consented', 'payload.deal_id');
      if (event.signer !== state.buyer || p.from !== state.buyer) return rejection('SIGNER_AUTHORITY', 'EscrowFunded must be signed by the buyer', 'signer');
      if (p.amount !== state.amount) return rejection('AMOUNT', 'Escrow amount must equal the deal amount', 'payload.amount');
      if (t >= deadline) return rejection('WINDOW', 'EscrowFunded requires acceptedAt < deadline', 'receipt.acceptedAt');
      if (ctx.funds.spendable(state.buyer) < state.amount) return rejection('INSUFFICIENT_FUNDS', 'Buyer cannot cover the escrow', 'payload.amount');
      return accept(next({ status: 'escrowed', escrowAmount: state.amount }), [{ kind: 'escrow_lock', dealId: state.dealId, from: state.buyer, amount: state.amount }]);
    }
    case 'DeliverableSubmitted': {
      const p = event.payload;
      if (state.status !== 'escrowed') return rejection(state.deliveredAt !== null ? 'DUPLICATE' : 'STATE', 'DeliverableSubmitted requires status escrowed', 'payload.deal_id');
      // A3: only the deal's seller may deliver.
      if (event.signer !== state.seller) return rejection('SIGNER_AUTHORITY', 'DeliverableSubmitted must be signed by the seller', 'signer');
      if (t >= deadline) return rejection('WINDOW', 'DeliverableSubmitted requires acceptedAt < deadline', 'receipt.acceptedAt');
      return accept(next({ status: 'delivered', latestContentHash: p.content_hash, deliveredAt: receipt.acceptedAt }));
    }
    case 'PrecheckCompleted': {
      const p = event.payload;
      if (state.status !== 'delivered') return rejection('STATE', 'PrecheckCompleted requires status delivered', 'payload.deal_id');
      if (event.signer !== p.checker_id) return rejection('SIGNER_AUTHORITY', 'PrecheckCompleted must be signed by checker_id', 'signer');
      // A4: bound to the latest submitted content.
      if (p.content_hash !== state.latestContentHash) return rejection('STATE', 'Precheck does not reference the latest submitted content_hash', 'payload.content_hash');
      const record: PrecheckRecord = { checker: p.checker_id, contentHash: p.content_hash, result: p.result, effective: policy.isEffectiveChecker(p.checker_id) };
      return accept(next({ prechecks: [...state.prechecks, record] }));
    }
    case 'DealAccepted': case 'DealRejected': {
      const p = event.payload;
      if (state.status !== 'delivered' || deliveredAt === null) return rejection(state.status === 'accepted' || state.status === 'rejected' ? 'DUPLICATE' : 'STATE', `${event.type} requires status delivered`, 'payload.deal_id');
      if (event.signer !== state.buyer || p.by !== state.buyer) return rejection('SIGNER_AUTHORITY', `${event.type} must be signed by the buyer`, 'signer');
      if (t > deliveredAt + policy.autoAcceptWindowMs) return rejection('WINDOW', 'Decision window after delivery has closed', 'receipt.acceptedAt');
      return event.type === 'DealAccepted' ? accept(next({ status: 'accepted' })) : accept(next({ status: 'rejected', rejectedAt: receipt.acceptedAt }));
    }
    case 'DealAutoAccepted': {
      const p = event.payload;
      if (state.status !== 'delivered' || deliveredAt === null) return rejection(state.status === 'accepted' ? 'DUPLICATE' : 'STATE', 'DealAutoAccepted requires status delivered', 'payload.deal_id');
      if (event.signer !== state.seller || p.by !== state.seller) return rejection('SIGNER_AUTHORITY', 'DealAutoAccepted must be signed by the seller', 'signer');
      if (t <= deliveredAt + policy.autoAcceptWindowMs) return rejection('WINDOW', 'Auto-accept requires acceptedAt strictly after 7 days from delivery', 'receipt.acceptedAt');
      return accept(next({ status: 'accepted' }));
    }
    case 'DisputeOpened': {
      const p = event.payload;
      if (state.status !== 'rejected' || rejectedAt === null) return rejection(state.status === 'disputed' ? 'DUPLICATE' : 'STATE', 'DisputeOpened requires status rejected', 'payload.deal_id');
      if ((event.signer !== state.buyer && event.signer !== state.seller) || p.by !== event.signer) return rejection('SIGNER_AUTHORITY', 'DisputeOpened must be signed by a party with by=signer', 'signer');
      if (t > rejectedAt + policy.disputeWindowMs) return rejection('WINDOW', 'Dispute window after rejection has closed', 'receipt.acceptedAt');
      return accept(next({ status: 'disputed', appealRound: 0 }));
    }
    case 'JuryAssigned': return assignJury(state, event, t, ctx);
    case 'JuryVoted': {
      const p = event.payload;
      const active = state.status === 'disputed' || state.status === 'appealed';
      if (!active) return rejection('STATE', 'JuryVoted requires an active jury round', 'payload.deal_id');
      if (p.appeal_round !== state.appealRound) return rejection('STATE', 'Vote is for a different round', 'payload.appeal_round');
      if (event.signer !== p.juror) return rejection('SIGNER_AUTHORITY', 'JuryVoted must be signed by the juror', 'signer');
      if (!state.jurors.includes(p.juror)) return rejection('JURY_MISMATCH', 'Voter is not an assigned juror', 'payload.juror');
      if (Object.hasOwn(state.votes, p.juror)) return rejection('DUPLICATE', 'Juror has already voted', 'payload.juror');
      const jurorDeadline = state.voteDeadlines[p.juror];
      const jurorDeadlineMs = jurorDeadline === undefined ? null : parseTime(jurorDeadline);
      if (jurorDeadlineMs === null) return rejection('STATE', 'No vote deadline recorded for juror', 'payload.juror');
      if (t > jurorDeadlineMs) return rejection('WINDOW', 'Vote window has closed', 'receipt.acceptedAt');
      return accept(next({ votes: { ...state.votes, [p.juror]: p.vote } }));
    }
    case 'JurorReplaced': {
      const p = event.payload;
      const active = state.status === 'disputed' || state.status === 'appealed';
      if (!active) return rejection('STATE', 'JurorReplaced requires an active jury round', 'payload.deal_id');
      if (p.appeal_round !== state.appealRound) return rejection('STATE', 'Replacement is for a different round', 'payload.appeal_round');
      if (!state.jurors.includes(p.missing_juror)) return rejection('JURY_MISMATCH', 'Missing juror is not on the roster', 'payload.missing_juror');
      if (Object.hasOwn(state.votes, p.missing_juror)) return rejection('STATE', 'Juror has already voted', 'payload.missing_juror');
      const missingDeadline = state.voteDeadlines[p.missing_juror];
      const missingDeadlineMs = missingDeadline === undefined ? null : parseTime(missingDeadline);
      if (missingDeadlineMs === null) return rejection('STATE', 'No vote deadline recorded for juror', 'payload.missing_juror');
      if (t <= missingDeadlineMs) return rejection('WINDOW', 'Replacement is only allowed after the vote window', 'receipt.acceptedAt');
      if (!other(state, p.replacement) || state.seatedJurors.includes(p.replacement) || (state.appealRound === 1 && state.round0Jurors.includes(p.replacement))) {
        return rejection('JURY_MISMATCH', 'Replacement is a party, already seated, or a round-0 juror', 'payload.replacement');
      }
      const expected = ctx.jury.expectedReplacement(state.dealId, state.appealRound, p.missing_juror);
      if (!expected.ok) return { ok: false, error: expected.error };
      if (expected.value !== p.replacement) return rejection('JURY_MISMATCH', 'Replacement differs from the deterministic candidate', 'payload.replacement');
      const roster = state.jurors.map((j) => (j === p.missing_juror ? p.replacement : j));
      const { [p.missing_juror]: _removed, ...remainingDeadlines } = state.voteDeadlines;
      // SPEC-GAP: the spec gives no vote window for a replacement juror. Conservative choice: a fresh window of
      // voteWindowMs starting at the JurorReplaced acceptedAt (otherwise a replacement could never vote).
      return accept(next({
        jurors: roster, seatedJurors: [...state.seatedJurors, p.replacement],
        round0Jurors: state.appealRound === 0 ? [...state.round0Jurors, p.replacement] : state.round0Jurors,
        voteDeadlines: { ...remainingDeadlines, [p.replacement]: new Date(t + policy.voteWindowMs).toISOString() },
      }));
    }
    case 'DisputeResolved': {
      const p = event.payload;
      const active = state.status === 'disputed' || state.status === 'appealed';
      if (!active) return rejection(state.status === 'resolved' || state.status === 'resolved_final' ? 'DUPLICATE' : 'STATE', 'DisputeResolved requires an active jury round', 'payload.deal_id');
      if (p.appeal_round !== state.appealRound) return rejection('STATE', 'Resolution is for a different round', 'payload.appeal_round');
      const required = state.appealRound === 0 ? 3 : 5;
      if (state.jurors.length !== required || state.jurors.some((j) => !Object.hasOwn(state.votes, j))) return rejection('STATE', 'Full quorum of votes is required', 'payload.deal_id');
      const buyerVotes = state.jurors.filter((j) => state.votes[j] === 'buyer').length;
      const outcome: Side = buyerVotes > required - buyerVotes ? 'buyer' : 'seller';
      if (p.outcome !== outcome) return rejection('JURY_MISMATCH', 'Outcome does not match the votes', 'payload.outcome');
      // Fixed per-case juror pay (roster order). Every roster juror has voted (full quorum); replaced non-voters are not on the roster.
      const payouts: Movement[] = policy.jurorPayoutAmount > 0
        ? state.jurors.map((juror): Movement => ({ kind: 'juror_payout', dealId: state.dealId, to: juror, amount: policy.jurorPayoutAmount }))
        : [];
      return state.appealRound === 0
        ? accept(next({ status: 'resolved', round0Outcome: outcome, round0ResolvedAt: receipt.acceptedAt }), payouts)
        : accept(next({ status: 'resolved_final', finalOutcome: outcome }), payouts);
    }
    case 'AppealOpened': {
      const p = event.payload;
      if (state.status !== 'resolved' || state.round0Outcome === null || resolvedAt0 === null) return rejection(state.appellant !== null ? 'DUPLICATE' : 'STATE', 'AppealOpened requires status resolved', 'payload.deal_id');
      const underdog = loserOf(state.round0Outcome) === 'buyer' ? state.buyer : state.seller;
      if (event.signer !== underdog || p.by !== underdog) return rejection('SIGNER_AUTHORITY', 'Only the round-0 loser may appeal', 'signer');
      if (t > resolvedAt0 + policy.appealWindowMs) return rejection('WINDOW', 'Appeal window has closed', 'receipt.acceptedAt');
      const expectedFee = appealFee(state.escrowAmount, policy.appealFeeBp);
      if (!expectedFee.ok) return rejection('AMOUNT', expectedFee.error.message, 'payload.fee_amount');
      if (p.fee_amount !== expectedFee.value) return rejection('AMOUNT', 'fee_amount must equal ceil(amount*1000/10000)', 'payload.fee_amount');
      if (ctx.funds.spendable(underdog) < expectedFee.value) return rejection('INSUFFICIENT_FUNDS', 'Appellant cannot cover the appeal fee', 'payload.fee_amount');
      return accept(next({ status: 'appealed', appealRound: 1, appellant: underdog, appealFeeAmount: expectedFee.value, jurors: [], seatedJurors: [], voteDeadlines: {}, votes: {} }),
        [{ kind: 'appeal_escrow_lock', dealId: state.dealId, from: underdog, amount: expectedFee.value }]);
    }
    case 'AppealFeeSettled': {
      const p = event.payload;
      if (state.appealFeeSettled) return rejection('DUPLICATE', 'Appeal fee already settled', 'payload.deal_id');
      if (state.status !== 'resolved_final') return rejection('STATE', 'AppealFeeSettled requires status resolved_final', 'payload.deal_id');
      if (state.appellant === null || state.appealFeeAmount === null || state.round0Outcome === null || state.finalOutcome === null) return rejection('STATE', 'No appeal fee to settle', 'payload.deal_id');
      const reversed = state.finalOutcome !== state.round0Outcome;
      if (p.outcome !== (reversed ? 'returned' : 'burned')) return rejection('STATE', 'Settlement outcome must be returned iff the round-1 outcome differs', 'payload.outcome');
      if (p.amount !== state.appealFeeAmount) return rejection('AMOUNT', 'Amount must equal the escrowed appeal fee', 'payload.amount');
      const movement: Movement = reversed
        ? { kind: 'appeal_fee_return', dealId: state.dealId, to: state.appellant, amount: state.appealFeeAmount }
        : { kind: 'appeal_fee_burn', dealId: state.dealId, amount: state.appealFeeAmount };
      return accept(next({ appealFeeSettled: true }), [movement]);
    }
    case 'EscrowReleased': return release(state, event, t, deadline, rejectedAt, resolvedAt0, ctx);
    case 'FeeBurned': {
      const p = event.payload;
      if (state.status !== 'release_pending_fee' || state.release === null) return rejection(state.status === 'completed' ? 'DUPLICATE' : 'STATE', 'FeeBurned requires status release_pending_fee', 'payload.deal_id');
      if (event.signer !== state.release.signer) return rejection('SIGNER_AUTHORITY', 'FeeBurned must be signed by the release signer', 'signer');
      if (p.amount !== state.release.fee) return rejection('AMOUNT', 'FeeBurned amount must equal F', 'payload.amount');
      return accept(next({ status: 'completed', feeBurned: true }), [{ kind: 'fee_burn', dealId: state.dealId, amount: p.amount }]);
    }
    case 'EvidenceRevealed': {
      const p = event.payload;
      // SPEC-GAP: the state table does not list EvidenceRevealed. Conservative choice: a party may reveal once per
      // kind in any existing deal that is not expired; no state change and no movement.
      if (state.status === 'expired') return rejection('STATE', 'Deal is expired', 'payload.deal_id');
      if ((event.signer !== state.buyer && event.signer !== state.seller) || p.by !== event.signer) return rejection('SIGNER_AUTHORITY', 'EvidenceRevealed must be signed by a deal party with by=signer', 'signer');
      if (state.reveals.some((r) => r.by === p.by && r.kind === p.kind)) return rejection('DUPLICATE', 'Evidence already revealed', 'payload.kind');
      return accept(next({ reveals: [...state.reveals, { by: p.by, kind: p.kind }] }));
    }
    default: { const _x: never = event; return _x; }
  }
}

function assignJury(state: DealState, event: Extract<DealEvent, { type: 'JuryAssigned' }>, t: number, ctx: DealContext): TransitionResult {
  const p = event.payload;
  const wanted: DealStatus = p.appeal_round === 0 ? 'disputed' : 'appealed';
  if (state.status !== wanted || state.appealRound !== p.appeal_round) return rejection('STATE', 'JuryAssigned does not match the active round', 'payload.appeal_round');
  if (state.jurors.length > 0) return rejection('DUPLICATE', 'Jury already assigned for this round', 'payload.jurors');
  const required = p.appeal_round === 0 ? 3 : 5;
  if (p.jurors.length !== required || new Set(p.jurors).size !== required) return rejection('JURY_MISMATCH', 'Jurors must be unique and of the exact round size', 'payload.jurors');
  // Independent of the oracle: never a party, and round 1 is disjoint from round 0.
  for (const juror of p.jurors) {
    if (!other(state, juror)) return rejection('JURY_MISMATCH', 'A party cannot be a juror', 'payload.jurors');
    if (p.appeal_round === 1 && state.round0Jurors.includes(juror)) return rejection('JURY_MISMATCH', 'Round-1 jurors must be disjoint from round 0', 'payload.jurors');
  }
  const expected = ctx.jury.expectedJurors(state.dealId, p.appeal_round);
  // SPEC-GAP: if the eligible pool is too small the oracle returns POLICY; the machine fails closed (spec OFFEN).
  if (!expected.ok) return { ok: false, error: expected.error };
  if (expected.value.length !== p.jurors.length || expected.value.some((j, i) => j !== p.jurors[i])) return rejection('JURY_MISMATCH', 'Jurors differ from the deterministic selection', 'payload.jurors');
  const deadline = new Date(t + ctx.policy.voteWindowMs).toISOString();
  const deadlines: Record<string, IsoUtc> = {};
  for (const juror of p.jurors) deadlines[juror] = deadline;
  return accept({
    ...state, jurors: [...p.jurors], seatedJurors: [...p.jurors],
    round0Jurors: p.appeal_round === 0 ? [...p.jurors] : state.round0Jurors, voteDeadlines: deadlines, votes: {},
  });
}

function release(state: DealState, event: Extract<DealEvent, { type: 'EscrowReleased' }>, t: number, deadline: number, rejectedAt: number | null, resolvedAt0: number | null, ctx: DealContext): TransitionResult {
  const p = event.payload;
  const policy = ctx.policy;
  const E = state.escrowAmount;
  const dealId = state.dealId;
  const refund = (): TransitionResult => {
    if (p.to !== state.buyer) return rejection('STATE', 'Refund must go to the buyer', 'payload.to');
    if (p.amount !== E) return rejection('AMOUNT', 'Refund must return the entire escrow', 'payload.amount');
    return accept({ ...state, status: 'refunded', release: { signer: event.signer, to: p.to, amount: E, fee: 0 } }, [{ kind: 'escrow_refund_to_buyer', dealId, to: state.buyer, amount: E }]);
  };
  const sellerSettlement = (): TransitionResult => {
    const f = fee(E, policy.feeBp);
    if (!f.ok) return rejection('AMOUNT', f.error.message, 'payload.amount');
    if (p.to !== state.seller) return rejection('STATE', 'Settlement must go to the seller', 'payload.to');
    if (p.amount !== E - f.value) return rejection('AMOUNT', 'Seller release must equal E-F', 'payload.amount');
    return accept({ ...state, status: 'release_pending_fee', release: { signer: event.signer, to: p.to, amount: p.amount, fee: f.value } }, [{ kind: 'escrow_release_to_seller', dealId, to: state.seller, amount: p.amount }]);
  };
  const byOutcome = (winner: Side): TransitionResult => (winner === 'seller' ? sellerSettlement() : refund());

  switch (state.status) {
    case 'escrowed':
      if (t < deadline) return rejection('WINDOW', 'Refund without delivery requires acceptedAt >= deadline', 'receipt.acceptedAt');
      return refund();
    case 'rejected':
      if (rejectedAt === null || t <= rejectedAt + policy.disputeWindowMs) return rejection('WINDOW', 'Refund after rejection requires the dispute window to have closed', 'receipt.acceptedAt');
      return refund();
    case 'accepted': return sellerSettlement();
    case 'resolved':
      if (state.round0Outcome === null || resolvedAt0 === null) return rejection('STATE', 'Missing round-0 outcome', 'payload.deal_id');
      if (t <= resolvedAt0 + policy.appealWindowMs) return rejection('WINDOW', 'Release is forbidden while the appeal window is open', 'receipt.acceptedAt');
      return byOutcome(state.round0Outcome);
    case 'resolved_final':
      if (state.finalOutcome === null) return rejection('STATE', 'Missing final outcome', 'payload.deal_id');
      // SPEC-GAP: the spec does not order AppealFeeSettled against EscrowReleased after round 1. Conservative choice:
      // require the appeal fee to be settled first so the appeal escrow can never be stranded in a terminal deal.
      if (!state.appealFeeSettled) return rejection('STATE', 'Appeal fee must be settled before release', 'payload.deal_id');
      return byOutcome(state.finalOutcome);
    case 'disputed': case 'appealed':
      return rejection('STATE', 'Release is forbidden while a dispute or appeal is active', 'payload.deal_id');
    case 'release_pending_fee': case 'completed': case 'refunded':
      return rejection('DUPLICATE', 'Escrow has already been released', 'payload.deal_id');
    case 'created': case 'consented': case 'delivered': case 'expired':
      return rejection('STATE', 'EscrowReleased is not valid in this state', 'payload.deal_id');
    default: { const _x: never = state.status; return _x; }
  }
}
