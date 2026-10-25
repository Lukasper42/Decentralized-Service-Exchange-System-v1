import { createCipheriv, createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import type { Pubkey } from '../../domain/src/protocol.js';
import { edPublicToX25519, edSeedToX25519Scalar, x25519SharedSecret } from '../../crypto/src/x25519.js';
import { ContentError } from './errors.js';

/**
 * Wire format "CTP1": magic(4) | sender Ed25519 pub (32) | recipient Ed25519 pub (32) | nonce (12) | ciphertext | tag (16).
 * AAD = the first 80 bytes. Key = HKDF-SHA256(X25519 shared secret, salt = SHA-256("content-transport-v1:salt:" || sender || recipient),
 * info = "content-transport-v1:aead", 32). AEAD = ChaCha20-Poly1305 with the 12-byte injected nonce.
 */
const MAGIC = Buffer.from('CTP1', 'ascii');
const HEADER = 80;
const TAG = 16;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** What the transport needs from an identity: its public key and the X25519 shared secret with a peer. A Keystore provides it without exposing its seed. */
export interface KeyAgreement { readonly publicKey: Pubkey; sharedSecretWith(peerPublicKey: string): { ok: true; value: Uint8Array } | { ok: false; message: string } }
/** Key agreement from a raw Ed25519 seed (tests and tooling only; production code uses the Keystore). */
export function keyAgreementFromSeed(seed32: Uint8Array, publicKey: Pubkey): KeyAgreement {
  return {
    publicKey,
    sharedSecretWith(peer) {
      const raw = rawPublic(peer);
      if (raw === null) return { ok: false, message: 'peer key' };
      return { ok: true, value: x25519SharedSecret(edSeedToX25519Scalar(seed32), edPublicToX25519(raw)) };
    },
  };
}
function rawPublic(spkiBase64: string): Buffer | null {
  const der = Buffer.from(spkiBase64, 'base64');
  return der.toString('base64') === spkiBase64 && der.length === 44 && der.subarray(0, 12).equals(SPKI_PREFIX) ? der.subarray(12) : null;
}
function transportKey(shared: Uint8Array, sender: Buffer, recipient: Buffer): Buffer {
  const salt = createHash('sha256').update('content-transport-v1:salt:').update(sender).update(recipient).digest();
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('content-transport-v1:aead', 'utf8'), 32));
}

/** Encrypt `plaintext` from `sender` to `recipientPublicKey`. `nonce` (12 bytes) must come from an injected entropy source, never reused per key pair. */
export function seal(args: { sender: KeyAgreement; recipientPublicKey: Pubkey; plaintext: Uint8Array; nonce: Uint8Array }): Buffer {
  if (args.nonce.length !== 12) throw new ContentError('BAD_INPUT', 'nonce must be 12 bytes');
  const senderRaw = rawPublic(args.sender.publicKey);
  const recipientRaw = rawPublic(args.recipientPublicKey);
  if (senderRaw === null || recipientRaw === null) throw new ContentError('BAD_INPUT', 'public key');
  const shared = args.sender.sharedSecretWith(args.recipientPublicKey);
  if (!shared.ok) throw new ContentError('BAD_INPUT', shared.message);
  const key = transportKey(shared.value, senderRaw, recipientRaw);
  const nonce = Buffer.from(args.nonce);
  const head = Buffer.concat([MAGIC, senderRaw, recipientRaw, nonce]);
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  cipher.setAAD(head, { plaintextLength: args.plaintext.length });
  const body = Buffer.concat([cipher.update(args.plaintext), cipher.final()]);
  return Buffer.concat([head, body, cipher.getAuthTag()]);
}
/** Decrypt an envelope addressed to `recipient`. Returns the sender's public key with the plaintext. */
export function open(args: { recipient: KeyAgreement; envelope: Uint8Array }): { plaintext: Buffer; senderPublicKey: Pubkey } {
  const env = Buffer.from(args.envelope);
  if (env.length < HEADER + TAG || !env.subarray(0, 4).equals(MAGIC)) throw new ContentError('ENVELOPE_FORMAT');
  const senderRaw = env.subarray(4, 36);
  const recipientRaw = env.subarray(36, 68);
  const own = rawPublic(args.recipient.publicKey);
  if (own === null || !recipientRaw.equals(own)) throw new ContentError('DECRYPT_FAILED', 'not addressed to this recipient');
  const senderPublicKey = Buffer.concat([SPKI_PREFIX, senderRaw]).toString('base64');
  const shared = args.recipient.sharedSecretWith(senderPublicKey);
  if (!shared.ok) throw new ContentError('DECRYPT_FAILED');
  const decipher = createDecipheriv('chacha20-poly1305', transportKey(shared.value, senderRaw, recipientRaw), env.subarray(68, 80), { authTagLength: TAG });
  decipher.setAAD(env.subarray(0, HEADER), { plaintextLength: env.length - HEADER - TAG });
  decipher.setAuthTag(env.subarray(env.length - TAG));
  try { return { plaintext: Buffer.concat([decipher.update(env.subarray(HEADER, env.length - TAG)), decipher.final()]), senderPublicKey }; }
  catch { throw new ContentError('DECRYPT_FAILED'); }
}
