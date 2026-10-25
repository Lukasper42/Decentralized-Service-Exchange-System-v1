import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BASE, BASE_Y, D, IDENTITY, L, P, add, decodePoint, encodePoint, equals, isIdentity, isOnCurve, isSmallOrder, mul, strictEd25519Precheck } from './ed25519-strict.js';
import { canonical, createIdentity, signEvent, strictVerify, verifyEvent } from './index.js';
import type { EventCore } from '../../domain/src/protocol.js';
import { h, iso, T0 } from '../../testing/src/fixtures.js';

const toRaw = (publicKey: string): Uint8Array => Buffer.from(publicKey, 'base64').subarray(12);
const spki = (raw: Uint8Array): string => Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]).toString('base64');
function leBytes(value: bigint, length = 32): Uint8Array {
  const out = new Uint8Array(length); let v = value;
  for (let i = 0; i < length; i += 1) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
function leInt(bytes: Uint8Array): bigint { let v = 0n; for (let i = bytes.length - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(bytes[i] ?? 0); return v; }

/** All eight torsion points, built with the same arithmetic: [L]Q for decodable Q has order dividing 8. */
function torsionPoints(): Uint8Array[] {
  for (let counter = 0; counter < 1000; counter += 1) {
    const digest = createHash('sha256').update(`torsion-${counter}`).digest();
    digest[31] = (digest[31] ?? 0) & 0x7f;
    const q = decodePoint(digest);
    if (q === null) continue;
    const t = mul(q, L);
    if (isSmallOrder(t) && !isIdentity(mul(t, 4n))) return Array.from({ length: 8 }, (_, k) => encodePoint(mul(t, BigInt(k))));
  }
  throw new Error('no order-8 point found');
}

test('curve constants are consistent: B on curve, y = 4/5, [L]B is the identity', () => {
  assert.equal(isOnCurve(BASE), true);
  assert.equal(BASE_Y, 46316835694926478169428394003475163141307993866256225615783033603165251855960n);
  assert.equal(BASE.X % P, 15112221349535400772501151409588531511454012693041857206046113283949847762202n);
  assert.equal(isIdentity(mul(BASE, L)), true);
  assert.equal(isIdentity(mul(BASE, L - 1n)), false);
  assert.equal((D * 121666n + 121665n) % P, 0n);
  assert.equal(equals(add(BASE, IDENTITY), BASE), true);
});

test('a freshly generated key and signature pass the strict pre-check', () => {
  const id = createIdentity();
  const core: EventCore<'AccountCreated'> = { type: 'AccountCreated', version: 1, payload: { pubkey: id.publicKey, recovery_commitment: h('rc'), invite_ref: null }, signer: id.publicKey, timestamp: iso(T0), prevHash: null };
  const event = signEvent(core, id.privateKey);
  assert.equal(strictEd25519Precheck(toRaw(id.publicKey), Buffer.from(event.signature, 'base64')), true);
});

test('A11: S >= L is rejected (signature malleability)', () => {
  const id = createIdentity();
  const core: EventCore<'AccountCreated'> = { type: 'AccountCreated', version: 1, payload: { pubkey: id.publicKey, recovery_commitment: h('rc'), invite_ref: null }, signer: id.publicKey, timestamp: iso(T0), prevHash: null };
  const event = signEvent(core, id.privateKey);
  const sig = Buffer.from(event.signature, 'base64');
  const malleated = Buffer.concat([sig.subarray(0, 32), leBytes(leInt(sig.subarray(32)) + L)]);
  assert.equal(strictEd25519Precheck(toRaw(id.publicKey), malleated), false);
  assert.equal(verifyEvent({ ...event, signature: malleated.toString('base64') }), false);
  assert.equal(strictEd25519Precheck(toRaw(id.publicKey), sig.subarray(0, 63)), false);
});

test('A11: small-order public keys and R values are rejected, all eight torsion points', () => {
  const id = createIdentity();
  const message = Buffer.from(canonical({ m: 1 }));
  const valid = Buffer.from(signEvent({ type: 'AccountCreated', version: 1, payload: { pubkey: id.publicKey, recovery_commitment: h('rc'), invite_ref: null }, signer: id.publicKey, timestamp: iso(T0), prevHash: null }, id.privateKey).signature, 'base64');
  const torsion = torsionPoints();
  assert.equal(new Set(torsion.map((t) => Buffer.from(t).toString('hex'))).size, 8);
  for (const point of torsion) {
    const decoded = decodePoint(point);
    assert.notEqual(decoded, null);
    if (decoded !== null) assert.equal(isSmallOrder(decoded), true);
    assert.equal(strictEd25519Precheck(point, valid), false, 'small-order A');
    assert.equal(strictEd25519Precheck(toRaw(id.publicKey), Buffer.concat([point, valid.subarray(32)])), false, 'small-order R');
    assert.equal(strictVerify(message, Buffer.concat([point, leBytes(0n)]).toString('base64'), spki(point)), false, 'all-small-order forgery');
  }
  assert.equal(isSmallOrder(BASE), false);
});

test('A11: non-canonical encodings and undecodable points are rejected', () => {
  // y = 1 (identity) re-encoded as y + p is non-canonical.
  assert.equal(decodePoint(leBytes(1n)) !== null, true);
  assert.equal(decodePoint(leBytes(1n + P)), null);
  assert.equal(decodePoint(leBytes(P)), null);
  // x = 0 with the sign bit set must fail: identity and (0, -1).
  const identitySigned = leBytes(1n); identitySigned[31] = (identitySigned[31] ?? 0) | 0x80;
  assert.equal(decodePoint(identitySigned), null);
  const minusOneSigned = leBytes(P - 1n); minusOneSigned[31] = (minusOneSigned[31] ?? 0) | 0x80;
  assert.equal(decodePoint(minusOneSigned), null);
  // some y has no square root for x.
  let found = false;
  for (let y = 2n; y < 50n && !found; y += 1n) found = decodePoint(leBytes(y)) === null;
  assert.equal(found, true);
  const id = createIdentity();
  const sig = new Uint8Array(64);
  sig.set(leBytes(1n + P), 0);
  assert.equal(strictEd25519Precheck(toRaw(id.publicKey), sig), false);
  assert.equal(strictEd25519Precheck(leBytes(1n + P), new Uint8Array(64)), false);
  assert.equal(strictEd25519Precheck(new Uint8Array(31), new Uint8Array(64)), false);
});
