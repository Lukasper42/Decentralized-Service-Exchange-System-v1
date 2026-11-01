import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonical,
  CanonicalError,
  eventHash,
  receiptHash,
  relayKeyId,
  generateKeyPair,
  signEvent,
  verifyEvent,
  signAttestation,
  verifyAttestation,
  attestationMessage,
  b64DecodeStrict,
  b64Encode,
  isValidPubkey,
} from '../crypto.js';
import type { CryptoPort } from '../ports.js';
import type { Receipt, SignedEvent } from '../types.js';

const port: CryptoPort = { subtle: globalThis.crypto.subtle };

async function sha256Utf8Ref(s: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

test('canonical sorts keys (also nested)', () => {
  assert.equal(
    canonical({ b: 1, a: { d: [1, 2], c: 'x' } }),
    '{"a":{"c":"x","d":[1,2]},"b":1}',
  );
  assert.equal(canonical(null), 'null');
  assert.equal(canonical(true), 'true');
  assert.equal(canonical([1, 2, 3]), '[1,2,3]');
  assert.equal(canonical({}), '{}');
});

test('canonical errors on float, -0, undefined, forbidden keys, cycle', () => {
  assert.throws(() => canonical(1.5), CanonicalError);
  assert.throws(() => canonical(-0), CanonicalError);
  assert.throws(() => canonical(undefined), CanonicalError);
  assert.throws(() => canonical({ constructor: 1 }), CanonicalError);
  assert.throws(() => canonical({ prototype: 1 }), CanonicalError);
  const cyc: Record<string, unknown> = {};
  cyc['self'] = cyc;
  assert.throws(() => canonical(cyc), CanonicalError);
  assert.throws(() => canonical([1, , 2] as unknown[]), CanonicalError);
});

test('Ed25519 roundtrip, tampered message, wrong length', async () => {
  const kp = await generateKeyPair(port);
  assert.ok(isValidPubkey(kp.publicKey));
  const unsigned: Omit<SignedEvent, 'signature'> = {
    type: 'DealCreated',
    version: 1,
    payload: { deal_id: 'd1' },
    signer: kp.publicKey,
    timestamp: '2026-01-01T00:00:00.000Z',
    prevHash: null,
  };
  const signed = await signEvent(port, kp.privateKeyPkcs8, unsigned);
  assert.ok(await verifyEvent(port, signed));
  assert.ok(!(await verifyEvent(port, { ...signed, payload: { deal_id: 'd2' } })));
  const sigBytes = b64DecodeStrict(signed.signature);
  assert.equal(sigBytes.length, 64);
  sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;
  assert.ok(!(await verifyEvent(port, { ...signed, signature: b64Encode(sigBytes) })));
  assert.ok(!(await verifyEvent(port, { ...signed, signature: 'AAAA' })));
  assert.throws(() => b64DecodeStrict('###'), Error);
});

test('Attestation with domain prefix (kinds are separate)', async () => {
  const kp = await generateKeyPair(port);
  const body = { deal_id: 'd1' };
  const msg = attestationMessage('deal-consent', body);
  const text = new TextDecoder().decode(msg);
  assert.ok(text.startsWith('skillx/v1/deal-consent\n'));
  const sig = await signAttestation(port, kp.privateKeyPkcs8, 'deal-consent', body);
  assert.ok(await verifyAttestation(port, kp.publicKey, 'deal-consent', body, sig));
  assert.ok(!(await verifyAttestation(port, kp.publicKey, 'jury-vote', body, sig)));
  assert.ok(!(await verifyAttestation(port, kp.publicKey, 'checkpoint', body, sig)));
});

test('eventHash/receiptHash stable (reference from own computation)', async () => {
  const kp = await generateKeyPair(port);
  const event = await signEvent(port, kp.privateKeyPkcs8, {
    type: 'FeeBurned',
    version: 1,
    payload: { deal_id: 'x', amount: 1 },
    signer: kp.publicKey,
    timestamp: '2026-01-01T00:00:00.000Z',
    prevHash: null,
  });
  const h1 = await eventHash(port, event);
  const h2 = await eventHash(port, JSON.parse(JSON.stringify(event)) as SignedEvent);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  const receipt: Receipt = {
    sequence: 1,
    eventHash: h1,
    previousReceiptHash: null,
    acceptedAt: '2026-01-01T00:00:01.000Z',
    keyId: await relayKeyId(port, kp.publicKey),
    signature: event.signature,
  };
  const r1 = await receiptHash(port, receipt);
  const r2 = await receiptHash(port, JSON.parse(JSON.stringify(receipt)) as Receipt);
  assert.equal(r1, r2);
  assert.match(r1, /^[0-9a-f]{64}$/);
  assert.notEqual(r1, await receiptHash(port, { ...receipt, sequence: 2 }));
  assert.equal(await relayKeyId(port, kp.publicKey), await sha256Utf8Ref(kp.publicKey));
});
