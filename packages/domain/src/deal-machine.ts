import type { DomainError, SignedEvent } from './protocol.js';
import { verifyAttestation } from '../../crypto/src/index.js';

export type DealStatus = 'created' | 'consented' | 'escrowed' | 'delivered' | 'accepted' | 'rejected' | 'disputed' | 'resolved' | 'released';
export interface DealState { dealId: string; status: DealStatus; buyer: string; seller: string; amount: number; criteriaHash: string; deadline: string; appealRound: 0 | 1; jurors: readonly string[]; votes: Readonly<Record<string, 'buyer' | 'seller'>>; settlementTo?: string; releaseSigner?: string; releasedAmount?: number; refundWithoutDelivery?: true; feeBurned?: true }
export interface DealPolicy { disputeQuorum(appealRound: 0 | 1): number; canStartAppeal(state: DealState): boolean; settlementIsValid(state: DealState, releasedAmount: number, feeAmount: number): boolean }
export type TransitionResult = { ok: true; value: DealState } | { ok: false; error: DomainError };

function rejection(code: string, message: string): TransitionResult { return { ok: false, error: { code, message } }; }
function eventForDeal(event: SignedEvent): string | undefined {
  return 'deal_id' in event.payload ? event.payload.deal_id : undefined;
}

/** Apply one already structurally validated event to a deal projection. */
export function applyDealEvent(state: DealState | undefined, event: SignedEvent, policy: DealPolicy): TransitionResult {
  const dealId = eventForDeal(event);
  if (event.type === 'DealCreated') {
    if (state || !dealId) return rejection('PAYLOAD', 'Deal already exists or has no id');
    const p = event.payload;
    return { ok: true, value: { dealId, status: 'created', buyer: p.buyer, seller: p.seller, amount: p.amount, criteriaHash: p.criteria_hash, deadline: p.deadline, appealRound: 0, jurors: [], votes: {} } };
  }
  if (!state || !dealId || state.dealId !== dealId) return rejection('PAYLOAD', 'Deal does not exist');
  return transitionExisting(state, event, policy);
}

function transitionExisting(state: DealState, event: SignedEvent, policy: DealPolicy): TransitionResult {
  switch (event.type) {
    case 'DealConsented':
      return event.payload.seller === state.seller && event.signer === state.seller && state.status === 'created'
        && verifyAttestation('deal-consent', { deal_id: state.dealId, buyer: state.buyer, seller: state.seller, amount: state.amount, criteria_hash: state.criteriaHash, deadline: state.deadline }, event.payload.consent_sig, state.seller)
        ? move(state, 'consented') : invalid();
    case 'EscrowFunded':
      return event.payload.from === state.buyer && event.payload.amount === state.amount && state.status === 'consented' ? move(state, 'escrowed') : invalid();
    case 'DeliverableSubmitted': return state.status === 'escrowed' ? move(state, 'delivered') : invalid();
    case 'PrecheckCompleted': return state.status === 'delivered' ? { ok: true, value: state } : invalid();
    case 'DealAccepted':
      return event.payload.by === state.buyer && state.status === 'delivered' ? move(state, 'accepted', { settlementTo: state.seller }) : invalid();
    case 'DealRejected':
      return event.payload.by === state.buyer && state.status === 'delivered' ? move(state, 'rejected') : invalid();
    case 'DisputeOpened':
      return state.status === 'rejected' && [state.buyer, state.seller].includes(event.payload.by) ? move(state, 'disputed') : invalid();
    case 'JuryAssigned':
      if (state.status === 'disputed' && event.payload.appeal_round === state.appealRound && state.jurors.length === 0)
        return { ok: true, value: { ...state, jurors: event.payload.jurors, votes: {} } };
      if (state.status === 'resolved' && state.appealRound === 0 && event.payload.appeal_round === 1 && policy.canStartAppeal(state))
        return { ok: true, value: { ...state, status: 'disputed', appealRound: 1, jurors: event.payload.jurors, votes: {} } };
      return invalid();
    case 'JuryVoted': {
      if (state.status !== 'disputed' || event.payload.appeal_round !== state.appealRound || !state.jurors.includes(event.payload.juror) || state.votes[event.payload.juror]) return invalid();
      return { ok: true, value: { ...state, votes: { ...state.votes, [event.payload.juror]: event.payload.vote } } };
    }
    case 'DisputeResolved':
      if (state.status !== 'disputed' || event.payload.appeal_round !== state.appealRound) return invalid();
      const quorum = policy.disputeQuorum(state.appealRound);
      if (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > state.jurors.length || Object.keys(state.votes).length < quorum) return invalid();
      const buyerVotes = Object.values(state.votes).filter((vote) => vote === 'buyer').length;
      const sellerVotes = Object.values(state.votes).length - buyerVotes;
      if (buyerVotes === sellerVotes || event.payload.outcome !== (buyerVotes > sellerVotes ? 'buyer' : 'seller')) return invalid();
      return move(state, 'resolved', { settlementTo: event.payload.outcome === 'buyer' ? state.buyer : state.seller });
    case 'EscrowReleased': {
      const refundAfterDeadline = state.status === 'escrowed' && event.payload.to === state.buyer
        && event.signer === state.buyer && Date.parse(event.timestamp) >= Date.parse(state.deadline)
        && event.payload.amount === state.amount;
      if (refundAfterDeadline) return move(state, 'released', { settlementTo: state.buyer, releaseSigner: event.signer, releasedAmount: event.payload.amount, refundWithoutDelivery: true });
      const allowed = state.status === 'accepted' || state.status === 'resolved';
      const signerAllowed = state.status === 'resolved' || event.signer === state.buyer;
      return allowed && signerAllowed && event.payload.to === state.settlementTo && event.payload.amount <= state.amount
        ? move(state, 'released', { releaseSigner: event.signer, releasedAmount: event.payload.amount }) : invalid();
    }
    case 'FeeBurned': return state.status === 'released' && state.refundWithoutDelivery !== true && state.feeBurned !== true
      && event.signer === state.releaseSigner && policy.settlementIsValid(state, state.releasedAmount ?? 0, event.payload.amount)
      ? { ok: true, value: { ...state, feeBurned: true } } : invalid();
    default: return invalid();
  }
}

function move(state: DealState, status: DealStatus, patch: Partial<DealState> = {}): TransitionResult { return { ok: true, value: { ...state, ...patch, status } }; }
function invalid(): TransitionResult { return rejection('PAYLOAD', 'Event is not valid in the current deal state'); }
