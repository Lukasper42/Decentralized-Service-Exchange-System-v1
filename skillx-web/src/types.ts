export type Pubkey = string; // Base64 of the Ed25519 SPKI DER (44 bytes)
export type Hash = string; // 64 characters lowercase hex
export type Sig = string; // Base64 of 64 raw Ed25519 signature bytes
export type IsoUtc = string; // YYYY-MM-DDTHH:mm:ss.sssZ

export type EventType =
  | 'AccountCreated'
  | 'DealCreated'
  | 'DealConsented'
  | 'EscrowFunded'
  | 'DeliverableSubmitted'
  | 'PrecheckCompleted'
  | 'DealAccepted'
  | 'DealRejected'
  | 'DisputeOpened'
  | 'JuryAssigned'
  | 'JuryVoted'
  | 'DisputeResolved'
  | 'EscrowReleased'
  | 'FeeBurned'
  | 'ReputationEvent'
  | 'TreasurySpend'
  | 'CurrencyIssued'
  | 'AccountInvited'
  | 'KeyRotated'
  | 'DealAutoAccepted'
  | 'DealExpired'
  | 'AppealOpened'
  | 'JurorReplaced'
  | 'AppealFeeSettled'
  | 'EvidenceRevealed'
  | 'RelayKeyRotated'
  | 'PolicyUpdated';

export const EVENT_TYPES: readonly EventType[] = [
  'AccountCreated',
  'DealCreated',
  'DealConsented',
  'EscrowFunded',
  'DeliverableSubmitted',
  'PrecheckCompleted',
  'DealAccepted',
  'DealRejected',
  'DisputeOpened',
  'JuryAssigned',
  'JuryVoted',
  'DisputeResolved',
  'EscrowReleased',
  'FeeBurned',
  'ReputationEvent',
  'TreasurySpend',
  'CurrencyIssued',
  'AccountInvited',
  'KeyRotated',
  'DealAutoAccepted',
  'DealExpired',
  'AppealOpened',
  'JurorReplaced',
  'AppealFeeSettled',
  'EvidenceRevealed',
  'RelayKeyRotated',
  'PolicyUpdated',
];

export interface SignedEvent {
  type: EventType;
  version: 1;
  payload: Record<string, unknown>;
  signer: Pubkey;
  timestamp: IsoUtc;
  prevHash: Hash | null;
  signature: Sig;
}

export interface Receipt {
  sequence: number;
  eventHash: Hash;
  previousReceiptHash: Hash | null;
  acceptedAt: IsoUtc;
  keyId: Hash;
  signature: Sig;
}

export interface LedgerEntry {
  event: SignedEvent;
  receipt: Receipt;
}

export interface SignedCheckpoint {
  sequence: number;
  receipt_hash: Hash;
  key_id: Hash;
  signature: Sig;
}

export interface HealthResponse {
  ok: true;
  readOnly: boolean;
  tip: number;
}

export interface TipResponse {
  tipSequence: number;
  stateHash: Hash;
}

export interface EntriesResponse {
  entries: LedgerEntry[];
  next: number | null;
}

export interface SignerTipResponse {
  signer: Pubkey;
  tip: Hash | null;
}

export interface PostEventResponse {
  receipt: Receipt;
  duplicate: boolean;
}

export type ErrorCode =
  | 'VERSION'
  | 'ENVELOPE'
  | 'TIMESTAMP'
  | 'PAYLOAD'
  | 'SIGNATURE'
  | 'UNKNOWN_TYPE'
  | 'UNKNOWN_FIELD'
  | 'MISSING_FIELD'
  | 'FIELD_FORMAT'
  | 'AMOUNT'
  | 'LIMIT'
  | 'SIGNER_AUTHORITY'
  | 'ATTESTATION'
  | 'CHAIN_LINK'
  | 'FORK'
  | 'RECEIPT_SEQUENCE'
  | 'RECEIPT_EVENT_HASH'
  | 'RECEIPT_LINK'
  | 'RECEIPT_SIGNATURE'
  | 'KEY_UNKNOWN'
  | 'STATE'
  | 'WINDOW'
  | 'POLICY'
  | 'REPLAY'
  | 'DUPLICATE'
  | 'INSUFFICIENT_FUNDS'
  | 'JURY_MISMATCH'
  | 'READ_ONLY'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'TOO_LARGE'
  | 'STORE_FAILURE'
  | 'TRANSPORT'
  | 'DIVERGENCE'
  | 'SIGNING';

export interface ApiError {
  code: ErrorCode;
  message: string;
  path: string;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(code: ErrorCode, message: string, path: string): Result<T> {
  return { ok: false, error: { code, message, path } };
}

export interface DealPayload {
  deal_id: string;
  buyer: Pubkey;
  seller: Pubkey;
  amount: number;
  criteria_hash: Hash;
  deadline: IsoUtc;
}
