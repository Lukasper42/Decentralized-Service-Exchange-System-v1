import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClockPort, CryptoPort, RandomPort } from '../ports.js';
import {
  b64DecodeStrict,
  b64Encode,
  canonical,
  signWithNonExtractable,
  verifySignature
} from '../crypto.js';
import {
  buildAuthHeader,
  createKeyBundle,
  generateMessagingKey,
  mailboxId,
  openMessage,
  sealMessage,
  verifyKeyBundle
} from '../mailbox-crypto.js';
import type { Envelope, Inner, KeyBundle } from '../mailbox-crypto.js';

const port: CryptoPort = { subtle: globalThis.crypto.subtle };
const clock: ClockPort = {
  nowMs: () => 1700000000000,
  nowIso: () => '2023-11-14T22:13:20.000Z'
};

function randomPort(seed: number): RandomPort {
  let counter = seed;
  return {
    bytes(n: number): Uint8Array {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) {
        out[i] = (counter + i) & 0xff;
      }
      counter = (counter + n) & 0xffff;
      return out;
    }
  };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as unknown as ArrayBuffer;
}

async function makeIdentity(): Promise<{ pubkey: string; privateKey: CryptoKey }> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  );
  if (!('privateKey' in pair)) {
    throw new Error('expected Ed25519 key pair');
  }
  const spki = await globalThis.crypto.subtle.exportKey('spki', pair.publicKey);
  return {
    pubkey: b64Encode(new Uint8Array(spki)),
    privateKey: pair.privateKey
  };
}

async function sealCustomInner(
  recipientXPubkey: string,
  aadMailboxId: string,
  edKey: CryptoKey,
  innerBase: Omit<Inner, 'sig' | 'eph_pub'>
): Promise<Envelope> {
  const eph = await globalThis.crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits']
  );
  if (!('privateKey' in eph)) {
    throw new Error('expected X25519 key pair');
  }
  const ephPubRaw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', eph.publicKey));
  const unsigned = { ...innerBase, eph_pub: b64Encode(ephPubRaw) };
  const sig = await signWithNonExtractable(
    port,
    edKey,
    utf8('skillx/v1/mailbox-inner\n' + canonical(unsigned))
  );
  const inner: Inner = { ...unsigned, sig };
  const plaintext = utf8(canonical(inner));
  const padded = new Uint8Array(1024);
  padded.fill(0x20);
  padded.set(plaintext, 0);

  const recipientKey = await globalThis.crypto.subtle.importKey(
    'raw',
    ab(b64DecodeStrict(recipientXPubkey)),
    { name: 'X25519' },
    false,
    []
  );
  const shared = await globalThis.crypto.subtle.deriveBits(
    { name: 'X25519', public: recipientKey },
    eph.privateKey,
    256
  );
  const hkdfKey = await globalThis.crypto.subtle.importKey(
    'raw',
    shared,
    'HKDF',
    false,
    ['deriveKey']
  );
  const aesKey = await globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ab(new Uint8Array(32)),
      info: ab(utf8('skillx/v1/mailbox-msg'))
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = randomPort(99).bytes(12);
  const ct = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ab(iv),
      additionalData: ab(utf8('skillx/v1/mailbox-aad\n' + aadMailboxId))
    },
    aesKey,
    ab(padded)
  );
  return {
    v: 1,
    eph_pub: b64Encode(ephPubRaw),
    iv: b64Encode(iv),
    ct: b64Encode(new Uint8Array(ct))
  };
}

test('mailbox seal/open roundtrip', async () => {
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const bobKey = await generateMessagingKey(port);
  const bundle = await createKeyBundle(
    port,
    bob.pubkey,
    bob.privateKey,
    bobKey.xPubkey,
    clock.nowIso()
  );
  assert.equal(await verifyKeyBundle(port, bundle), true);

  const sealed = await sealMessage(port, randomPort(1), clock, {
    from: alice.pubkey,
    edKey: alice.privateKey,
    recipientBundle: bundle,
    body: 'Hallo Bob'
  });
  assert.ok(sealed.ok);
  if (!sealed.ok) return;

  const bobMailbox = await mailboxId(port, bob.pubkey);
  const opened = await openMessage(port, bobMailbox, bobKey.xPrivatePkcs8, sealed.value);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  assert.equal(opened.value.from, alice.pubkey);
  assert.equal(opened.value.body, 'Hallo Bob');
  assert.equal(opened.value.sentAt, clock.nowIso());
});

test('mailbox open rejects manipulated envelope fields', async () => {
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const bobKey = await generateMessagingKey(port);
  const bundle = await createKeyBundle(
    port,
    bob.pubkey,
    bob.privateKey,
    bobKey.xPubkey,
    clock.nowIso()
  );
  const sealed = await sealMessage(port, randomPort(2), clock, {
    from: alice.pubkey,
    edKey: alice.privateKey,
    recipientBundle: bundle,
    body: 'secret'
  });
  assert.ok(sealed.ok);
  if (!sealed.ok) return;
  const bobMailbox = await mailboxId(port, bob.pubkey);

  const ctClone = structuredClone(sealed.value);
  const ctBytes = b64DecodeStrict(ctClone.ct);
  ctBytes[0] = (ctBytes[0] ?? 0) ^ 1;
  ctClone.ct = b64Encode(ctBytes);
  const ctResult = await openMessage(port, bobMailbox, bobKey.xPrivatePkcs8, ctClone);
  assert.equal(ctResult.ok, false);

  const ivClone = structuredClone(sealed.value);
  const ivBytes = b64DecodeStrict(ivClone.iv);
  ivBytes[0] = (ivBytes[0] ?? 0) ^ 1;
  ivClone.iv = b64Encode(ivBytes);
  const ivResult = await openMessage(port, bobMailbox, bobKey.xPrivatePkcs8, ivClone);
  assert.equal(ivResult.ok, false);

  const otherKey = await generateMessagingKey(port);
  const ephClone = structuredClone(sealed.value);
  ephClone.eph_pub = otherKey.xPubkey;
  const ephResult = await openMessage(port, bobMailbox, bobKey.xPrivatePkcs8, ephClone);
  assert.equal(ephResult.ok, false);

  const wrongMailbox = await mailboxId(port, alice.pubkey);
  const aadResult = await openMessage(port, wrongMailbox, bobKey.xPrivatePkcs8, sealed.value);
  assert.equal(aadResult.ok, false);
});

test('mailbox open rejects wrong sender key and forged inner signature', async () => {
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const bobKey = await generateMessagingKey(port);
  const bundle = await createKeyBundle(
    port,
    bob.pubkey,
    bob.privateKey,
    bobKey.xPubkey,
    clock.nowIso()
  );
  const bobMailbox = await mailboxId(port, bob.pubkey);

  const forgedSender = await sealMessage(port, randomPort(3), clock, {
    from: alice.pubkey,
    edKey: bob.privateKey,
    recipientBundle: bundle,
    body: 'forged'
  });
  assert.ok(forgedSender.ok);
  if (!forgedSender.ok) return;
  const forgedResult = await openMessage(
    port,
    bobMailbox,
    bobKey.xPrivatePkcs8,
    forgedSender.value
  );
  assert.equal(forgedResult.ok, false);
  if (!forgedResult.ok) assert.equal(forgedResult.error.code, 'SIGNING');
});

test('mailbox open rejects swapped recipient inside inner', async () => {
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const bobKey = await generateMessagingKey(port);
  const aliceMailbox = await mailboxId(port, alice.pubkey);
  const bobMailbox = await mailboxId(port, bob.pubkey);
  const envelope = await sealCustomInner(bobKey.xPubkey, bobMailbox, alice.privateKey, {
    v: 1,
    from: alice.pubkey,
    to: aliceMailbox,
    sent_at: clock.nowIso(),
    body: 'swapped'
  });
  const result = await openMessage(port, bobMailbox, bobKey.xPrivatePkcs8, envelope);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'ENVELOPE');
});

test('mailbox padding sizes and TOO_LARGE', async () => {
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const bobKey = await generateMessagingKey(port);
  const bundle = await createKeyBundle(
    port,
    bob.pubkey,
    bob.privateKey,
    bobKey.xPubkey,
    clock.nowIso()
  );

  const small = await sealMessage(port, randomPort(4), clock, {
    from: alice.pubkey,
    edKey: alice.privateKey,
    recipientBundle: bundle,
    body: 'a'
  });
  assert.ok(small.ok);
  if (!small.ok) return;
  assert.equal(b64DecodeStrict(small.value.ct).length - 16, 1024);

  const medium = await sealMessage(port, randomPort(5), clock, {
    from: alice.pubkey,
    edKey: alice.privateKey,
    recipientBundle: bundle,
    body: 'a'.repeat(3000)
  });
  assert.ok(medium.ok);
  if (!medium.ok) return;
  assert.equal(b64DecodeStrict(medium.value.ct).length - 16, 4096);

  const large = await sealMessage(port, randomPort(6), clock, {
    from: alice.pubkey,
    edKey: alice.privateKey,
    recipientBundle: bundle,
    body: 'a'.repeat(8000)
  });
  assert.ok(large.ok);
  if (!large.ok) return;
  assert.equal(b64DecodeStrict(large.value.ct).length - 16, 16384);

  const tooLarge = await sealMessage(port, randomPort(7), clock, {
    from: alice.pubkey,
    edKey: alice.privateKey,
    recipientBundle: bundle,
    body: '😀'.repeat(8000)
  });
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.error.message, 'TOO_LARGE');
});

test('key bundle verification rejects wrong signature and pubkey', async () => {
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const bobKey = await generateMessagingKey(port);
  const bundle = await createKeyBundle(
    port,
    bob.pubkey,
    bob.privateKey,
    bobKey.xPubkey,
    clock.nowIso()
  );

  const wrongSig: KeyBundle = structuredClone(bundle);
  wrongSig.sig = b64Encode(new Uint8Array(64));
  assert.equal(await verifyKeyBundle(port, wrongSig), false);

  const wrongPub: KeyBundle = structuredClone(bundle);
  wrongPub.identity_pubkey = alice.pubkey;
  assert.equal(await verifyKeyBundle(port, wrongPub), false);

  const invalidPub: KeyBundle = structuredClone(bundle);
  invalidPub.identity_pubkey = 'not-base64';
  assert.equal(await verifyKeyBundle(port, invalidPub), false);
});

test('auth header has expected format and valid signature', async () => {
  const alice = await makeIdentity();
  const path = '/v1/mailbox/abc/messages';
  const header = await buildAuthHeader(
    port,
    alice.pubkey,
    alice.privateKey,
    'GET',
    path,
    123
  );
  const parts = header.split('.');
  assert.equal(parts.length, 3);
  const pub = parts[0];
  const ts = parts[1];
  const sig = parts[2];
  assert.ok(pub !== undefined);
  assert.ok(ts !== undefined);
  assert.ok(sig !== undefined);
  assert.equal(pub, alice.pubkey);
  assert.equal(Number(ts), 123);
  const message = utf8(
    'skillx/v1/mailbox-auth\n' + canonical({ method: 'GET', path, ts: 123 })
  );
  assert.equal(await verifySignature(port, pub, message, sig), true);
});
