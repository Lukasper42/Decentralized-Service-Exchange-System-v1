import type { CryptoPort } from './ports.js';
import type { Hash, Pubkey, Receipt, Sig, SignedEvent } from './types.js';
import { GuardError, isRecord } from './guards.js';

export class CanonicalError extends Error {
  readonly cpath: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = 'CanonicalError';
    this.cpath = path;
  }
}

const MAX_DEPTH = 64;
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function canonicalInner(value: unknown, depth: number, path: string): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalError('Maximum depth 64 exceeded', path);
  }
  if (value === null) {
    return 'null';
  }
  const t = typeof value;
  if (t === 'boolean') {
    return JSON.stringify(value);
  }
  if (t === 'string') {
    try {
      const s = JSON.stringify(value);
      if (s === undefined) {
        throw new CanonicalError('Invalid string', path);
      }
      return s;
    } catch {
      throw new CanonicalError('Unpaired surrogate in string', path);
    }
  }
  if (t === 'number') {
    const n = value as number;
    if (!Number.isSafeInteger(n)) {
      throw new CanonicalError(
        'Only safe integers allowed',
        path,
      );
    }
    if (n === 0 && Object.is(n, -0)) {
      throw new CanonicalError('-0 is not allowed', path);
    }
    return String(n);
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new CanonicalError(`Type ${t} cannot be canonicalized`, path);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new CanonicalError('Hole in array', `${path}[${i}]`);
      }
      parts.push(canonicalInner(value[i], depth + 1, `${path}[${i}]`));
    }
    return '[' + parts.join(',') + ']';
  }
  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      throw new CanonicalError(
        'Only plain objects can be canonicalized',
        path,
      );
    }
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      if (FORBIDDEN_KEYS.includes(k)) {
        throw new CanonicalError(`Forbidden key "${k}"`, path);
      }
    }
    const parts: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) {
        throw new CanonicalError(
          'undefined value cannot be canonicalized',
          `${path}.${k}`,
        );
      }
      parts.push(`${JSON.stringify(k)}:${canonicalInner(v, depth + 1, `${path}.${k}`)}`);
    }
    return '{' + parts.join(',') + '}';
  }
  throw new CanonicalError('Unknown type', path);
}

export function canonical(value: unknown): string {
  return canonicalInner(value, 0, '$');
}

/** Canonical JSON without a given field (for signature pre-computation). */
export function canonicalWithout(value: unknown, field: string): string {
  if (!isRecord(value)) {
    throw new CanonicalError('Object expected', '$');
  }
  const copy: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    if (k !== field) {
      copy[k] = value[k];
    }
  }
  return canonical(copy);
}

const HEX_RE = /^[0-9a-f]{64}$/;

export function isHash(s: string): boolean {
  return HEX_RE.test(s);
}

// ---------------------------------------------------------------------------
// Base64 (strict) and hex
// ---------------------------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}
B64_LOOKUP['='.charCodeAt(0)] = 64;

export class Base64Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base64Error';
  }
}

export function b64Encode(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < len ? (bytes[i + 1] ?? 0) : 0;
    const b2 = i + 2 < len ? (bytes[i + 2] ?? 0) : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64_CHARS[(n >> 18) & 63];
    out += B64_CHARS[(n >> 12) & 63];
    out += i + 1 < len ? B64_CHARS[(n >> 6) & 63] : '=';
    out += i + 2 < len ? B64_CHARS[n & 63] : '=';
  }
  return out;
}

export function b64DecodeStrict(s: string): Uint8Array {
  if (s.length % 4 !== 0) {
    throw new Base64Error('Invalid Base64 length');
  }
  const clean = s.replace(/=+$/, '');
  const rem = clean.length % 4;
  if (rem === 1) {
    throw new Base64Error('Invalid Base64 remainder');
  }
  const padCount = s.length - clean.length;
  if (padCount > 2) {
    throw new Base64Error('Too much padding');
  }
  const outLen = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    if (c >= 128) {
      throw new Base64Error('Invalid character');
    }
    const v = B64_LOOKUP[c] ?? -1;
    if (v < 0 || v === 64) {
      throw new Base64Error('Invalid character');
    }
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (buffer >> bits) & 0xff;
      o++;
    }
  }
  // Remaining bits must be zero
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new Base64Error('Bits not zero');
  }
  // Re-encoding must be identical
  if (b64Encode(out) !== s) {
    throw new Base64Error('Base64 not canonical');
  }
  return out;
}

export function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytesLower(s: string): Uint8Array {
  if (!HEX_RE.test(s)) {
    throw new Base64Error('Not 64-character lowercase hex');
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(s.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

const UTF8_ENCODER = new TextEncoder();

export async function sha256Hex(port: CryptoPort, bytes: Uint8Array): Promise<Hash> {
  const digest = await port.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return bytesToHexLower(new Uint8Array(digest));
}

export async function sha256HexUtf8(port: CryptoPort, text: string): Promise<Hash> {
  return sha256Hex(port, UTF8_ENCODER.encode(text));
}

// ---------------------------------------------------------------------------
// Ed25519 via WebCrypto
// ---------------------------------------------------------------------------

// 302a300506032b6570032100 + 32 bytes public key
const SPKI_PREFIX_HEX = '302a300506032b6570032100';

function spkiPrefixBytes(): Uint8Array {
  const hex = SPKI_PREFIX_HEX;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export class KeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyFormatError';
  }
}

/** Checks strict Base64, 44 bytes length and the Ed25519 SPKI prefix. */
export function validatePubkey(pubkey: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = b64DecodeStrict(pubkey);
  } catch {
    throw new KeyFormatError('Pubkey is not strict Base64');
  }
  if (bytes.length !== 44) {
    throw new KeyFormatError('Pubkey must be 44 bytes');
  }
  const prefix = spkiPrefixBytes();
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) {
      throw new KeyFormatError('Wrong SPKI prefix');
    }
  }
  return bytes;
}

export function isValidPubkey(pubkey: string): boolean {
  try {
    validatePubkey(pubkey);
    return true;
  } catch {
    return false;
  }
}

export function validateSigBytes(sig: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = b64DecodeStrict(sig);
  } catch {
    throw new KeyFormatError('Signature is not strict Base64');
  }
  if (bytes.length !== 64) {
    throw new KeyFormatError('Signature must be 64 bytes');
  }
  return bytes;
}

async function importVerifyKey(port: CryptoPort, pubkey: Pubkey): Promise<CryptoKey> {
  const der = validatePubkey(pubkey);
  return port.subtle.importKey(
    'spki',
    der as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
}

/** Note: browser verification is not RFC 8032 strict. */
export async function verifySignature(
  port: CryptoPort,
  pubkey: Pubkey,
  message: Uint8Array,
  sig: Sig,
): Promise<boolean> {
  let sigBytes: Uint8Array;
  try {
    sigBytes = validateSigBytes(sig);
  } catch {
    return false;
  }
  try {
    const key = await importVerifyKey(port, pubkey);
    return await port.subtle.verify(
      'Ed25519',
      key,
      sigBytes as unknown as ArrayBuffer,
      message as unknown as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

export async function signWithPrivateKey(
  port: CryptoPort,
  privateKeyPkcs8Base64: string,
  message: Uint8Array,
): Promise<Sig> {
  let pkcs8: Uint8Array;
  try {
    pkcs8 = b64DecodeStrict(privateKeyPkcs8Base64);
  } catch {
    throw new KeyFormatError('Private key is not strict Base64');
  }
  const key = await port.subtle.importKey(
    'pkcs8',
    pkcs8 as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  const raw = await port.subtle.sign('Ed25519', key, message as unknown as ArrayBuffer);
  return b64Encode(new Uint8Array(raw));
}

export interface GeneratedKeyPair {
  publicKey: Pubkey;
  privateKeyPkcs8: string;
}

export async function generateKeyPair(port: CryptoPort): Promise<GeneratedKeyPair> {
  const pair = await port.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]);
  const spki = await port.subtle.exportKey('spki', pair.publicKey);
  const pkcs8 = await port.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    publicKey: b64Encode(new Uint8Array(spki)),
    privateKeyPkcs8: b64Encode(new Uint8Array(pkcs8)),
  };
}

/** Imports a private key with extractable:false (signing only). */
export async function importNonExtractablePrivate(
  port: CryptoPort,
  pkcs8Base64: string,
): Promise<CryptoKey> {
  const pkcs8 = b64DecodeStrict(pkcs8Base64);
  return port.subtle.importKey(
    'pkcs8',
    pkcs8 as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
}

export async function signWithNonExtractable(
  port: CryptoPort,
  key: CryptoKey,
  message: Uint8Array,
): Promise<Sig> {
  const raw = await port.subtle.sign('Ed25519', key, message as unknown as ArrayBuffer);
  return b64Encode(new Uint8Array(raw));
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

export async function eventHash(port: CryptoPort, event: SignedEvent): Promise<Hash> {
  const text = canonical(event);
  return sha256HexUtf8(port, text);
}

export async function receiptHash(port: CryptoPort, receipt: Receipt): Promise<Hash> {
  const text = canonical(receipt);
  return sha256HexUtf8(port, text);
}

export async function relayKeyId(port: CryptoPort, pubkey: Pubkey): Promise<Hash> {
  return sha256HexUtf8(port, pubkey);
}

// ---------------------------------------------------------------------------
// Signatures for events / receipts / attestations
// ---------------------------------------------------------------------------

export const RECEIPT_FIELDS = [
  'acceptedAt',
  'eventHash',
  'keyId',
  'previousReceiptHash',
  'sequence',
  'signature',
] as const;

export function checkReceiptShape(receipt: Receipt): void {
  const obj = receipt as unknown as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expected = [...RECEIPT_FIELDS].sort();
  if (keys.length !== expected.length) {
    throw new GuardError(
      'UNKNOWN_FIELD',
      'Receipt has extra or missing fields',
      '$.receipt',
    );
  }
  for (let i = 0; i < expected.length; i++) {
    if (keys[i] !== expected[i]) {
      throw new GuardError(
        'UNKNOWN_FIELD',
        `Unexpected receipt field "${String(keys[i])}"`,
        '$.receipt',
      );
    }
  }
}

function signatureMessage(obj: Record<string, unknown>): Uint8Array {
  const withoutSig = canonicalWithout(obj, 'signature');
  return UTF8_ENCODER.encode(withoutSig);
}

export async function signEvent(
  port: CryptoPort,
  privateKeyPkcs8: string,
  event: Omit<SignedEvent, 'signature'>,
): Promise<SignedEvent> {
  const msg = signatureMessage(event as unknown as Record<string, unknown>);
  const signature = await signWithPrivateKey(port, privateKeyPkcs8, msg);
  return { ...event, signature };
}

export async function signEventWithKey(
  port: CryptoPort,
  key: CryptoKey,
  event: Omit<SignedEvent, 'signature'>,
): Promise<SignedEvent> {
  const msg = signatureMessage(event as unknown as Record<string, unknown>);
  const signature = await signWithNonExtractable(port, key, msg);
  return { ...event, signature };
}

export async function verifyEvent(
  port: CryptoPort,
  event: SignedEvent,
): Promise<boolean> {
  const msg = signatureMessage(event as unknown as Record<string, unknown>);
  return verifySignature(port, event.signer, msg, event.signature);
}

export async function signReceipt(
  port: CryptoPort,
  privateKeyPkcs8: string,
  receipt: Omit<Receipt, 'signature'>,
): Promise<Receipt> {
  const msg = signatureMessage(receipt as unknown as Record<string, unknown>);
  const signature = await signWithPrivateKey(port, privateKeyPkcs8, msg);
  const full: Receipt = { ...receipt, signature };
  checkReceiptShape(full);
  return full;
}

/**
 * Verifies a receipt signature against the relay pubkey. keyId must already have been
 * determined by the key range (section 4) and is additionally validated here
 * against relayKeyId(relayPubkey).
 */
export async function verifyReceiptWithKeyId(
  port: CryptoPort,
  receipt: Receipt,
  relayPubkey: Pubkey,
  expectedKeyId: Hash,
): Promise<boolean> {
  checkReceiptShape(receipt);
  if (receipt.keyId !== expectedKeyId) {
    return false;
  }
  const msg = signatureMessage(receipt as unknown as Record<string, unknown>);
  return verifySignature(port, relayPubkey, msg, receipt.signature);
}

export async function verifyReceipt(
  port: CryptoPort,
  receipt: Receipt,
  relayPubkey: Pubkey,
): Promise<boolean> {
  const expectedKeyId = await relayKeyId(port, relayPubkey);
  return verifyReceiptWithKeyId(port, receipt, relayPubkey, expectedKeyId);
}

/** Derives the Ed25519 public key (SPKI, Base64) from a PKCS8 key. */
export async function derivePublicKey(
  port: CryptoPort,
  privateKeyPkcs8Base64: string,
): Promise<Pubkey> {
  let pkcs8: Uint8Array;
  try {
    pkcs8 = b64DecodeStrict(privateKeyPkcs8Base64);
  } catch {
    throw new KeyFormatError('Private key is not strict Base64');
  }
  const key = await port.subtle.importKey(
    'pkcs8',
    pkcs8 as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  const jwk = await port.subtle.exportKey('jwk', key);
  const x = typeof jwk.x === 'string' ? jwk.x : '';
  const padded = x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (x.length % 4)) % 4);
  let raw: Uint8Array;
  try {
    raw = b64DecodeStrict(padded);
  } catch {
    throw new KeyFormatError('Public key cannot be derived');
  }
  if (raw.length !== 32) {
    throw new KeyFormatError('Public key has wrong length');
  }
  const prefix = spkiPrefixBytes();
  const spki = new Uint8Array(prefix.length + raw.length);
  spki.set(prefix, 0);
  spki.set(raw, prefix.length);
  return b64Encode(spki);
}

export type AttestationKind = 'deal-consent' | 'jury-vote' | 'checkpoint';

export function attestationMessage(kind: AttestationKind, body: unknown): Uint8Array {
  const prefix = UTF8_ENCODER.encode('skillx/v1/' + kind + '\n');
  const bodyBytes = UTF8_ENCODER.encode(canonical(body));
  const out = new Uint8Array(prefix.length + bodyBytes.length);
  out.set(prefix, 0);
  out.set(bodyBytes, prefix.length);
  return out;
}

export async function signAttestation(
  port: CryptoPort,
  privateKeyPkcs8: string,
  kind: AttestationKind,
  body: unknown,
): Promise<Sig> {
  return signWithPrivateKey(port, privateKeyPkcs8, attestationMessage(kind, body));
}

export async function signAttestationWithKey(
  port: CryptoPort,
  key: CryptoKey,
  kind: AttestationKind,
  body: unknown,
): Promise<Sig> {
  return signWithNonExtractable(port, key, attestationMessage(kind, body));
}

export async function verifyAttestation(
  port: CryptoPort,
  pubkey: Pubkey,
  kind: AttestationKind,
  body: unknown,
  sig: Sig,
): Promise<boolean> {
  return verifySignature(port, pubkey, attestationMessage(kind, body), sig);
}
