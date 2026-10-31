import { createHash } from 'node:crypto';
import { b64Decode } from './b64.js';
import type { JsonObject } from './canonical.js';

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TOO_LARGE'
  | 'RATE_LIMITED'
  | 'METHOD_NOT_ALLOWED';

export function statusFor(code: ErrorCode): number {
  switch (code) {
    case 'BAD_REQUEST':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'NOT_FOUND':
      return 404;
    case 'METHOD_NOT_ALLOWED':
      return 405;
    case 'CONFLICT':
      return 409;
    case 'TOO_LARGE':
      return 413;
    case 'RATE_LIMITED':
      return 429;
    default: {
      const neverCode: never = code;
      throw new Error('unreachable status code: ' + String(neverCode));
    }
  }
}

export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export interface KeyBundle {
  v: 1;
  identity_pubkey: string;
  x_pubkey: string;
  created_at: string;
  sig: string;
}

export interface Envelope {
  v: 1;
  eph_pub: string;
  iv: string;
  ct: string;
}

export interface StoredMessage {
  seq: number;
  id: string;
  envelope: Envelope;
  stored_at: number;
}

export interface AuthHeader {
  pubkey: string;
  ts: number;
  sig: string;
}

export const MAILBOX_ID_RE = /^[0-9a-f]{64}$/;
export const MESSAGE_ID_RE = /^[0-9a-f]{32}$/;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

export function isValidIso(value: string): boolean {
  const match = ISO_RE.exec(value);
  if (match === null) {
    return false;
  }
  const month = Number(match[2] ?? '');
  const day = Number(match[3] ?? '');
  const hour = Number(match[4] ?? '');
  const minute = Number(match[5] ?? '');
  const second = Number(match[6] ?? '');
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return false;
  }
  const year = Number(match[1] ?? '');
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!Number.isInteger(day) || day < 1 || day > (monthDays[month - 1] ?? 0)) {
    return false;
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return false;
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return false;
  }
  if (!Number.isInteger(second) || second < 0 || second > 59) {
    return false;
  }
  return true;
}

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError('BAD_REQUEST', 'expected object');
  }
  return value as Record<string, unknown>;
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ApiError('BAD_REQUEST', 'unexpected field');
    }
  }
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new ApiError('BAD_REQUEST', 'invalid field');
  }
  return value;
}

function requireVersion(obj: Record<string, unknown>): 1 {
  if (obj['v'] !== 1) {
    throw new ApiError('BAD_REQUEST', 'invalid version');
  }
  return 1;
}

function decodeExact(text: string, expectedLength: number): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = b64Decode(text);
  } catch {
    throw new ApiError('BAD_REQUEST', 'invalid base64');
  }
  if (bytes.length !== expectedLength) {
    throw new ApiError('BAD_REQUEST', 'invalid length');
  }
  return bytes;
}

function decodeMin(text: string, minLength: number): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = b64Decode(text);
  } catch {
    throw new ApiError('BAD_REQUEST', 'invalid base64');
  }
  if (bytes.length < minLength) {
    throw new ApiError('BAD_REQUEST', 'invalid length');
  }
  return bytes;
}

const ED25519_SPKI_PREFIX: Uint8Array = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

export function validateIdentityPubkey(value: string): Uint8Array {
  const bytes = decodeExact(value, 44);
  for (let i = 0; i < ED25519_SPKI_PREFIX.length; i++) {
    if (bytes[i] !== ED25519_SPKI_PREFIX[i]) {
      throw new ApiError('BAD_REQUEST', 'invalid identity key');
    }
  }
  return bytes;
}

export function mailboxIdOf(identityPubkeyB64: string): string {
  const bytes = validateIdentityPubkey(identityPubkeyB64);
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseKeyBundle(input: unknown): KeyBundle {
  const obj = asObject(input);
  onlyKeys(obj, ['v', 'identity_pubkey', 'x_pubkey', 'created_at', 'sig']);
  requireVersion(obj);
  const identityPubkey = requireString(obj, 'identity_pubkey');
  validateIdentityPubkey(identityPubkey);
  const xPubkey = requireString(obj, 'x_pubkey');
  decodeExact(xPubkey, 32);
  const createdAt = requireString(obj, 'created_at');
  if (!isValidIso(createdAt)) {
    throw new ApiError('BAD_REQUEST', 'invalid created_at');
  }
  const sig = requireString(obj, 'sig');
  decodeExact(sig, 64);
  return {
    v: 1,
    identity_pubkey: identityPubkey,
    x_pubkey: xPubkey,
    created_at: createdAt,
    sig,
  };
}

export function parseEnvelope(input: unknown): Envelope {
  const obj = asObject(input);
  onlyKeys(obj, ['v', 'eph_pub', 'iv', 'ct']);
  requireVersion(obj);
  const ephPub = requireString(obj, 'eph_pub');
  decodeExact(ephPub, 32);
  const iv = requireString(obj, 'iv');
  decodeExact(iv, 12);
  const ct = requireString(obj, 'ct');
  decodeMin(ct, 16);
  return { v: 1, eph_pub: ephPub, iv, ct };
}

export function parseStoredMessage(input: unknown): StoredMessage {
  const obj = asObject(input);
  onlyKeys(obj, ['seq', 'id', 'envelope', 'stored_at']);
  const seq = obj['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    throw new ApiError('BAD_REQUEST', 'invalid seq');
  }
  const id = requireString(obj, 'id');
  if (!MESSAGE_ID_RE.test(id)) {
    throw new ApiError('BAD_REQUEST', 'invalid message id');
  }
  const envelope = parseEnvelope(obj['envelope']);
  const storedAt = obj['stored_at'];
  if (typeof storedAt !== 'number' || !Number.isSafeInteger(storedAt) || storedAt < 0) {
    throw new ApiError('BAD_REQUEST', 'invalid stored_at');
  }
  return { seq, id, envelope, stored_at: storedAt };
}

export function parseAuthHeader(raw: string): AuthHeader {
  const parts = raw.split('.');
  if (parts.length !== 3) {
    throw new ApiError('UNAUTHORIZED', 'invalid auth header');
  }
  const pubkey = parts[0] ?? '';
  const tsRaw = parts[1] ?? '';
  const sig = parts[2] ?? '';
  try {
    validateIdentityPubkey(pubkey);
  } catch {
    throw new ApiError('UNAUTHORIZED', 'invalid auth key');
  }
  if (!/^[0-9]{1,15}$/.test(tsRaw)) {
    throw new ApiError('UNAUTHORIZED', 'invalid auth timestamp');
  }
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts)) {
    throw new ApiError('UNAUTHORIZED', 'invalid auth timestamp');
  }
  try {
    decodeExact(sig, 64);
  } catch {
    throw new ApiError('UNAUTHORIZED', 'invalid auth signature');
  }
  return { pubkey, ts, sig };
}

export function keyBundleBody(bundle: KeyBundle): JsonObject {
  return {
    v: 1,
    identity_pubkey: bundle.identity_pubkey,
    x_pubkey: bundle.x_pubkey,
    created_at: bundle.created_at,
  };
}
