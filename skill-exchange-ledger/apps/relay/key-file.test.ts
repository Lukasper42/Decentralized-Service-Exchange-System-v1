// apps/relay/key-file.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createIdentity, relayKeyId, sha256Hex } from '../../packages/crypto/src/index.js';
import { loadRelayKeySource } from './key-file.js';
import type { KeyFilePort } from './key-file.js';

function filesFor(text: string, mode: number): KeyFilePort {
  return {
    statMode(path: string): number {
      assert.equal(path, 'relay.key');
      return mode;
    },
    readText(path: string): string {
      assert.equal(path, 'relay.key');
      return text;
    },
  };
}

test('valid key file returns the key only for the expected key id', () => {
  const identity = createIdentity();
  const keyId = relayKeyId(identity.publicKey);
  const source = loadRelayKeySource({
    path: 'relay.key',
    files: filesFor(identity.privateKey, 0o600),
    expectedKeyId: keyId,
    expectedPublicKey: identity.publicKey,
    platform: 'linux',
  });

  assert.equal(source.privateKeyFor(keyId), identity.privateKey);
  assert.equal(source.privateKeyFor(sha256Hex('other-key')), null);
});

test('group or other accessible key files are rejected except on win32', () => {
  const identity = createIdentity();
  const keyId = relayKeyId(identity.publicKey);

  assert.throws(
    () =>
      loadRelayKeySource({
        path: 'relay.key',
        files: filesFor(identity.privateKey, 0o644),
        expectedKeyId: keyId,
        expectedPublicKey: identity.publicKey,
        platform: 'linux',
      }),
    /must not be accessible by group or others/,
  );

  assert.throws(
    () =>
      loadRelayKeySource({
        path: 'relay.key',
        files: filesFor(identity.privateKey, 0o640),
        expectedKeyId: keyId,
        expectedPublicKey: identity.publicKey,
        platform: 'linux',
      }),
    /must not be accessible by group or others/,
  );

  const source = loadRelayKeySource({
    path: 'relay.key',
    files: filesFor(identity.privateKey, 0o644),
    expectedKeyId: keyId,
    expectedPublicKey: identity.publicKey,
    platform: 'win32',
  });
  assert.equal(source.privateKeyFor(keyId), identity.privateKey);
});

test('invalid key material and mismatched public keys are rejected', () => {
  const identity = createIdentity();
  const keyId = relayKeyId(identity.publicKey);

  assert.throws(
    () =>
      loadRelayKeySource({
        path: 'relay.key',
        files: filesFor('not base64!', 0o600),
        expectedKeyId: keyId,
        expectedPublicKey: identity.publicKey,
        platform: 'linux',
      }),
    /not base64/,
  );

  assert.throws(
    () =>
      loadRelayKeySource({
        path: 'relay.key',
        files: filesFor('', 0o600),
        expectedKeyId: keyId,
        expectedPublicKey: identity.publicKey,
        platform: 'linux',
      }),
    /not base64/,
  );

  const { privateKey: rsaPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = rsaPrivateKey.export({ format: 'der', type: 'pkcs8' });
  const rsaText = Buffer.isBuffer(exported)
    ? exported.toString('base64')
    : Buffer.from(exported, 'base64').toString('base64');

  assert.throws(
    () =>
      loadRelayKeySource({
        path: 'relay.key',
        files: filesFor(rsaText, 0o600),
        expectedKeyId: keyId,
        expectedPublicKey: identity.publicKey,
        platform: 'linux',
      }),
    /ed25519/,
  );

  const other = createIdentity();
  assert.throws(
    () =>
      loadRelayKeySource({
        path: 'relay.key',
        files: filesFor(identity.privateKey, 0o600),
        expectedKeyId: keyId,
        expectedPublicKey: other.publicKey,
        platform: 'linux',
      }),
    /does not match/,
  );
});

test('error messages do not contain key material', () => {
  const identity = createIdentity();
  const keyId = relayKeyId(identity.publicKey);
  const other = createIdentity();

  try {
    loadRelayKeySource({
      path: 'relay.key',
      files: filesFor(identity.privateKey, 0o600),
      expectedKeyId: keyId,
      expectedPublicKey: other.publicKey,
      platform: 'linux',
    });
    assert.fail('expected error');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(identity.privateKey));
  }
});