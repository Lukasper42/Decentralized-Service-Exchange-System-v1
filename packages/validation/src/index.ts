import type { EventType, PayloadMap, Result, SignedEvent } from '../../domain/src/protocol.js';
import { err } from '../../domain/src/protocol.js';
import { verifyAttestation, verifyEvent } from '../../crypto/src/index.js';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIELDS: Record<EventType, readonly string[]> = {
  AccountCreated: ['pubkey', 'recovery_commitment'], DealCreated: ['deal_id', 'buyer', 'seller', 'amount', 'criteria_hash', 'deadline'],
  DealConsented: ['deal_id', 'seller', 'consent_sig'], EscrowFunded: ['deal_id', 'from', 'amount'],
  DeliverableSubmitted: ['deal_id', 'content_hash', 'precheck_ref'], PrecheckCompleted: ['deal_id', 'content_hash', 'result', 'checker_id', 'sig'],
  DealAccepted: ['deal_id', 'by'], DealRejected: ['deal_id', 'by', 'reason_hash'], DisputeOpened: ['deal_id', 'by'],
  JuryAssigned: ['deal_id', 'jurors', 'appeal_round'], JuryVoted: ['deal_id', 'juror', 'vote', 'appeal_round', 'sig'],
  DisputeResolved: ['deal_id', 'outcome', 'appeal_round'], EscrowReleased: ['deal_id', 'to', 'amount'], FeeBurned: ['deal_id', 'amount'],
  ReputationEvent: ['account', 'counterparty', 'deal_id', 'delta', 'reason_hash', 'both_sigs'],
  TreasurySpend: ['recipient', 'amount', 'purpose_hash', 'nonce', 'approvals'],
  CurrencyIssued: ['recipient', 'amount', 'policy_id', 'basis_hash', 'grant_kind', 'approvals'],
};
type RecordValue = Record<string, unknown>;
function fail(code: string, path: string, message = `Invalid ${path}`): Result<never> { return err(code, message, path); }
function isObject(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function validIso(value: unknown): value is string { return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function checkPubkey(value: unknown, path: string): Result<true> {
  if (typeof value !== 'string') return fail('FIELD_FORMAT', path);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length !== 44 || bytes.subarray(0, 12).toString('hex') !== '302a300506032b6570032100') return fail('FIELD_FORMAT', path);
  return { ok: true, value: true };
}
function checkSig(value: unknown, path: string): Result<true> {
  if (typeof value !== 'string') return fail('FIELD_FORMAT', path);
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value && bytes.length === 64 ? { ok: true, value: true } : fail('FIELD_FORMAT', path);
}
function checkApprovalList(value: unknown): Result<true> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) return fail('LIMIT', 'payload.approvals');
  const signers = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isObject(item) || Object.keys(item).sort().join(',') !== 'sig,signer') return fail('PAYLOAD', `payload.approvals[${index}]`);
    const key = checkPubkey(item.signer, `payload.approvals[${index}].signer`);
    const sig = checkSig(item.sig, `payload.approvals[${index}].sig`);
    if (!key.ok) return key; if (!sig.ok) return sig;
    if (signers.has(item.signer as string)) return fail('LIMIT', `payload.approvals[${index}].signer`, 'Duplicate approver');
    signers.add(item.signer as string);
  }
  return { ok: true, value: true };
}
function checkPayload(type: EventType, p: RecordValue, event: SignedEvent, now: number): Result<true> {
  const expected = FIELDS[type];
  const actual = Object.keys(p).sort();
  if (actual.some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype')) return fail('UNKNOWN_FIELD', 'payload');
  for (const field of expected) if (!Object.hasOwn(p, field)) return fail('MISSING_FIELD', `payload.${field}`);
  for (const field of actual) if (!expected.includes(field)) return fail('UNKNOWN_FIELD', `payload.${field}`);
  for (const field of ['deal_id']) if (field in p && (typeof p[field] !== 'string' || !UUID.test(p[field]))) return fail('FIELD_FORMAT', `payload.${field}`);
  for (const field of ['pubkey', 'buyer', 'seller', 'from', 'checker_id', 'by', 'juror', 'account', 'counterparty', 'recipient', 'to']) {
    if (field in p) { const result = checkPubkey(p[field], `payload.${field}`); if (!result.ok) return result; }
  }
  for (const field of ['recovery_commitment', 'criteria_hash', 'content_hash', 'reason_hash', 'purpose_hash', 'nonce', 'basis_hash']) {
    if (field in p && (typeof p[field] !== 'string' || !HASH.test(p[field]))) return fail('FIELD_FORMAT', `payload.${field}`);
  }
  for (const field of ['consent_sig', 'sig']) if (field in p) { const result = checkSig(p[field], `payload.${field}`); if (!result.ok) return result; }
  if (p.amount !== undefined && (!Number.isSafeInteger(p.amount) || (p.amount as number) <= 0)) return fail('AMOUNT', 'payload.amount');
  if (type === 'DealCreated') {
    if (p.buyer === p.seller) return fail('PAYLOAD', 'payload.seller', 'Buyer and seller must differ');
    if (!validIso(p.deadline) || Date.parse(p.deadline) <= Date.parse(event.timestamp)) return fail('FIELD_FORMAT', 'payload.deadline');
  }
  if (type === 'DeliverableSubmitted' && p.precheck_ref !== null && (typeof p.precheck_ref !== 'string' || !HASH.test(p.precheck_ref))) return fail('FIELD_FORMAT', 'payload.precheck_ref');
  if (type === 'PrecheckCompleted' && !['pass', 'fail', 'inconclusive'].includes(String(p.result))) return fail('FIELD_FORMAT', 'payload.result');
  if (type === 'JuryAssigned') {
    const length = p.appeal_round === 0 ? 3 : p.appeal_round === 1 ? 5 : 0;
    if (length === 0 || !Array.isArray(p.jurors) || p.jurors.length !== length || new Set(p.jurors).size !== p.jurors.length) return fail('LIMIT', 'payload.jurors');
    for (const [index, juror] of p.jurors.entries()) { const result = checkPubkey(juror, `payload.jurors[${index}]`); if (!result.ok) return result; }
  }
  if (type === 'JuryVoted' && (!['buyer', 'seller'].includes(String(p.vote)) || ![0, 1].includes(Number(p.appeal_round)))) return fail('FIELD_FORMAT', 'payload.vote');
  if (type === 'DisputeResolved' && (!['buyer', 'seller'].includes(String(p.outcome)) || ![0, 1].includes(Number(p.appeal_round)))) return fail('FIELD_FORMAT', 'payload.outcome');
  if (type === 'ReputationEvent') {
    if (![-1, 0, 1].includes(Number(p.delta)) || p.account === p.counterparty || !isObject(p.both_sigs) || Object.keys(p.both_sigs).sort().join(',') !== 'account_sig,counterparty_sig') return fail('PAYLOAD', 'payload.both_sigs');
    for (const key of ['account_sig', 'counterparty_sig']) { const result = checkSig(p.both_sigs[key], `payload.both_sigs.${key}`); if (!result.ok) return result; }
    const body = { account: p.account, counterparty: p.counterparty, deal_id: p.deal_id, delta: p.delta, reason_hash: p.reason_hash };
    if (!verifyAttestation('reputation-account', body, p.both_sigs.account_sig as string, p.account as string)
      || !verifyAttestation('reputation-counterparty', body, p.both_sigs.counterparty_sig as string, p.counterparty as string)) return fail('ATTESTATION', 'payload.both_sigs');
  }
  if (type === 'CurrencyIssued' && (typeof p.policy_id !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(p.policy_id) || !['activity', 'beta-grant'].includes(String(p.grant_kind)))) return fail('FIELD_FORMAT', 'payload.policy_id');
  if (type === 'TreasurySpend' || type === 'CurrencyIssued') { const result = checkApprovalList(p.approvals); if (!result.ok) return result; }
  if (type === 'PrecheckCompleted') {
    const body = { deal_id: p.deal_id, content_hash: p.content_hash, result: p.result, checker_id: p.checker_id };
    if (!verifyAttestation('precheck', body, p.sig as string, p.checker_id as string)) return fail('ATTESTATION', 'payload.sig');
  }
  if (type === 'JuryVoted') {
    const body = { deal_id: p.deal_id, juror: p.juror, vote: p.vote, appeal_round: p.appeal_round };
    if (!verifyAttestation('jury-vote', body, p.sig as string, p.juror as string)) return fail('ATTESTATION', 'payload.sig');
  }
  return { ok: true, value: true };
}

/** Validate an untrusted v1 event using an injected current time in milliseconds. */
export function validateEvent(input: unknown, now: number): Result<SignedEvent> {
  try { return validateEventUnchecked(input, now); }
  catch { return fail('PAYLOAD', '$', 'Malformed event input'); }
}

function validateEventUnchecked(input: unknown, now: number): Result<SignedEvent> {
  if (!Number.isFinite(now)) return fail('TIMESTAMP', 'timestamp', 'Validation clock must be finite');
  if (!isObject(input)) return fail('ENVELOPE', '$');
  if (input.version !== 1) return fail('VERSION', 'version');
  const envelope = ['type', 'version', 'payload', 'signer', 'timestamp', 'prevHash', 'signature'];
  if (Object.keys(input).sort().join(',') !== [...envelope].sort().join(',')) return fail('ENVELOPE', '$');
  if (typeof input.type !== 'string' || !Object.hasOwn(FIELDS, input.type)) return fail('UNKNOWN_TYPE', 'type');
  if (!validIso(input.timestamp) || Date.parse(input.timestamp) < now - 365 * 86400000 || Date.parse(input.timestamp) > now + 300000) return fail('TIMESTAMP', 'timestamp');
  if (!isObject(input.payload)) return fail('PAYLOAD', 'payload');
  const signer = checkPubkey(input.signer, 'signer'); if (!signer.ok) return signer;
  const signature = checkSig(input.signature, 'signature'); if (!signature.ok) return signature;
  if (input.prevHash !== null && (typeof input.prevHash !== 'string' || !HASH.test(input.prevHash))) return fail('FIELD_FORMAT', 'prevHash');
  const event = input as unknown as SignedEvent;
  const payload = checkPayload(event.type, input.payload, event, now); if (!payload.ok) return payload;
  const p = input.payload;
  const expectedSigner = event.type === 'AccountCreated' ? p.pubkey
    : event.type === 'DealCreated' ? p.buyer : event.type === 'DealConsented' ? p.seller
      : event.type === 'EscrowFunded' ? p.from : event.type === 'PrecheckCompleted' ? p.checker_id
        : event.type === 'JuryVoted' ? p.juror : event.type === 'ReputationEvent' ? p.account
          : event.type === 'DealAccepted' || event.type === 'DealRejected' || event.type === 'DisputeOpened' ? p.by : undefined;
  if (expectedSigner !== undefined && input.signer !== expectedSigner) return fail('SIGNER_AUTHORITY', 'signer');
  if ((event.type === 'TreasurySpend' || event.type === 'CurrencyIssued')
    && !(p.approvals as Array<{ signer: unknown }>).some((approval) => approval.signer === input.signer)) return fail('SIGNER_AUTHORITY', 'signer');
  if (!verifyEvent(event)) return fail('SIGNATURE', 'signature');
  return { ok: true, value: event };
}

/** Return the exact event field set for protocol tooling. */
export function eventFields(type: EventType): readonly string[] { return FIELDS[type]; }
/** A compile-time witness that every payload variant follows the schema map. */
export type SchemaPayload = PayloadMap[EventType];
