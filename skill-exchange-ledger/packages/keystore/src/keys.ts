import { createPrivateKey, createPublicKey } from 'node:crypto';
import { KeystoreError } from './errors.js';
import { wipe } from './bytes.js';

/** PKCS#8 DER prefix of a raw Ed25519 seed; the 32-byte seed follows. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export interface KeyPairB64 { privateKey: string; publicKey: string }

/**
 * Wire-format key pair (PKCS8 / SPKI DER, Base64) from a raw 32-byte Ed25519 seed.
 * NOTE: the Base64 private key is a JavaScript string and cannot be wiped; callers keep it only for one signature.
 */
export function keyPairFromSeed(seed32: Uint8Array): KeyPairB64 {
  if (seed32.length !== 32) throw new KeystoreError('E_BAD_INPUT', 'Ed25519 seed must be 32 bytes');
  const der = Buffer.concat([PKCS8_PREFIX, seed32]);
  try {
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return { privateKey: der.toString('base64'), publicKey: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') };
  } finally { wipe(der); }
}
