/** Protocol v1 wire types. Field names and shapes follow Core Schema v1 (pre-release revision 2). */
export type Pubkey = string;
export type Hash = string;
export type Sig = string;
export type Uuid = string;
export type Amount = number;
export type IsoUtc = string;

/** Spec section 3: smallest and largest amount, floor(MAX_SAFE_INTEGER / 10000). */
export const AMOUNT_MIN = 2;
export const AMOUNT_MAX = 900719925474;
/** Spec section 7: maximum distance between event.timestamp and receipt.acceptedAt. */
export const TIMESTAMP_SKEW_MS = 300000;
/** Spec section 6: receipts between a trigger and its randomness beacon. */
export const BEACON_DELAY = 10;

export const EVENT_TYPES = [
  'AccountCreated', 'DealCreated', 'DealConsented', 'EscrowFunded', 'DeliverableSubmitted',
  'PrecheckCompleted', 'DealAccepted', 'DealRejected', 'DisputeOpened', 'JuryAssigned',
  'JuryVoted', 'DisputeResolved', 'EscrowReleased', 'FeeBurned', 'ReputationEvent',
  'TreasurySpend', 'CurrencyIssued', 'AccountInvited', 'KeyRotated', 'DealAutoAccepted',
  'DealExpired', 'AppealOpened', 'JurorReplaced', 'AppealFeeSettled', 'EvidenceRevealed',
  'RelayKeyRotated', 'PolicyUpdated',
] as const;
export type EventType = typeof EVENT_TYPES[number];

export interface Approval { signer: Pubkey; sig: Sig }

export interface PayloadMap {
  AccountCreated: { pubkey: Pubkey; recovery_commitment: Hash; invite_ref: Hash | null };
  AccountInvited: { invitee: Pubkey; expires: IsoUtc };
  KeyRotated: { old_pubkey: Pubkey; new_pubkey: Pubkey; recovery_pubkey: Pubkey; new_recovery_commitment: Hash; sig: Sig };
  DealCreated: { deal_id: Uuid; buyer: Pubkey; seller: Pubkey; amount: Amount; criteria_hash: Hash; deadline: IsoUtc };
  DealConsented: { deal_id: Uuid; seller: Pubkey; consent_sig: Sig };
  EscrowFunded: { deal_id: Uuid; from: Pubkey; amount: Amount };
  DeliverableSubmitted: { deal_id: Uuid; content_hash: Hash; precheck_ref: Hash | null };
  PrecheckCompleted: { deal_id: Uuid; content_hash: Hash; result: 'pass' | 'fail' | 'inconclusive'; checker_id: Pubkey; sig: Sig };
  DealAccepted: { deal_id: Uuid; by: Pubkey };
  DealRejected: { deal_id: Uuid; by: Pubkey; reason_hash: Hash };
  DealAutoAccepted: { deal_id: Uuid; by: Pubkey };
  DealExpired: { deal_id: Uuid; by: Pubkey };
  DisputeOpened: { deal_id: Uuid; by: Pubkey };
  JuryAssigned: { deal_id: Uuid; jurors: Pubkey[]; appeal_round: 0 | 1 };
  JuryVoted: { deal_id: Uuid; juror: Pubkey; vote: 'buyer' | 'seller'; appeal_round: 0 | 1; sig: Sig };
  JurorReplaced: { deal_id: Uuid; appeal_round: 0 | 1; missing_juror: Pubkey; replacement: Pubkey };
  DisputeResolved: { deal_id: Uuid; outcome: 'buyer' | 'seller'; appeal_round: 0 | 1 };
  AppealOpened: { deal_id: Uuid; by: Pubkey; fee_amount: Amount };
  AppealFeeSettled: { deal_id: Uuid; outcome: 'returned' | 'burned'; amount: Amount };
  EscrowReleased: { deal_id: Uuid; to: Pubkey; amount: Amount };
  FeeBurned: { deal_id: Uuid; amount: Amount };
  ReputationEvent: { account: Pubkey; counterparty: Pubkey; deal_id: Uuid; delta: -1 | 0 | 1; reason_hash: Hash };
  EvidenceRevealed: { deal_id: Uuid; by: Pubkey; kind: 'criteria' | 'reason' | 'purpose' | 'precheck-report'; salt: string };
  TreasurySpend: { recipient: Pubkey; amount: Amount; purpose_hash: Hash; nonce: Hash; approvals: Approval[] };
  CurrencyIssued: { recipient: Pubkey; amount: Amount; policy_id: string; basis_hash: Hash; grant_kind: 'activity' | 'beta-grant'; nonce: Hash; approvals: Approval[] };
  RelayKeyRotated: { key_id: Hash; pubkey: Pubkey; valid_from_sequence: number; approvals: Approval[] };
  PolicyUpdated: { policy_version: number; params_hash: Hash; activation_sequence: number; approvals: Approval[] };
}

export type EventPayload<T extends EventType = EventType> = PayloadMap[T];
export type EventCore<T extends EventType = EventType> = { [K in T]: {
  type: K; version: 1; payload: PayloadMap[K]; signer: Pubkey; timestamp: IsoUtc; prevHash: Hash | null;
} }[T];
export type SignedEvent<T extends EventType = EventType> = { [K in T]: EventCore<K> & { signature: Sig } }[T];

export interface Receipt { sequence: number; eventHash: Hash; previousReceiptHash: Hash | null; acceptedAt: IsoUtc; keyId: Hash; signature: Sig }
export interface PagedEvents { events: Array<{ event: SignedEvent; receipt: Receipt }>; nextSince: number | null }

/** Stable error codes, spec section 10. */
export const ERROR_CODES = [
  'VERSION', 'ENVELOPE', 'TIMESTAMP', 'PAYLOAD', 'SIGNATURE', 'UNKNOWN_TYPE', 'UNKNOWN_FIELD',
  'MISSING_FIELD', 'FIELD_FORMAT', 'AMOUNT', 'LIMIT', 'SIGNER_AUTHORITY', 'ATTESTATION',
  'CHAIN_LINK', 'FORK', 'RECEIPT_SEQUENCE', 'RECEIPT_EVENT_HASH', 'RECEIPT_LINK',
  'RECEIPT_SIGNATURE', 'KEY_UNKNOWN', 'STATE', 'WINDOW', 'POLICY', 'REPLAY', 'DUPLICATE',
  'INSUFFICIENT_FUNDS', 'JURY_MISMATCH',
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export interface DomainError { code: ErrorCode; message: string; path: string }
export type Result<T, E = DomainError> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(code: ErrorCode, message: string, path: string): Result<T> => ({ ok: false, error: { code, message, path } });
