/**
 * L1 validation (spec section 7): stateless and clock-free. It knows nothing about accounts, deals, balances or
 * policy. The only time input is the receipt time `acceptedAtMs`.
 *
 * Why seller-only rules (e.g. DeliverableSubmitted) are NOT checked here: the payload carries no seller field, so
 * the validator cannot know the deal's seller. Those signer rules live in the deal machine (L3).
 */
import type { ErrorCode, EventType, PayloadMap, Result, SignedEvent } from '../../domain/src/protocol.js';
import { AMOUNT_MAX, AMOUNT_MIN, EVENT_TYPES, TIMESTAMP_SKEW_MS, err, ok } from '../../domain/src/protocol.js';
import { CanonicalError, canonical, verifyAttestation, verifyEvent } from '../../crypto/src/index.js';

const HASH = /^[a-f0-9]{64}$/;
const SALT = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const POLICY_ID = /^[a-z0-9._-]{1,64}$/;
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

type RecordValue = Record<string, unknown>;
type FieldCheck = (value: unknown, path: string) => Result<true>;
const OK: Result<true> = ok(true);

function fail(code: ErrorCode, path: string, message = `Invalid ${path}`): Result<never> { return err(code, message, path); }
function isObject(value: unknown): value is RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function validIso(value: unknown): value is string {
  return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function strictBase64(value: string): Buffer | null {
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

const pubkey: FieldCheck = (value, path) => {
  if (typeof value !== 'string') return fail('FIELD_FORMAT', path);
  const bytes = strictBase64(value);
  return bytes !== null && bytes.length === 44 && bytes.subarray(0, 12).toString('hex') === ED25519_SPKI_PREFIX ? OK : fail('FIELD_FORMAT', path);
};
const sig: FieldCheck = (value, path) => {
  if (typeof value !== 'string') return fail('FIELD_FORMAT', path);
  const bytes = strictBase64(value);
  return bytes !== null && bytes.length === 64 ? OK : fail('FIELD_FORMAT', path);
};
const hash: FieldCheck = (value, path) => typeof value === 'string' && HASH.test(value) ? OK : fail('FIELD_FORMAT', path);
const nullableHash: FieldCheck = (value, path) => value === null ? OK : hash(value, path);
const uuid: FieldCheck = (value, path) => typeof value === 'string' && UUID.test(value) ? OK : fail('FIELD_FORMAT', path);
const iso: FieldCheck = (value, path) => validIso(value) ? OK : fail('FIELD_FORMAT', path);
const amount: FieldCheck = (value, path) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= AMOUNT_MIN && value <= AMOUNT_MAX ? OK : fail('AMOUNT', path);
const positiveInt: FieldCheck = (value, path) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? OK : fail('FIELD_FORMAT', path);
function oneOfStrings(...allowed: readonly string[]): FieldCheck {
  return (value, path) => {
    if (typeof value === 'string') for (const candidate of allowed) if (value === candidate) return OK;
    return fail('FIELD_FORMAT', path);
  };
}
function oneOfNumbers(...allowed: readonly number[]): FieldCheck {
  return (value, path) => {
    if (typeof value === 'number') for (const candidate of allowed) if (value === candidate) return OK;
    return fail('FIELD_FORMAT', path);
  };
}
const round: FieldCheck = oneOfNumbers(0, 1);
const party: FieldCheck = oneOfStrings('buyer', 'seller');
const policyId: FieldCheck = (value, path) => typeof value === 'string' && POLICY_ID.test(value) ? OK : fail('FIELD_FORMAT', path);
const salt: FieldCheck = (value, path) => typeof value === 'string' && (value === '' || SALT.test(value)) ? OK : fail('FIELD_FORMAT', path);

/** Structural limit of spec section 3: 2 to 3 unique approvals. */
const approvals: FieldCheck = (value, path) => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return fail('LIMIT', path, 'Approvals must contain 2 to 3 entries');
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    const itemPath = `${path}[${index}]`;
    if (!isObject(item) || Object.keys(item).sort().join(',') !== 'sig,signer') return fail('PAYLOAD', itemPath);
    const key = pubkey(item.signer, `${itemPath}.signer`); if (!key.ok) return key;
    const signature = sig(item.sig, `${itemPath}.sig`); if (!signature.ok) return signature;
    const signer = item.signer;
    if (typeof signer !== 'string' || seen.has(signer)) return fail('LIMIT', `${itemPath}.signer`, 'Duplicate approver');
    seen.add(signer);
  }
  return OK;
};

/** Jurors: 3 (round 0) or 5 (round 1) unique keys; the exact count is tied to appeal_round in the cross-field step. */
const jurors: FieldCheck = (value, path) => {
  if (!Array.isArray(value) || (value.length !== 3 && value.length !== 5)) return fail('LIMIT', path, 'Jurors must contain exactly 3 or 5 keys');
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    const key = pubkey(item, `${path}[${index}]`); if (!key.ok) return key;
    if (typeof item !== 'string' || seen.has(item)) return fail('LIMIT', `${path}[${index}]`, 'Duplicate juror');
    seen.add(item);
  }
  return OK;
};

/**
 * Table-driven exact payload schema. The mapped type forces one validator per payload field, so adding a field to
 * PayloadMap without a validator is a compile error and no field can silently skip validation.
 */
type Schema = { readonly [K in EventType]: { readonly [F in keyof PayloadMap[K]]-?: FieldCheck } };
const SCHEMA: Schema = {
  AccountCreated: { pubkey, recovery_commitment: hash, invite_ref: nullableHash },
  AccountInvited: { invitee: pubkey, expires: iso },
  KeyRotated: { old_pubkey: pubkey, new_pubkey: pubkey, recovery_pubkey: pubkey, new_recovery_commitment: hash, sig },
  DealCreated: { deal_id: uuid, buyer: pubkey, seller: pubkey, amount, criteria_hash: hash, deadline: iso },
  DealConsented: { deal_id: uuid, seller: pubkey, consent_sig: sig },
  EscrowFunded: { deal_id: uuid, from: pubkey, amount },
  DeliverableSubmitted: { deal_id: uuid, content_hash: hash, precheck_ref: nullableHash },
  PrecheckCompleted: { deal_id: uuid, content_hash: hash, result: oneOfStrings('pass', 'fail', 'inconclusive'), checker_id: pubkey, sig },
  DealAccepted: { deal_id: uuid, by: pubkey },
  DealRejected: { deal_id: uuid, by: pubkey, reason_hash: hash },
  DealAutoAccepted: { deal_id: uuid, by: pubkey },
  DealExpired: { deal_id: uuid, by: pubkey },
  DisputeOpened: { deal_id: uuid, by: pubkey },
  JuryAssigned: { deal_id: uuid, jurors, appeal_round: round },
  JuryVoted: { deal_id: uuid, juror: pubkey, vote: party, appeal_round: round, sig },
  JurorReplaced: { deal_id: uuid, appeal_round: round, missing_juror: pubkey, replacement: pubkey },
  DisputeResolved: { deal_id: uuid, outcome: party, appeal_round: round },
  AppealOpened: { deal_id: uuid, by: pubkey, fee_amount: amount },
  AppealFeeSettled: { deal_id: uuid, outcome: oneOfStrings('returned', 'burned'), amount },
  EscrowReleased: { deal_id: uuid, to: pubkey, amount },
  FeeBurned: { deal_id: uuid, amount },
  ReputationEvent: { account: pubkey, counterparty: pubkey, deal_id: uuid, delta: oneOfNumbers(-1, 0, 1), reason_hash: hash },
  EvidenceRevealed: { deal_id: uuid, by: pubkey, kind: oneOfStrings('criteria', 'reason', 'purpose', 'precheck-report'), salt },
  TreasurySpend: { recipient: pubkey, amount, purpose_hash: hash, nonce: hash, approvals },
  CurrencyIssued: { recipient: pubkey, amount, policy_id: policyId, basis_hash: hash, grant_kind: oneOfStrings('activity', 'beta-grant'), nonce: hash, approvals },
  RelayKeyRotated: { key_id: hash, pubkey, valid_from_sequence: positiveInt, approvals },
  PolicyUpdated: { policy_version: positiveInt, params_hash: hash, activation_sequence: positiveInt, approvals },
};

/** Payload field that must equal the event signer (payload-only signer rules of spec section 5). */
const SIGNER_FIELD: { readonly [K in EventType]?: keyof PayloadMap[K] & string } = {
  AccountCreated: 'pubkey', KeyRotated: 'new_pubkey', DealCreated: 'buyer', DealConsented: 'seller',
  EscrowFunded: 'from', PrecheckCompleted: 'checker_id', DealAccepted: 'by', DealRejected: 'by',
  DealAutoAccepted: 'by', DealExpired: 'by', DisputeOpened: 'by', JuryVoted: 'juror', AppealOpened: 'by',
  ReputationEvent: 'account', EvidenceRevealed: 'by',
};

function isEventType(value: unknown): value is EventType {
  for (const known of EVENT_TYPES) if (value === known) return true;
  return false;
}

function checkPayloadShape(type: EventType, p: RecordValue): Result<true> {
  const schema: Readonly<Record<string, FieldCheck>> = SCHEMA[type];
  for (const key of Object.keys(p)) if (!Object.hasOwn(schema, key)) return fail('UNKNOWN_FIELD', `payload.${key}`);
  for (const field of Object.keys(schema)) if (!Object.hasOwn(p, field)) return fail('MISSING_FIELD', `payload.${field}`);
  for (const [field, check] of Object.entries(schema)) {
    const result = check(p[field], `payload.${field}`);
    if (!result.ok) return result;
  }
  return OK;
}

function checkCrossFields(type: EventType, p: RecordValue, acceptedAtMs: number): Result<true> {
  switch (type) {
    case 'DealCreated':
      if (p.buyer === p.seller) return fail('PAYLOAD', 'payload.seller', 'Buyer and seller must differ');
      if (typeof p.deadline !== 'string' || !(Date.parse(p.deadline) > acceptedAtMs)) return fail('TIMESTAMP', 'payload.deadline', 'Deadline must be later than acceptedAt');
      return OK;
    case 'ReputationEvent':
      return p.account === p.counterparty ? fail('PAYLOAD', 'payload.counterparty', 'Account and counterparty must differ') : OK;
    case 'JuryAssigned': {
      const expected = p.appeal_round === 0 ? 3 : 5;
      return Array.isArray(p.jurors) && p.jurors.length === expected ? OK : fail('LIMIT', 'payload.jurors', p.appeal_round === 0 ? 'Round 0 requires 3 jurors' : 'Round 1 requires 5 jurors');
    }
    case 'EvidenceRevealed':
      if (p.kind === 'precheck-report') return p.salt === '' ? OK : fail('FIELD_FORMAT', 'payload.salt', 'precheck-report salt must be the empty string');
      return p.salt !== '' ? OK : fail('FIELD_FORMAT', 'payload.salt', 'Salt must be 64 lowercase hex characters');
    case 'AccountCreated': case 'AccountInvited': case 'KeyRotated': case 'DealConsented': case 'EscrowFunded':
    case 'DeliverableSubmitted': case 'PrecheckCompleted': case 'DealAccepted': case 'DealRejected': case 'DealAutoAccepted':
    case 'DealExpired': case 'DisputeOpened': case 'JuryVoted': case 'JurorReplaced': case 'DisputeResolved': case 'AppealOpened':
    case 'AppealFeeSettled': case 'EscrowReleased': case 'FeeBurned': case 'TreasurySpend': case 'CurrencyIssued':
    case 'RelayKeyRotated': case 'PolicyUpdated':
      return OK;
    default: { const _x: never = type; return _x; }
  }
}

function checkSignerAuthority(type: EventType, p: RecordValue, signer: unknown): Result<true> {
  const field = SIGNER_FIELD[type];
  if (field !== undefined && p[field] !== signer) return fail('SIGNER_AUTHORITY', 'signer', `Signer must equal payload.${field}`);
  if (type === 'TreasurySpend' || type === 'CurrencyIssued' || type === 'RelayKeyRotated' || type === 'PolicyUpdated') {
    const list = p.approvals;
    const listed = Array.isArray(list) && list.some((entry: unknown) => isObject(entry) && entry.signer === signer);
    if (!listed) return fail('SIGNER_AUTHORITY', 'signer', 'Signer must be one of the listed approvers');
  }
  return OK;
}

function checkPayloadAttestations(type: EventType, p: RecordValue): Result<true> {
  if (type === 'PrecheckCompleted') {
    const body = { deal_id: p.deal_id, content_hash: p.content_hash, result: p.result, checker_id: p.checker_id };
    if (!verifyAttestation('precheck', body, p.sig, p.checker_id)) return fail('ATTESTATION', 'payload.sig');
  }
  if (type === 'JuryVoted') {
    const body = { deal_id: p.deal_id, juror: p.juror, vote: p.vote, appeal_round: p.appeal_round };
    if (!verifyAttestation('jury-vote', body, p.sig, p.juror)) return fail('ATTESTATION', 'payload.sig');
  }
  // KeyRotated.sig needs the recovery commitment of the old account and is verified in L2/L3.
  return OK;
}

/** Single, documented narrowing point: only called after every structural check has passed. */
function asValidatedEvent(input: RecordValue): SignedEvent {
  return input as unknown as SignedEvent;
}

/**
 * Validate an untrusted v1 event. `acceptedAtMs` is the receipt time (epoch ms), never a wall clock.
 * Cheapest checks first; no state, no balances, no policy.
 */
export function validateEvent(input: unknown, acceptedAtMs: number): Result<SignedEvent> {
  if (typeof acceptedAtMs !== 'number' || !Number.isSafeInteger(acceptedAtMs)) return fail('TIMESTAMP', 'receipt.acceptedAt', 'Receipt time must be an integer epoch in milliseconds');
  if (!isObject(input)) return fail('ENVELOPE', '$');
  try { canonical(input); }
  catch (error) {
    if (error instanceof CanonicalError) return fail('PAYLOAD', '$', `Not canonically representable: ${error.message}`);
    throw error;
  }
  if (input.version !== 1) return fail('VERSION', 'version');
  const envelope = ['type', 'version', 'payload', 'signer', 'timestamp', 'prevHash', 'signature'];
  const present = Object.keys(input);
  for (const key of present) if (!envelope.includes(key)) return fail('ENVELOPE', key, 'Unknown envelope field');
  for (const key of envelope) if (!present.includes(key)) return fail('ENVELOPE', key, 'Missing envelope field');
  const type = input.type;
  if (!isEventType(type)) return fail('UNKNOWN_TYPE', 'type');
  if (!validIso(input.timestamp)) return fail('FIELD_FORMAT', 'timestamp');
  if (Math.abs(Date.parse(input.timestamp) - acceptedAtMs) > TIMESTAMP_SKEW_MS) return fail('TIMESTAMP', 'timestamp', 'Timestamp deviates from receipt time by more than 5 minutes');
  const payload = input.payload;
  if (!isObject(payload)) return fail('PAYLOAD', 'payload');
  const signer = pubkey(input.signer, 'signer'); if (!signer.ok) return signer;
  const signature = sig(input.signature, 'signature'); if (!signature.ok) return signature;
  const prev = nullableHash(input.prevHash, 'prevHash'); if (!prev.ok) return prev;
  const shape = checkPayloadShape(type, payload); if (!shape.ok) return shape;
  const cross = checkCrossFields(type, payload, acceptedAtMs); if (!cross.ok) return cross;
  const authority = checkSignerAuthority(type, payload, input.signer); if (!authority.ok) return authority;
  const attestations = checkPayloadAttestations(type, payload); if (!attestations.ok) return attestations;
  const event = asValidatedEvent(input);
  if (!verifyEvent(event)) return fail('SIGNATURE', 'signature');
  return ok(event);
}

/** Return the exact event field set for protocol tooling. */
export function eventFields(type: EventType): readonly string[] { return Object.keys(SCHEMA[type]); }
/** A compile-time witness that every payload variant follows the schema map. */
export type SchemaPayload = PayloadMap[EventType];
