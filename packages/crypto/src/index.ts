import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { EventCore, EventType, Hash, Receipt, SignedEvent } from '../../domain/src/protocol.js';

const MAX_DEPTH = 64;
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

function assertUnicode(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Unpaired surrogate');
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError('Unpaired surrogate');
  }
}

function encode(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) throw new TypeError('Canonical depth exceeded');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { assertUnicode(value); return JSON.stringify(value); }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('Canonical numbers must be safe integers');
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Canonical cycle');
    seen.add(value);
    const values = Array.from({ length: value.length }, (_, i) => {
      if (!Object.hasOwn(value, i)) throw new TypeError('Sparse arrays are not canonical');
      return encode(value[i], depth + 1, seen);
    });
    seen.delete(value);
    return `[${values.join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('Only plain objects are canonical');
    if (seen.has(value)) throw new TypeError('Canonical cycle');
    seen.add(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) throw new TypeError('Symbol keys are not canonical');
    const record = value as Record<string, unknown>;
    const keys = (ownKeys as string[]).sort();
    const fields = keys.map((key) => {
      assertUnicode(key);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new TypeError('Forbidden object key');
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Only enumerable data properties are canonical');
      return `${JSON.stringify(key)}:${encode(record[key], depth + 1, seen)}`;
    });
    seen.delete(value);
    return `{${fields.join(',')}}`;
  }
  throw new TypeError('Unsupported canonical value');
}

/** Serialize a JSON-compatible protocol value with the Core Schema v1 rules. */
export function canonical(value: unknown): string { return encode(value, 0, new Set()); }
/** SHA-256 a string as raw UTF-8 or an object as canonical JSON. */
export function hash(value: unknown): Hash { return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex'); }
/** SHA-256 raw content bytes. */
export function contentHash(bytes: Uint8Array): Hash { return createHash('sha256').update(bytes).digest('hex'); }

function strictBase64(encoded: string): Buffer {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new TypeError('Invalid base64');
  return bytes;
}
function publicKey(encoded: string) {
  const der = strictBase64(encoded);
  if (der.length !== 44 || der.subarray(0, 12).toString('hex') !== ED25519_SPKI_PREFIX) throw new TypeError('Expected Ed25519 SPKI key');
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}
function privateKey(encoded: string) {
  const der = strictBase64(encoded);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Expected Ed25519 PKCS8 key');
  return key;
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
  const signature = sign(null, Buffer.from(canonical(core), 'utf8'), privateKey(key)).toString('base64');
  return { ...core, signature } as SignedEvent<T>;
}
/** Verify an event without throwing for malformed or hostile input. */
export function verifyEvent(event: SignedEvent): boolean {
  try {
    const { signature, ...core } = event;
    const sig = strictBase64(signature);
    return sig.length === 64 && verify(null, Buffer.from(canonical(core), 'utf8'), publicKey(event.signer), sig);
  } catch { return false; }
}
/** Hash the complete signed event. */
export function eventHash(event: SignedEvent): Hash { return hash(event); }
/** Sign receipt fields, excluding the signature. */
export function signReceipt(core: Omit<Receipt, 'signature'>, key: string): Receipt {
  return { ...core, signature: sign(null, Buffer.from(canonical(core), 'utf8'), privateKey(key)).toString('base64') };
}
/** Verify a receipt against the relay's pinned Ed25519 public key. */
export function verifyReceipt(receipt: Receipt, key: string): boolean {
  try {
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return false;
    if (Object.keys(receipt).sort().join(',') !== 'acceptedAt,eventHash,previousReceiptHash,sequence,signature') return false;
    if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) return false;
    if (!/^[a-f0-9]{64}$/.test(receipt.eventHash)) return false;
    if (receipt.previousReceiptHash !== null && !/^[a-f0-9]{64}$/.test(receipt.previousReceiptHash)) return false;
    if (typeof receipt.acceptedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.acceptedAt)
      || !Number.isFinite(Date.parse(receipt.acceptedAt)) || new Date(receipt.acceptedAt).toISOString() !== receipt.acceptedAt) return false;
    const { signature, ...core } = receipt;
    const sig = strictBase64(signature);
    return sig.length === 64 && verify(null, Buffer.from(canonical(core), 'utf8'), publicKey(key), sig);
  } catch { return false; }
}
/** Sign a domain-separated attestation body. */
export function signAttestation(kind: string, body: unknown, key: string): string {
  const prefix = Buffer.from(`skillx/v1/${kind}\n`, 'utf8');
  const message = Buffer.concat([prefix, Buffer.from(canonical(body), 'utf8')]);
  return sign(null, message, privateKey(key)).toString('base64');
}
/** Verify a domain-separated attestation without throwing on untrusted input. */
export function verifyAttestation(kind: string, body: unknown, signature: string, key: string): boolean {
  try {
    const sig = strictBase64(signature);
    if (sig.length !== 64) return false;
    const message = Buffer.concat([Buffer.from(`skillx/v1/${kind}\n`, 'utf8'), Buffer.from(canonical(body), 'utf8')]);
    return verify(null, message, publicKey(key), sig);
  } catch { return false; }
}
