import test from 'node:test';
import assert from 'node:assert/strict';
import type { CryptoPort, FetchInit, FetchPort, FetchResponseLike } from '../ports.js';
import { MailboxClient } from '../mailbox-client.js';
import { b64Encode } from '../crypto.js';
import { mailboxId } from '../mailbox-crypto.js';
import type { Envelope, KeyBundle } from '../mailbox-crypto.js';

const port: CryptoPort = { subtle: globalThis.crypto.subtle };

function response(status: number, body: unknown): FetchResponseLike {
  return {
    status,
    json: async () => body
  };
}

function emptyResponse(status: number): FetchResponseLike {
  return {
    status,
    json: async () => {
      throw new Error('no body');
    }
  };
}

async function makeIdentityPubkey(): Promise<string> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  );
  if (!('privateKey' in pair)) throw new Error('expected key pair');
  const spki = await globalThis.crypto.subtle.exportKey('spki', pair.publicKey);
  return b64Encode(new Uint8Array(spki));
}

function validEnvelope(): Envelope {
  return {
    v: 1,
    eph_pub: 'x',
    iv: 'y',
    ct: 'z'
  };
}

test('client putKeyBundle maps 201 and 200', async () => {
  const identity = await makeIdentityPubkey();
  const bundle: KeyBundle = {
    v: 1,
    identity_pubkey: identity,
    x_pubkey: 'x',
    created_at: '2023-11-14T22:13:20.000Z',
    sig: 's'
  };
  const calls: string[] = [];
  const fetchPort: FetchPort = async (url, init) => {
    calls.push(url);
    assert.equal(init?.method, 'PUT');
    return response(201, {});
  };
  const client = new MailboxClient('https://example.com', fetchPort);
  const result = await client.putKeyBundle(bundle);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.status, 201);
  const expectedId = await mailboxId(port, identity);
  assert.ok(calls[0]?.includes(expectedId));
});

test('client getKeyBundle validates response', async () => {
  const identity = await makeIdentityPubkey();
  const bundle: KeyBundle = {
    v: 1,
    identity_pubkey: identity,
    x_pubkey: 'x',
    created_at: '2023-11-14T22:13:20.000Z',
    sig: 's'
  };
  const id = await mailboxId(port, identity);
  const fetchPort: FetchPort = async () => response(200, bundle);
  const client = new MailboxClient('https://example.com', fetchPort);
  const result = await client.getKeyBundle(id);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.identity_pubkey, identity);

  const badFetch: FetchPort = async () => response(200, { v: 1 });
  const badClient = new MailboxClient('https://example.com', badFetch);
  const bad = await badClient.getKeyBundle(id);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'FIELD_FORMAT');

  const notFoundFetch: FetchPort = async () =>
    response(404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  const notFoundClient = new MailboxClient('https://example.com', notFoundFetch);
  const notFound = await notFoundClient.getKeyBundle(id);
  assert.equal(notFound.ok, false);
  if (!notFound.ok) assert.equal(notFound.error.code, 'NOT_FOUND');
});

test('client send validates response and maps errors', async () => {
  const id = 'b'.repeat(64);
  const msgId = 'c'.repeat(32);
  const fetchPort: FetchPort = async () => response(201, { id: msgId });
  const client = new MailboxClient('https://example.com', fetchPort);
  const result = await client.send(id, validEnvelope());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value, msgId);

  const notFound: FetchPort = async () =>
    response(404, { error: { code: 'NOT_FOUND', message: 'no bundle' } });
  const nfClient = new MailboxClient('https://example.com', notFound);
  const nf = await nfClient.send(id, validEnvelope());
  assert.equal(nf.ok, false);
  if (!nf.ok) assert.equal(nf.error.code, 'NOT_FOUND');

  const limited: FetchPort = async () =>
    response(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } });
  const limClient = new MailboxClient('https://example.com', limited);
  const lim = await limClient.send(id, validEnvelope());
  assert.equal(lim.ok, false);
  if (!lim.ok) assert.equal(lim.error.code, 'LIMIT');

  const badJson: FetchPort = async () => ({
    status: 201,
    json: async () => {
      throw new SyntaxError('bad');
    }
  });
  const badClient = new MailboxClient('https://example.com', badJson);
  const bad = await badClient.send(id, validEnvelope());
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'FIELD_FORMAT');

  const wrongType: FetchPort = async () => response(201, { id: 1 });
  const wrongClient = new MailboxClient('https://example.com', wrongType);
  const wrong = await wrongClient.send(id, validEnvelope());
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.error.code, 'FIELD_FORMAT');
});

test('client fetchMessages validates structure and auth header', async () => {
  const id = 'd'.repeat(64);
  const envelope = validEnvelope();
  let seenAuth = '';
  const fetchPort: FetchPort = async (url, init) => {
    assert.ok(url.includes('after=0'));
    seenAuth = init?.headers?.['X-Skillx-Auth'] ?? '';
    return response(200, {
      messages: [{ seq: 1, id: 'm1', envelope }],
      next: 2
    });
  };
  const client = new MailboxClient('https://example.com', fetchPort);
  const result = await client.fetchMessages(id, 'auth-value', 0);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.next, 2);
  assert.equal(result.value.messages.length, 1);
  assert.equal(seenAuth, 'auth-value');

  const unauthorized: FetchPort = async () =>
    response(401, { error: { code: 'UNAUTHORIZED', message: 'no' } });
  const unClient = new MailboxClient('https://example.com', unauthorized);
  const un = await unClient.fetchMessages(id, 'a', 0);
  assert.equal(un.ok, false);
  if (!un.ok) assert.equal(un.error.code, 'POLICY');

  const badJson: FetchPort = async () => ({
    status: 200,
    json: async () => {
      throw new SyntaxError('bad');
    }
  });
  const badClient = new MailboxClient('https://example.com', badJson);
  const bad = await badClient.fetchMessages(id, 'a', 0);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'FIELD_FORMAT');

  const wrongTypes: FetchPort = async () =>
    response(200, { messages: [{ seq: '1', id: 'm', envelope }], next: 1 });
  const wrongClient = new MailboxClient('https://example.com', wrongTypes);
  const wrong = await wrongClient.fetchMessages(id, 'a', 0);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.error.code, 'FIELD_FORMAT');
});

test('client deleteMessage handles 204 and 404', async () => {
  const id = 'e'.repeat(64);
  const fetchPort: FetchPort = async (_url, init) => {
    assert.equal(init?.method, 'DELETE');
    return emptyResponse(204);
  };
  const client = new MailboxClient('https://example.com', fetchPort);
  const result = await client.deleteMessage(id, 'm1', 'auth');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.status, 204);

  const notFound: FetchPort = async () =>
    response(404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  const nfClient = new MailboxClient('https://example.com', notFound);
  const nf = await nfClient.deleteMessage(id, 'm1', 'auth');
  assert.equal(nf.ok, false);
  if (!nf.ok) assert.equal(nf.error.code, 'NOT_FOUND');
});

test('client constructor rejects invalid base URL', () => {
  const fetchPort: FetchPort = async () => response(200, {});
  assert.throws(() => new MailboxClient('not-a-url', fetchPort));
});

function b64ToArray(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

test('client getKeyBundle rejects a substituted bundle', async () => {
  const identity = await makeIdentityPubkey();
  const other = await makeIdentityPubkey();
  const bundle: KeyBundle = {
    v: 1,
    identity_pubkey: other,
    x_pubkey: 'x',
    created_at: '2023-11-14T22:13:20.000Z',
    sig: 's'
  };
  const client = new MailboxClient('https://example.com', async () => response(200, bundle));
  const result = await client.getKeyBundle(await mailboxId(port, identity));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'SIGNING');
});
