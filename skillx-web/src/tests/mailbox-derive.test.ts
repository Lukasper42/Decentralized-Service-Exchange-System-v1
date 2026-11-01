import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CryptoPort } from '../ports.js';
import { generateKeyPair, importNonExtractablePrivate } from '../crypto.js';
import {
  createKeyBundle,
  deriveMessagingKey,
  mailboxId,
  openMessage,
  sealMessage
} from '../mailbox-crypto.js';

const port: CryptoPort = { subtle: globalThis.crypto.subtle };
const random = {
  bytes: (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n))
};
const clock = { nowMs: (): number => 0, nowIso: (): string => '2026-01-01T00:00:00.000Z' };

test('deriveMessagingKey is deterministic and depends on the identity', async () => {
  const a = await generateKeyPair(port);
  const b = await generateKeyPair(port);
  const keyA = await importNonExtractablePrivate(port, a.privateKeyPkcs8);
  const keyB = await importNonExtractablePrivate(port, b.privateKeyPkcs8);
  const first = await deriveMessagingKey(port, keyA);
  const second = await deriveMessagingKey(port, keyA);
  const other = await deriveMessagingKey(port, keyB);
  assert.ok(first.ok && second.ok && other.ok);
  assert.deepEqual(first.value, second.value);
  assert.notEqual(first.value.xPubkey, other.value.xPubkey);
});

test('derived key: seal/open roundtrip', async () => {
  const alice = await generateKeyPair(port);
  const bob = await generateKeyPair(port);
  const aliceKey = await importNonExtractablePrivate(port, alice.privateKeyPkcs8);
  const bobKey = await importNonExtractablePrivate(port, bob.privateKeyPkcs8);
  const bobX = await deriveMessagingKey(port, bobKey);
  assert.ok(bobX.ok);
  const bundle = await createKeyBundle(port, bob.publicKey, bobKey, bobX.value.xPubkey, clock.nowIso());
  const sealed = await sealMessage(port, random, clock, {
    from: alice.publicKey,
    edKey: aliceKey,
    recipientBundle: bundle,
    body: 'Hello Bob'
  });
  assert.ok(sealed.ok);
  const bobId = await mailboxId(port, bob.publicKey);
  const opened = await openMessage(port, bobId, bobX.value.xPrivatePkcs8, sealed.value);
  assert.ok(opened.ok);
  assert.equal(opened.value.body, 'Hello Bob');
  assert.equal(opened.value.from, alice.publicKey);
  // A third party cannot open it
  const eveX = await deriveMessagingKey(port, aliceKey);
  assert.ok(eveX.ok);
  const wrong = await openMessage(port, bobId, eveX.value.xPrivatePkcs8, sealed.value);
  assert.equal(wrong.ok, false);
});
