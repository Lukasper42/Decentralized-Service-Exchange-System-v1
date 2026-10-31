import type { ClockPort, CryptoPort, RandomPort } from './ports.js';
import type { Result } from './types.js';
import { err, ok } from './types.js';
import {
  b64DecodeStrict,
  b64Encode,
  canonical,
  sha256Hex,
  signWithNonExtractable,
  validatePubkey,
  verifySignature
} from './crypto.js';

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

export interface Inner {
  v: 1;
  from: string;
  to: string;
  sent_at: string;
  body: string;
  eph_pub: string;
  sig: string;
}

export interface OpenedMessage {
  from: string;
  sentAt: string;
  body: string;
}

export type AuthMethod = 'GET' | 'DELETE';

const KEY_DOMAIN = 'skillx/v1/mailbox-key\n';
const INNER_DOMAIN = 'skillx/v1/mailbox-inner\n';
const AUTH_DOMAIN = 'skillx/v1/mailbox-auth\n';
const MSG_INFO = 'skillx/v1/mailbox-msg';
const AAD_PREFIX = 'skillx/v1/mailbox-aad\n';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAILBOX_ID_RE = /^[0-9a-f]{64}$/;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as unknown as ArrayBuffer;
}

function isCryptoKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
  return 'privateKey' in value && 'publicKey' in value;
}

function isIso(value: string): boolean {
  return ISO_RE.test(value);
}

function isMailboxId(value: string): boolean {
  return MAILBOX_ID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is Envelope {
  if (!isRecord(value)) return false;
  return (
    value['v'] === 1 &&
    typeof value['eph_pub'] === 'string' &&
    typeof value['iv'] === 'string' &&
    typeof value['ct'] === 'string'
  );
}

function parseInner(value: unknown): Inner | null {
  if (!isRecord(value)) return null;
  if (value['v'] !== 1) return null;
  if (typeof value['from'] !== 'string') return null;
  if (typeof value['to'] !== 'string') return null;
  if (typeof value['sent_at'] !== 'string') return null;
  if (typeof value['body'] !== 'string') return null;
  if (typeof value['eph_pub'] !== 'string') return null;
  if (typeof value['sig'] !== 'string') return null;
  if (!isMailboxId(value['to'])) return null;
  if (!isIso(value['sent_at'])) return null;
  const bodyLen = Array.from(value['body']).length;
  if (bodyLen < 1 || bodyLen > 8000) return null;
  return {
    v: 1,
    from: value['from'],
    to: value['to'],
    sent_at: value['sent_at'],
    body: value['body'],
    eph_pub: value['eph_pub'],
    sig: value['sig']
  };
}

function padToSize(bytes: Uint8Array): Result<Uint8Array> {
  const sizes = [1024, 4096, 16384] as const;
  let target: 1024 | 4096 | 16384 | null = null;
  for (const size of sizes) {
    if (bytes.length <= size) {
      target = size;
      break;
    }
  }
  if (target === null) {
    return err('LIMIT', 'TOO_LARGE', 'mailbox.padding');
  }
  const out = new Uint8Array(target);
  out.fill(0x20);
  out.set(bytes, 0);
  return ok(out);
}

async function deriveShared(
  port: CryptoPort,
  privateKey: CryptoKey,
  publicRaw: Uint8Array
): Promise<ArrayBuffer> {
  const publicKey = await port.subtle.importKey(
    'raw',
    ab(publicRaw),
    { name: 'X25519' },
    false,
    []
  );
  return port.subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256);
}

async function deriveAesKey(
  port: CryptoPort,
  shared: ArrayBuffer,
  usage: KeyUsage
): Promise<CryptoKey> {
  const hkdfKey = await port.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return port.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ab(new Uint8Array(32)),
      info: ab(utf8(MSG_INFO))
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

export async function mailboxId(port: CryptoPort, identityPubkey: string): Promise<string> {
  const spki = validatePubkey(identityPubkey);
  return sha256Hex(port, spki);
}

export async function generateMessagingKey(
  port: CryptoPort
): Promise<{ xPubkey: string; xPrivatePkcs8: string }> {
  const pair = await port.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  if (!isCryptoKeyPair(pair)) {
    throw new Error('X25519 key generation failed');
  }
  const publicRaw = await port.subtle.exportKey('raw', pair.publicKey);
  const privatePkcs8 = await port.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    xPubkey: b64Encode(new Uint8Array(publicRaw)),
    xPrivatePkcs8: b64Encode(new Uint8Array(privatePkcs8))
  };
}

export async function createKeyBundle(
  port: CryptoPort,
  identityPubkey: string,
  edKey: CryptoKey,
  xPubkey: string,
  createdAtIso: string
): Promise<KeyBundle> {
  validatePubkey(identityPubkey);
  const xBytes = b64DecodeStrict(xPubkey);
  if (xBytes.length !== 32) {
    throw new Error('invalid X25519 public key length');
  }
  if (!isIso(createdAtIso)) {
    throw new Error('invalid created_at');
  }
  const unsigned = {
    v: 1 as const,
    identity_pubkey: identityPubkey,
    x_pubkey: xPubkey,
    created_at: createdAtIso
  };
  const message = utf8(KEY_DOMAIN + canonical(unsigned));
  const sig = await signWithNonExtractable(port, edKey, message);
  return { ...unsigned, sig };
}

export async function verifyKeyBundle(port: CryptoPort, bundle: KeyBundle): Promise<boolean> {
  try {
    if (bundle.v !== 1) return false;
    if (typeof bundle.identity_pubkey !== 'string') return false;
    if (typeof bundle.x_pubkey !== 'string') return false;
    if (typeof bundle.created_at !== 'string') return false;
    if (typeof bundle.sig !== 'string') return false;
    if (!isIso(bundle.created_at)) return false;
    const xBytes = b64DecodeStrict(bundle.x_pubkey);
    if (xBytes.length !== 32) return false;
    validatePubkey(bundle.identity_pubkey);
    const unsigned = {
      v: 1,
      identity_pubkey: bundle.identity_pubkey,
      x_pubkey: bundle.x_pubkey,
      created_at: bundle.created_at
    };
    const message = utf8(KEY_DOMAIN + canonical(unsigned));
    return await verifySignature(port, bundle.identity_pubkey, message, bundle.sig);
  } catch {
    return false;
  }
}

export async function sealMessage(
  port: CryptoPort,
  random: RandomPort,
  clock: ClockPort,
  input: {
    from: string;
    edKey: CryptoKey;
    recipientBundle: KeyBundle;
    body: string;
  }
): Promise<Result<Envelope>> {
  try {
    validatePubkey(input.from);
    const bodyLen = Array.from(input.body).length;
    if (bodyLen < 1) {
      return err('FIELD_FORMAT', 'body empty', 'mailbox.seal.body');
    }
    if (bodyLen > 8000) {
      return err('LIMIT', 'body too long', 'mailbox.seal.body');
    }
    if (!(await verifyKeyBundle(port, input.recipientBundle))) {
      return err('SIGNING', 'invalid recipient key bundle', 'mailbox.seal.bundle');
    }
    const recipientMailboxId = await mailboxId(port, input.recipientBundle.identity_pubkey);
    const recipientX = b64DecodeStrict(input.recipientBundle.x_pubkey);
    if (recipientX.length !== 32) {
      return err('FIELD_FORMAT', 'invalid recipient x_pubkey', 'mailbox.seal.bundle');
    }

    const eph = await port.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    if (!isCryptoKeyPair(eph)) {
      return err('ENVELOPE', 'ephemeral key generation failed', 'mailbox.seal');
    }
    const ephPubRaw = new Uint8Array(await port.subtle.exportKey('raw', eph.publicKey));
    const ephPub = b64Encode(ephPubRaw);

    const unsigned = {
      v: 1 as const,
      from: input.from,
      to: recipientMailboxId,
      sent_at: clock.nowIso(),
      body: input.body,
      eph_pub: ephPub
    };
    const innerMessage = utf8(INNER_DOMAIN + canonical(unsigned));
    const sig = await signWithNonExtractable(port, input.edKey, innerMessage);
    const inner: Inner = { ...unsigned, sig };

    const paddedResult = padToSize(utf8(canonical(inner)));
    if (!paddedResult.ok) return paddedResult;

    const shared = await deriveShared(port, eph.privateKey, recipientX);
    const aesKey = await deriveAesKey(port, shared, 'encrypt');
    const iv = random.bytes(12);
    if (iv.length !== 12) {
      return err('ENVELOPE', 'invalid iv length', 'mailbox.seal.iv');
    }
    const aad = utf8(AAD_PREFIX + recipientMailboxId);
    const ct = await port.subtle.encrypt(
      { name: 'AES-GCM', iv: ab(iv), additionalData: ab(aad) },
      aesKey,
      ab(paddedResult.value)
    );
    return ok({
      v: 1,
      eph_pub: ephPub,
      iv: b64Encode(iv),
      ct: b64Encode(new Uint8Array(ct))
    });
  } catch {
    return err('ENVELOPE', 'seal failed', 'mailbox.seal');
  }
}

export async function openMessage(
  port: CryptoPort,
  myMailboxId: string,
  myXPrivatePkcs8: string,
  envelope: Envelope
): Promise<Result<OpenedMessage>> {
  try {
    if (!isMailboxId(myMailboxId)) {
      return err('FIELD_FORMAT', 'invalid mailbox id', 'mailbox.open.mailbox');
    }
    if (!isEnvelope(envelope)) {
      return err('ENVELOPE', 'invalid envelope', 'mailbox.open.envelope');
    }
    const iv = b64DecodeStrict(envelope.iv);
    if (iv.length !== 12) {
      return err('ENVELOPE', 'invalid iv length', 'mailbox.open.iv');
    }
    const ct = b64DecodeStrict(envelope.ct);
    const ephPubRaw = b64DecodeStrict(envelope.eph_pub);
    if (ephPubRaw.length !== 32) {
      return err('ENVELOPE', 'invalid eph_pub length', 'mailbox.open.eph_pub');
    }
    const privateKey = await port.subtle.importKey(
      'pkcs8',
      ab(b64DecodeStrict(myXPrivatePkcs8)),
      { name: 'X25519' },
      false,
      ['deriveBits']
    );
    const shared = await deriveShared(port, privateKey, ephPubRaw);
    const aesKey = await deriveAesKey(port, shared, 'decrypt');
    const aad = utf8(AAD_PREFIX + myMailboxId);
    const plaintext = await port.subtle.decrypt(
      { name: 'AES-GCM', iv: ab(iv), additionalData: ab(aad) },
      aesKey,
      ab(ct)
    );
    const bytes = new Uint8Array(plaintext);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0x20) {
      end -= 1;
    }
    const json = new TextDecoder().decode(bytes.subarray(0, end));
    const parsed: unknown = JSON.parse(json);
    const inner = parseInner(parsed);
    if (inner === null) {
      return err('ENVELOPE', 'invalid inner', 'mailbox.open.inner');
    }
    if (inner.to !== myMailboxId) {
      return err('ENVELOPE', 'recipient mismatch', 'mailbox.open.to');
    }
    if (inner.eph_pub !== envelope.eph_pub) {
      return err('ENVELOPE', 'ephemeral key mismatch', 'mailbox.open.eph_pub');
    }
    const unsigned = {
      v: 1 as const,
      from: inner.from,
      to: inner.to,
      sent_at: inner.sent_at,
      body: inner.body,
      eph_pub: inner.eph_pub
    };
    const message = utf8(INNER_DOMAIN + canonical(unsigned));
    const valid = await verifySignature(port, inner.from, message, inner.sig);
    if (!valid) {
      return err('SIGNING', 'invalid inner signature', 'mailbox.open.sig');
    }
    return ok({ from: inner.from, sentAt: inner.sent_at, body: inner.body });
  } catch {
    return err('ENVELOPE', 'open failed', 'mailbox.open');
  }
}

export async function buildAuthHeader(
  port: CryptoPort,
  identityPubkey: string,
  edKey: CryptoKey,
  method: AuthMethod,
  path: string,
  nowSeconds: number
): Promise<string> {
  validatePubkey(identityPubkey);
  if (!Number.isSafeInteger(nowSeconds)) {
    throw new Error('invalid timestamp');
  }
  const body = { method, path, ts: nowSeconds };
  const message = utf8(AUTH_DOMAIN + canonical(body));
  const sig = await signWithNonExtractable(port, edKey, message);
  return `${identityPubkey}.${nowSeconds}.${sig}`;
}

const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20
]);
const SEED_DOMAIN = 'skillx/v1/mailbox-x25519-seed\n';
const SEED_INFO = 'skillx/v1/mailbox-x25519';

/**
 * Leitet den X25519-Nachrichtenschlüssel deterministisch aus der Ed25519-Identität ab
 * (Ed25519-Signaturen sind deterministisch). Damit ist nichts zusätzlich zu speichern,
 * und der Schlüssel ist auf jedem Gerät mit derselben Identität wiederherstellbar.
 */
export async function deriveMessagingKey(
  port: CryptoPort,
  edKey: CryptoKey
): Promise<Result<{ xPubkey: string; xPrivatePkcs8: string }>> {
  try {
    const message = utf8(SEED_DOMAIN);
    const first = await signWithNonExtractable(port, edKey, message);
    const second = await signWithNonExtractable(port, edKey, message);
    if (first !== second) {
      return err('SIGNING', 'signing is not deterministic', 'mailbox.derive');
    }
    const hkdfKey = await port.subtle.importKey('raw', ab(b64DecodeStrict(first)), 'HKDF', false, [
      'deriveBits'
    ]);
    const seed = new Uint8Array(
      await port.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: ab(new Uint8Array(32)), info: ab(utf8(SEED_INFO)) },
        hkdfKey,
        256
      )
    );
    const pkcs8 = new Uint8Array(X25519_PKCS8_PREFIX.length + 32);
    pkcs8.set(X25519_PKCS8_PREFIX, 0);
    pkcs8.set(seed, X25519_PKCS8_PREFIX.length);
    const priv = await port.subtle.importKey('pkcs8', ab(pkcs8), { name: 'X25519' }, true, [
      'deriveBits'
    ]);
    const jwk = await port.subtle.exportKey('jwk', priv);
    const x = typeof jwk.x === 'string' ? jwk.x : '';
    const padded = x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (x.length % 4)) % 4);
    const raw = b64DecodeStrict(padded);
    if (raw.length !== 32) {
      return err('SIGNING', 'invalid derived public key', 'mailbox.derive');
    }
    return ok({ xPubkey: b64Encode(raw), xPrivatePkcs8: b64Encode(pkcs8) });
  } catch {
    return err('SIGNING', 'derive failed', 'mailbox.derive');
  }
}
