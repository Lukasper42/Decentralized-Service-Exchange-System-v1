import { createHash, createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Ed25519 -> X25519 conversions for key agreement (pure, no randomness).
 * Public key: Montgomery u = (1 + y) / (1 - y) mod 2^255-19 from the Edwards y coordinate.
 * Private key: SHA-512 of the 32-byte seed, first 32 bytes, clamped.
 */
const P = (1n << 255n) - 19n;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

export function edPublicToX25519(edPublic: Uint8Array): Uint8Array {
  if (edPublic.length !== 32) throw new RangeError('Ed25519 public key must be 32 bytes');
  const bytes = Uint8Array.from(edPublic);
  bytes[31] = (bytes[31] ?? 0) & 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(bytes[i] ?? 0);
  const numerator = (1n + y) % P;
  const denominator = (((1n - y) % P) + P) % P;
  if (denominator === 0n) throw new RangeError('Ed25519 public key maps to the point at infinity');
  let u = (numerator * modPow(denominator, P - 2n, P)) % P;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) { out[i] = Number(u & 0xffn); u >>= 8n; }
  return out;
}

export function edSeedToX25519Scalar(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new RangeError('Ed25519 seed must be 32 bytes');
  const digest = createHash('sha512').update(seed).digest();
  const scalar = Uint8Array.from(digest.subarray(0, 32));
  scalar[0] = (scalar[0] ?? 0) & 248;
  scalar[31] = ((scalar[31] ?? 0) & 127) | 64;
  return scalar;
}

const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const privateKeyOf = (scalar: Uint8Array): KeyObject => createPrivateKey({ key: Buffer.concat([X_PKCS8, Buffer.from(scalar)]), format: 'der', type: 'pkcs8' });

export function x25519PublicFromScalar(scalar: Uint8Array): Uint8Array {
  const der = createPublicKey(privateKeyOf(scalar)).export({ format: 'der', type: 'spki' });
  return Uint8Array.from(der.subarray(X_SPKI.length));
}

export function x25519SharedSecret(scalar: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  const peer = createPublicKey({ key: Buffer.concat([X_SPKI, Buffer.from(peerPublic)]), format: 'der', type: 'spki' });
  const secret = diffieHellman({ privateKey: privateKeyOf(scalar), publicKey: peer });
  if (secret.every((byte) => byte === 0)) throw new RangeError('X25519 shared secret is all zero');
  return Uint8Array.from(secret);
}
