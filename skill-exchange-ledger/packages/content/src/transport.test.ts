import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicEntropy, fixedClock, testWordlist } from '../../testing/src/keystore-fixtures.js';
import { RFC7748 } from '../../testing/src/x25519-vectors.js';
import { Keystore } from '../../keystore/src/keystore.js';
import { generateSeedPhrase } from '../../keystore/src/bip39.js';
import { keyPairFromSeed } from '../../keystore/src/keys.js';
import { edPublicToX25519, edSeedToX25519Scalar, x25519PublicFromScalar, x25519SharedSecret } from '../../crypto/src/x25519.js';
import { ContentError, keyAgreementFromSeed, open, seal } from './index.js';
import type { KeyAgreement } from './index.js';

async function keystoreAgreement(label: string): Promise<KeyAgreement> {
  const entropy = deterministicEntropy(label);
  const { seed } = generateSeedPhrase(entropy, testWordlist());
  const { keystore } = await Keystore.create({ seed, passphrase: 'pw-pw-pw-pw', entropy, clock: fixedClock(1), kdf: { N: 1024 } });
  return { publicKey: keystore.identity.accountPublicKey, sharedSecretWith: (peer) => keystore.sharedSecretWith(peer) };
}
function seedAgreement(byte: number): KeyAgreement {
  const seed = Buffer.alloc(32, byte);
  return keyAgreementFromSeed(seed, keyPairFromSeed(seed).publicKey);
}
const nonce = (n: number): Buffer => Buffer.alloc(12, n);
function code(fn: () => unknown): string {
  try { fn(); return 'none'; } catch (error) { return error instanceof ContentError ? error.code : 'other'; }
}

test('Ed25519 -> X25519 conversion is consistent for seed and public key', () => {
  for (const byte of [1, 2, 9, 200]) {
    const seed = Buffer.alloc(32, byte);
    const raw = Buffer.from(keyPairFromSeed(seed).publicKey, 'base64').subarray(12);
    assert.deepEqual(Buffer.from(x25519PublicFromScalar(edSeedToX25519Scalar(seed))), Buffer.from(edPublicToX25519(raw)));
  }
});
test('seal/open roundtrip with raw-seed identities, sender is authenticated by the envelope', () => {
  const a = seedAgreement(1); const b = seedAgreement(2);
  const envelope = seal({ sender: a, recipientPublicKey: b.publicKey, plaintext: Buffer.from('secret deliverable'), nonce: nonce(1) });
  const opened = open({ recipient: b, envelope });
  assert.equal(opened.plaintext.toString(), 'secret deliverable');
  assert.equal(opened.senderPublicKey, a.publicKey);
});
test('seal/open roundtrip between two keystores (seed never leaves the keystore)', async () => {
  const a = await keystoreAgreement('alice'); const b = await keystoreAgreement('bob');
  const envelope = seal({ sender: a, recipientPublicKey: b.publicKey, plaintext: Buffer.from('via keystore'), nonce: nonce(3) });
  assert.equal(open({ recipient: b, envelope }).plaintext.toString(), 'via keystore');
});
test('the wrong recipient cannot decrypt; any bit flip is detected', () => {
  const a = seedAgreement(1); const b = seedAgreement(2); const c = seedAgreement(3);
  const envelope = seal({ sender: a, recipientPublicKey: b.publicKey, plaintext: Buffer.from('x'.repeat(40)), nonce: nonce(1) });
  assert.equal(code(() => open({ recipient: c, envelope })), 'DECRYPT_FAILED');
  for (let i = 0; i < envelope.length; i += 7) {
    const copy = Buffer.from(envelope); copy[i] = (copy[i] ?? 0) ^ 1;
    assert.notEqual(code(() => open({ recipient: b, envelope: copy })), 'none', `flip at ${i}`);
  }
});
test('format errors: short input, wrong magic, bad nonce length', () => {
  const a = seedAgreement(1); const b = seedAgreement(2);
  assert.equal(code(() => open({ recipient: b, envelope: Buffer.alloc(10) })), 'ENVELOPE_FORMAT');
  assert.equal(code(() => open({ recipient: b, envelope: Buffer.alloc(120) })), 'ENVELOPE_FORMAT');
  assert.equal(code(() => seal({ sender: a, recipientPublicKey: b.publicKey, plaintext: Buffer.alloc(1), nonce: Buffer.alloc(8) })), 'BAD_INPUT');
  assert.equal(code(() => seal({ sender: a, recipientPublicKey: 'AAAA', plaintext: Buffer.alloc(1), nonce: nonce(1) })), 'BAD_INPUT');
});
test('different nonces give different ciphertexts; the same inputs are deterministic', () => {
  const a = seedAgreement(1); const b = seedAgreement(2);
  const make = (n: number): Buffer => seal({ sender: a, recipientPublicKey: b.publicKey, plaintext: Buffer.from('same'), nonce: nonce(n) });
  assert.deepEqual(make(1), make(1));
  assert.notDeepEqual(make(1), make(2));
});
test('X25519 matches the RFC 7748 section 6.1 vector', () => {
  const alicePriv = Buffer.from(RFC7748.alicePrivate, 'hex');
  const bobPriv = Buffer.from(RFC7748.bobPrivate, 'hex');
  const bobPub = x25519PublicFromScalar(bobPriv);
  assert.equal(Buffer.from(x25519PublicFromScalar(alicePriv)).toString('hex'), RFC7748.alicePublic);
  assert.equal(Buffer.from(x25519SharedSecret(alicePriv, bobPub)).toString('hex'), RFC7748.shared);
});
