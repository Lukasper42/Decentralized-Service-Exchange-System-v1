import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Approval, EventCore, EventType, Hash, PayloadMap, Pubkey, Receipt, Sig, SignedEvent } from '../../domain/src/protocol.js';
import { strictEd25519Precheck } from './ed25519-strict.js';

const MAX_DEPTH = 64;
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
const HASH_RE = /^[a-f0-9]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Thrown by `canonical` for values outside the Core Schema v1 representable set. */
export class CanonicalError extends TypeError {}
/** Thrown by signing/commitment helpers when the caller passes a programming-level invalid input. */
export class CryptoInputError extends Error {}

function assertUnicode(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalError('Unpaired surrogate');
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new CanonicalError('Unpaired surrogate');
  }
}

function encode(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) throw new CanonicalError('Canonical depth exceeded');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  // SPEC-GAP: the spec does not define string escaping for non-TypeScript implementations. JSON.stringify
  // (well-formed, ES2019) is pinned by tests; RFC 8785 string rules are the recommended cross-language reference.
  if (typeof value === 'string') { assertUnicode(value); return JSON.stringify(value); }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new CanonicalError('Canonical numbers must be safe integers');
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new CanonicalError('Canonical cycle');
    seen.add(value);
    const values = Array.from({ length: value.length }, (_, i) => {
      if (!Object.hasOwn(value, i)) throw new CanonicalError('Sparse arrays are not canonical');
      return encode(value[i], depth + 1, seen);
    });
    seen.delete(value);
    return `[${values.join(',')}]`;
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new CanonicalError('Only plain objects are canonical');
    if (seen.has(value)) throw new CanonicalError('Canonical cycle');
    seen.add(value);
    const stringKeys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new CanonicalError('Symbol keys are not canonical');
      stringKeys.push(key);
    }
    stringKeys.sort();
    const fields = stringKeys.map((key) => {
      assertUnicode(key);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new CanonicalError('Forbidden object key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new CanonicalError('Only enumerable data properties are canonical');
      return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1, seen)}`;
    });
    seen.delete(value);
    return `{${fields.join(',')}}`;
  }
  throw new CanonicalError('Unsupported canonical value');
}

/** Serialize a JSON-compatible protocol value with the Core Schema v1 rules. */
export function canonical(value: unknown): string { return encode(value, 0, new Set()); }
/** SHA-256 hex over raw bytes or the UTF-8 encoding of a string. */
export function sha256Hex(bytes: Uint8Array | string): Hash { return createHash('sha256').update(bytes).digest('hex'); }
/** SHA-256 hex over the canonical JSON of a value. */
export function hashCanonical(value: unknown): Hash { return sha256Hex(canonical(value)); }
/** SHA-256 raw content bytes (alias of `sha256Hex` for bytes). */
export function contentHash(bytes: Uint8Array): Hash { return sha256Hex(bytes); }

function strictBase64(encoded: unknown): Buffer | null {
  if (typeof encoded !== 'string') return null;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.toString('base64') === encoded ? bytes : null;
}

function isNodeCryptoError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' && code.startsWith('ERR_');
}

/** Raw 32-byte key from an Ed25519 SPKI Base64 string, or null if malformed. */
function rawPublicKey(encoded: unknown): Buffer | null {
  const der = strictBase64(encoded);
  if (der === null || der.length !== 44 || der.subarray(0, 12).toString('hex') !== ED25519_SPKI_PREFIX) return null;
  return der.subarray(12);
}
function publicKeyObject(encoded: string): KeyObject | null {
  const der = strictBase64(encoded);
  if (der === null) return null;
  try { return createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  catch (error) { if (isNodeCryptoError(error)) return null; throw error; }
}
function privateKeyObject(encoded: string): KeyObject {
  const der = strictBase64(encoded);
  if (der === null) throw new CryptoInputError('Invalid private key encoding');
  let key: KeyObject;
  try { key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); }
  catch (error) { if (isNodeCryptoError(error)) throw new CryptoInputError('Invalid private key'); throw error; }
  if (key.asymmetricKeyType !== 'ed25519') throw new CryptoInputError('Expected Ed25519 PKCS8 key');
  return key;
}

/**
 * RFC 8032-strict verification of `message` (A11): length, S < L, canonical decodable A and R, no small order,
 * then crypto.verify. Never throws for hostile input.
 */
export function strictVerify(message: Uint8Array, signatureBase64: unknown, publicKeyBase64: unknown): boolean {
  const sig = strictBase64(signatureBase64);
  const raw = rawPublicKey(publicKeyBase64);
  if (sig === null || raw === null || typeof publicKeyBase64 !== 'string') return false;
  if (!strictEd25519Precheck(raw, sig)) return false;
  const key = publicKeyObject(publicKeyBase64);
  if (key === null) return false;
  try { return verify(null, message, key, sig); }
  catch (error) { if (isNodeCryptoError(error)) return false; throw error; }
}

/** Canonical UTF-8 bytes, or null when the value is not canonically representable. */
function canonicalBytes(value: unknown): Buffer | null {
  try { return Buffer.from(canonical(value), 'utf8'); }
  catch (error) { if (error instanceof CanonicalError) return null; throw error; }
}

/** Create an Ed25519 identity in the wire formats defined by Core Schema v1. */
export function createIdentity(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

/** Sign an event core using its canonical UTF-8 representation. */
export function signEvent<T extends EventType>(core: EventCore<T>, key: string): SignedEvent<T> {
  const signature = sign(null, Buffer.from(canonical(core), 'utf8'), privateKeyObject(key)).toString('base64');
  return { ...core, signature };
}
/** Verify an event without throwing for malformed or hostile input. */
export function verifyEvent(event: SignedEvent): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const { signature, ...core } = event;
  const bytes = canonicalBytes(core);
  return bytes !== null && strictVerify(bytes, signature, event.signer);
}
/** Hash the complete signed event. */
export function eventHash(event: SignedEvent): Hash { return hashCanonical(event); }

/** keyId = SHA-256 hex of the UTF-8 Base64 SPKI string of the relay public key. */
export function relayKeyId(pubkeyBase64: Pubkey): Hash { return sha256Hex(pubkeyBase64); }
/** receiptHash = SHA-256 hex of the canonical complete receipt, signature included. */
export function receiptHash(receipt: Receipt): Hash { return hashCanonical(receipt); }

/** Sign receipt fields, excluding the signature. */
export function signReceipt(core: Omit<Receipt, 'signature'>, key: string): Receipt {
  return { ...core, signature: sign(null, Buffer.from(canonical(core), 'utf8'), privateKeyObject(key)).toString('base64') };
}
/** Verify a receipt against a relay public key; also requires keyId to name that key. */
export function verifyReceipt(receipt: Receipt, key: Pubkey): boolean {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return false;
  if (Object.keys(receipt).sort().join(',') !== 'acceptedAt,eventHash,keyId,previousReceiptHash,sequence,signature') return false;
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) return false;
  if (typeof receipt.eventHash !== 'string' || !HASH_RE.test(receipt.eventHash)) return false;
  if (receipt.previousReceiptHash !== null && (typeof receipt.previousReceiptHash !== 'string' || !HASH_RE.test(receipt.previousReceiptHash))) return false;
  if (typeof receipt.keyId !== 'string' || !HASH_RE.test(receipt.keyId) || receipt.keyId !== relayKeyId(key)) return false;
  if (typeof receipt.acceptedAt !== 'string' || !ISO_RE.test(receipt.acceptedAt)
    || !Number.isFinite(Date.parse(receipt.acceptedAt)) || new Date(receipt.acceptedAt).toISOString() !== receipt.acceptedAt) return false;
  const { signature, ...core } = receipt;
  const bytes = canonicalBytes(core);
  return bytes !== null && strictVerify(bytes, signature, key);
}

/** Closed set of attestation kinds (A13). */
export const ATTESTATION_KINDS = ['deal-consent', 'precheck', 'jury-vote', 'treasury-approval', 'key-rotation', 'checkpoint'] as const;
export type AttestationKind = typeof ATTESTATION_KINDS[number];
export function isAttestationKind(kind: unknown): kind is AttestationKind {
  for (const known of ATTESTATION_KINDS) if (kind === known) return true;
  return false;
}
function attestationMessage(kind: AttestationKind, body: unknown): Buffer | null {
  const bytes = canonicalBytes(body);
  return bytes === null ? null : Buffer.concat([Buffer.from(`skillx/v1/${kind}\n`, 'utf8'), bytes]);
}
/** Sign a domain-separated attestation body. Throws CryptoInputError for an unknown kind or non-canonical body. */
export function signAttestation(kind: AttestationKind, body: unknown, key: string): Sig {
  if (!isAttestationKind(kind)) throw new CryptoInputError('Unknown attestation kind');
  const message = attestationMessage(kind, body);
  if (message === null) throw new CryptoInputError('Attestation body is not canonically representable');
  return sign(null, message, privateKeyObject(key)).toString('base64');
}
/** Verify a domain-separated attestation without throwing on untrusted input. */
export function verifyAttestation(kind: unknown, body: unknown, signature: unknown, key: unknown): boolean {
  if (!isAttestationKind(kind)) return false;
  const message = attestationMessage(kind, body);
  return message !== null && strictVerify(message, signature, key);
}

/** Salted commitment kinds, spec section 6. */
export const COMMITMENT_KINDS = ['criteria', 'reason', 'purpose'] as const;
export type CommitmentKind = typeof COMMITMENT_KINDS[number];
/** SHA-256 of `skillx/v1/commit/<kind>\n` || 32 salt bytes || content bytes. */
export function commitment(kind: CommitmentKind, salt32: Uint8Array, contentBytes: Uint8Array): Hash {
  if (!COMMITMENT_KINDS.some((known) => known === kind)) throw new CryptoInputError('Unknown commitment kind');
  if (salt32.length !== 32) throw new CryptoInputError('Commitment salt must be exactly 32 bytes');
  return sha256Hex(Buffer.concat([Buffer.from(`skillx/v1/commit/${kind}\n`, 'utf8'), salt32, contentBytes]));
}
/** SHA-256 hex of UTF-8 `skillx/v1/recovery\n` followed by the Base64 SPKI recovery key string. */
export function recoveryCommitment(recoveryPubkey: Pubkey): Hash { return sha256Hex(`skillx/v1/recovery\n${recoveryPubkey}`); }

/** Canonical action objects of spec section 4. */
export type ApprovalAction =
  | { action: 'treasury-spend'; recipient: Pubkey; amount: number; purpose_hash: Hash; nonce: Hash }
  | { action: 'currency-issued'; recipient: Pubkey; amount: number; policy_id: string; basis_hash: Hash; grant_kind: 'activity' | 'beta-grant'; nonce: Hash }
  | { action: 'relay-key-rotated'; key_id: Hash; pubkey: Pubkey; valid_from_sequence: number }
  | { action: 'policy-updated'; policy_version: number; params_hash: Hash; activation_sequence: number };
export function actionHash(action: ApprovalAction): Hash { return hashCanonical(action); }
/** Event type plus payload of an approval-governed event. */
export type ApprovalSource = { [K in 'TreasurySpend' | 'CurrencyIssued' | 'RelayKeyRotated' | 'PolicyUpdated']: { type: K; payload: PayloadMap[K] } }['TreasurySpend' | 'CurrencyIssued' | 'RelayKeyRotated' | 'PolicyUpdated'];
/** Build the action object that an event's approvals bind. */
export function approvalActionFor(source: ApprovalSource): ApprovalAction {
  switch (source.type) {
    case 'TreasurySpend': {
      const q = source.payload;
      return { action: 'treasury-spend', recipient: q.recipient, amount: q.amount, purpose_hash: q.purpose_hash, nonce: q.nonce };
    }
    case 'CurrencyIssued': {
      const q = source.payload;
      return { action: 'currency-issued', recipient: q.recipient, amount: q.amount, policy_id: q.policy_id, basis_hash: q.basis_hash, grant_kind: q.grant_kind, nonce: q.nonce };
    }
    case 'RelayKeyRotated': {
      const q = source.payload;
      return { action: 'relay-key-rotated', key_id: q.key_id, pubkey: q.pubkey, valid_from_sequence: q.valid_from_sequence };
    }
    case 'PolicyUpdated': {
      const q = source.payload;
      return { action: 'policy-updated', policy_version: q.policy_version, params_hash: q.params_hash, activation_sequence: q.activation_sequence };
    }
    default: { const _x: never = source; return _x; }
  }
}
/** Approval signature over `treasury-approval` body `{action_hash, signer}`. */
export function signApproval(actionHashHex: Hash, signerPubkey: Pubkey, privateKey: string): Approval {
  return { signer: signerPubkey, sig: signAttestation('treasury-approval', { action_hash: actionHashHex, signer: signerPubkey }, privateKey) };
}
export function verifyApproval(actionHashHex: Hash, approval: Approval): boolean {
  if (typeof approval !== 'object' || approval === null) return false;
  return verifyAttestation('treasury-approval', { action_hash: actionHashHex, signer: approval.signer }, approval.sig, approval.signer);
}

export interface CheckpointBody { sequence: number; receipt_hash: Hash; key_id: Hash }
export function signCheckpoint(body: CheckpointBody, relayPrivateKey: string): Sig { return signAttestation('checkpoint', body, relayPrivateKey); }
export function verifyCheckpoint(body: CheckpointBody, signature: unknown, relayPubkey: Pubkey): boolean { return verifyAttestation('checkpoint', body, signature, relayPubkey); }

export interface KeyRotationBody { old_pubkey: Pubkey; new_pubkey: Pubkey; new_recovery_commitment: Hash }
/** Signed by the recovery key. */
export function signKeyRotation(body: KeyRotationBody, recoveryPrivateKey: string): Sig { return signAttestation('key-rotation', body, recoveryPrivateKey); }
export function verifyKeyRotation(body: KeyRotationBody, signature: unknown, recoveryPubkey: Pubkey): boolean { return verifyAttestation('key-rotation', body, signature, recoveryPubkey); }
