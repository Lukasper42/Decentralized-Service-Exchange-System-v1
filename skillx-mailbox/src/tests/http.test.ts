import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailboxIdOf } from '../protocol.js';
import type { KeyBundle } from '../protocol.js';
import { MailboxStore } from '../store.js';
import {
  FakeClock,
  MemoryFile,
  identityOf,
  makeAuth,
  makeBundle,
  makeEnvelope,
  makeSigner,
  readStringField,
  startServer,
  testRandom,
} from './helpers.js';

const T0 = 1_700_000_000_000;
const ISO0 = new Date(T0).toISOString();
const ORIGIN = 'https://example.org';

async function setup(): Promise<{
  base: string;
  clock: FakeClock;
  close: () => Promise<void>;
}> {
  const clock = new FakeClock(T0);
  const store = await MailboxStore.load({ clock, random: testRandom, file: new MemoryFile() });
  const server = await startServer({ store, clock, allowedOrigin: ORIGIN });
  return { base: server.base, clock, close: server.close };
}

function putBundle(base: string, mailboxId: string, bundle: KeyBundle): Promise<Response> {
  return fetch(`${base}/v1/keys/${mailboxId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });
}

test('valid KeyBundle is stored and publicly readable', async () => {
  const env = await setup();
  try {
    const signer = await makeSigner();
    const mailboxId = identityOf(signer);
    const bundle = await makeBundle(signer, ISO0);

    const put = await putBundle(env.base, mailboxId, bundle);
    assert.equal(put.status, 201);

    const get = await fetch(`${env.base}/v1/keys/${mailboxId}`);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(get.headers.get('access-control-allow-origin'), ORIGIN);
    const body: unknown = await get.json();
    assert.deepEqual(body, bundle);
  } finally {
    await env.close();
  }
});

test('invalid signature, wrong MailboxId and older created_at are rejected', async () => {
  const env = await setup();
  try {
    const signer = await makeSigner();
    const other = await makeSigner();
    const mailboxId = identityOf(signer);
    const bundle = await makeBundle(signer, ISO0);

    const first = bundle.sig.charAt(0) === 'A' ? 'B' : 'A';
    const tampered: KeyBundle = { ...bundle, sig: first + bundle.sig.slice(1) };
    assert.equal((await putBundle(env.base, mailboxId, tampered)).status, 400);

    assert.equal((await putBundle(env.base, identityOf(other), bundle)).status, 400);

    assert.equal((await putBundle(env.base, mailboxId, bundle)).status, 201);

    const olderIso = new Date(T0 - 86_400_000).toISOString();
    const older = await makeBundle(signer, olderIso);
    assert.equal((await putBundle(env.base, mailboxId, older)).status, 409);
  } finally {
    await env.close();
  }
});

test('POST without an existing KeyBundle returns 404', async () => {
  const env = await setup();
  try {
    const unknownId = 'a'.repeat(64);
    const res = await fetch(`${env.base}/v1/mailbox/${unknownId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEnvelope()),
    });
    assert.equal(res.status, 404);
  } finally {
    await env.close();
  }
});

test('POST/GET round trip with auth and DELETE', async () => {
  const env = await setup();
  try {
    const signer = await makeSigner();
    const mailboxId = identityOf(signer);
    await putBundle(env.base, mailboxId, await makeBundle(signer, ISO0));

    const envelope = makeEnvelope();
    const post = await fetch(`${env.base}/v1/mailbox/${mailboxId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    assert.equal(post.status, 201);
    const messageId = readStringField(await post.json(), 'id');
    assert.match(messageId, /^[0-9a-f]{32}$/);

    const nowSec = Math.floor(T0 / 1000);
    const path = `/v1/mailbox/${mailboxId}/messages`;
    const auth = await makeAuth(signer, 'GET', path, nowSec);

    const get = await fetch(`${env.base}${path}?after=0&limit=10`, {
      headers: { 'x-skillx-auth': auth },
    });
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.deepEqual(body, {
      messages: [{ seq: 1, id: messageId, envelope }],
      next: 1,
    });

    const deleteAuth = await makeAuth(signer, 'DELETE', `${path}/${messageId}`, nowSec);
    const del = await fetch(`${env.base}${path}/${messageId}`, {
      method: 'DELETE',
      headers: { 'x-skillx-auth': deleteAuth },
    });
    assert.equal(del.status, 204);

    const listAfter = await fetch(`${env.base}${path}`, {
      headers: { 'x-skillx-auth': auth },
    });
    assert.equal(listAfter.status, 200);
    const listBody = await listAfter.json();
    assert.deepEqual(listBody, { messages: [], next: 0 });

    const missing = await fetch(`${env.base}${path}/${messageId}`, {
      method: 'DELETE',
      headers: { 'x-skillx-auth': deleteAuth },
    });
    assert.equal(missing.status, 404);
  } finally {
    await env.close();
  }
});

test('missing, expired and foreign auth return 401', async () => {
  const env = await setup();
  try {
    const signer = await makeSigner();
    const stranger = await makeSigner();
    const mailboxId = identityOf(signer);
    await putBundle(env.base, mailboxId, await makeBundle(signer, ISO0));

    const path = `/v1/mailbox/${mailboxId}/messages`;

    const missing = await fetch(`${env.base}${path}`);
    assert.equal(missing.status, 401);

    const nowSec = Math.floor(T0 / 1000);
    const expired = await makeAuth(signer, 'GET', path, nowSec - 500);
    const expiredRes = await fetch(`${env.base}${path}`, {
      headers: { 'x-skillx-auth': expired },
    });
    assert.equal(expiredRes.status, 401);

    const foreign = await makeAuth(stranger, 'GET', path, nowSec);
    const foreignRes = await fetch(`${env.base}${path}`, {
      headers: { 'x-skillx-auth': foreign },
    });
    assert.equal(foreignRes.status, 401);
  } finally {
    await env.close();
  }
});

test('oversized body returns 413', async () => {
  const env = await setup();
  try {
    const signer = await makeSigner();
    const mailboxId = identityOf(signer);
    const bigBody = '"' + 'x'.repeat(30_000) + '"';
    const res = await fetch(`${env.base}/v1/keys/${mailboxId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: bigBody,
    });
    assert.equal(res.status, 413);
  } finally {
    await env.close();
  }
});

test('OPTIONS preflight is answered correctly', async () => {
  const env = await setup();
  try {
    const res = await fetch(`${env.base}/v1/keys/${'b'.repeat(64)}`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PUT, DELETE');
    assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, X-Skillx-Auth');
    assert.equal(res.headers.get('access-control-max-age'), '600');
  } finally {
    await env.close();
  }
});

test('GET /v1/health returns ok', async () => {
  const env = await setup();
  try {
    const res = await fetch(`${env.base}/v1/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await env.close();
  }
});

test('unknown path returns 404, wrong method 405', async () => {
  const env = await setup();
  try {
    const notFound = await fetch(`${env.base}/v1/nope`);
    assert.equal(notFound.status, 404);

    const wrongMethod = await fetch(`${env.base}/v1/health`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');
  } finally {
    await env.close();
  }
});

test('MailboxId in the path must match the identity pubkey', async () => {
  const env = await setup();
  try {
    const signer = await makeSigner();
    const other = await makeSigner();
    const bundle = await makeBundle(signer, ISO0);
    const wrongId = mailboxIdOf(other.pubkeyB64);
    const res = await putBundle(env.base, wrongId, bundle);
    assert.equal(res.status, 400);
  } finally {
    await env.close();
  }
});
