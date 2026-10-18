/** Protocol v1 wire types. Field names and shapes follow Core Schema v1. */
export type Pubkey = string;
export type Hash = string;
export type Sig = string;
export type Uuid = string;
export type Amount = number;
export type IsoUtc = string;

export type EventType =
  | 'AccountCreated' | 'DealCreated' | 'DealConsented' | 'EscrowFunded'
  | 'DeliverableSubmitted' | 'PrecheckCompleted' | 'DealAccepted' | 'DealRejected'
  | 'DisputeOpened' | 'JuryAssigned' | 'JuryVoted' | 'DisputeResolved'
  | 'EscrowReleased' | 'FeeBurned' | 'ReputationEvent' | 'TreasurySpend'
  | 'CurrencyIssued';

export interface PayloadMap {
  AccountCreated: { pubkey: Pubkey; recovery_commitment: Hash };
  DealCreated: { deal_id: Uuid; buyer: Pubkey; seller: Pubkey; amount: Amount; criteria_hash: Hash; deadline: IsoUtc };
  DealConsented: { deal_id: Uuid; seller: Pubkey; consent_sig: Sig };
  EscrowFunded: { deal_id: Uuid; from: Pubkey; amount: Amount };
  DeliverableSubmitted: { deal_id: Uuid; content_hash: Hash; precheck_ref: Hash | null };
  PrecheckCompleted: { deal_id: Uuid; content_hash: Hash; result: 'pass' | 'fail' | 'inconclusive'; checker_id: Pubkey; sig: Sig };
  DealAccepted: { deal_id: Uuid; by: Pubkey };
  DealRejected: { deal_id: Uuid; by: Pubkey; reason_hash: Hash };
  DisputeOpened: { deal_id: Uuid; by: Pubkey };
  JuryAssigned: { deal_id: Uuid; jurors: Pubkey[]; appeal_round: 0 | 1 };
  JuryVoted: { deal_id: Uuid; juror: Pubkey; vote: 'buyer' | 'seller'; appeal_round: 0 | 1; sig: Sig };
  DisputeResolved: { deal_id: Uuid; outcome: 'buyer' | 'seller'; appeal_round: 0 | 1 };
  EscrowReleased: { deal_id: Uuid; to: Pubkey; amount: Amount };
  FeeBurned: { deal_id: Uuid; amount: Amount };
  ReputationEvent: { account: Pubkey; counterparty: Pubkey; deal_id: Uuid; delta: -1 | 0 | 1; reason_hash: Hash; both_sigs: { account_sig: Sig; counterparty_sig: Sig } };
  TreasurySpend: { recipient: Pubkey; amount: Amount; purpose_hash: Hash; nonce: Hash; approvals: Approval[] };
  CurrencyIssued: { recipient: Pubkey; amount: Amount; policy_id: string; basis_hash: Hash; grant_kind: 'activity' | 'beta-grant'; approvals: Approval[] };
}

export interface Approval { signer: Pubkey; sig: Sig }
export type EventPayload<T extends EventType = EventType> = PayloadMap[T];
export type EventCore<T extends EventType = EventType> = { [K in T]: {
  type: K; version: 1; payload: PayloadMap[K]; signer: Pubkey; timestamp: IsoUtc; prevHash: Hash | null;
} }[T];
export type SignedEvent<T extends EventType = EventType> = { [K in T]: EventCore<K> & { signature: Sig } }[T];
export interface Receipt { sequence: number; eventHash: Hash; previousReceiptHash: Hash | null; acceptedAt: IsoUtc; signature: Sig }
export interface PagedEvents { events: Array<{ event: SignedEvent; receipt: Receipt }>; nextSince: number | null }
export interface DomainError { code: string; message: string; path?: string }
export type Result<T, E = DomainError> = { ok: true; value: T } | { ok: false; error: E };
export const err = <T = never>(code: string, message: string, path?: string): Result<T> => ({ ok: false, error: path === undefined ? { code, message } : { code, message, path } });
