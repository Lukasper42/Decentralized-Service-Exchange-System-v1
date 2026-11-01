import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../protocol.js';
import { MailboxStore } from '../store.js';
import {
  FakeClock,
  MemoryFile,
  identityOf,
  makeBundle,
  makeEnvelope,
  makeSigner,
  testRandom,
} from './helpers.js';

const T0 = 1_700_000_000_000;
const ISO0 = new Date(T0).toISOString();

test('limit of 200 messages is enforced', async () => {
  const clock = new FakeClock(T0);
  const store = await MailboxStore.load({ clock, random: testRandom, file: new MemoryFile() });
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  await store.putKey(await makeBundle(signer, ISO0));

  for (let i = 0; i < 200; i++) {
    clock.advance(2000);
    await store.addMessage(mailboxId, makeEnvelope());
  }

  clock.advance(2000);
  await assert.rejects(
    () => store.addMessage(mailboxId, makeEnvelope()),
    (err: unknown) => err instanceof ApiError && err.code === 'RATE_LIMITED',
  );
});

test('TTL deletes messages after 14 days', async () => {
  const clock = new FakeClock(T0);
  const store = await MailboxStore.load({ clock, random: testRandom, file: new MemoryFile() });
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  await store.putKey(await makeBundle(signer, ISO0));
  await store.addMessage(mailboxId, makeEnvelope());

  const before = await store.listMessages(mailboxId, 0, 100);
  assert.equal(before.messages.length, 1);

  clock.advance(15 * 24 * 60 * 60 * 1000);

  const after = await store.listMessages(mailboxId, 0, 100);
  assert.equal(after.messages.length, 0);
});

test('persistence round trip via StoreFilePort', async () => {
  const clock = new FakeClock(T0);
  const file = new MemoryFile();
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  const bundle = await makeBundle(signer, ISO0);
  const envelope = makeEnvelope();

  const first = await MailboxStore.load({ clock, random: testRandom, file });
  await first.putKey(bundle);
  const created = await first.addMessage(mailboxId, envelope);

  const second = await MailboxStore.load({ clock, random: testRandom, file });
  assert.deepEqual(second.getKey(mailboxId), bundle);
  const listed = await second.listMessages(mailboxId, 0, 100);
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0]?.id, created.id);
  assert.deepEqual(listed.messages[0]?.envelope, envelope);
});

test('DELETE removes the message, unknown ID returns false', async () => {
  const clock = new FakeClock(T0);
  const store = await MailboxStore.load({ clock, random: testRandom, file: new MemoryFile() });
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  await store.putKey(await makeBundle(signer, ISO0));
  const created = await store.addMessage(mailboxId, makeEnvelope());

  assert.equal(await store.deleteMessage(mailboxId, created.id), true);
  assert.equal(await store.deleteMessage(mailboxId, created.id), false);
  const listed = await store.listMessages(mailboxId, 0, 100);
  assert.equal(listed.messages.length, 0);
});

test('seq keeps increasing even when the mailbox was empty in between', async () => {
  const clock = new FakeClock(T0);
  const store = await MailboxStore.load({ clock, random: testRandom, file: new MemoryFile() });
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  await store.putKey(await makeBundle(signer, ISO0));
  const a = await store.addMessage(mailboxId, makeEnvelope());
  assert.equal(await store.deleteMessage(mailboxId, a.id), true);
  clock.advance(2000);
  await store.addMessage(mailboxId, makeEnvelope());
  const listed = await store.listMessages(mailboxId, 1, 100);
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0]?.seq, 2);
});

test('seq is preserved after restart', async () => {
  const clock = new FakeClock(T0);
  const file = new MemoryFile();
  const signer = await makeSigner();
  const mailboxId = identityOf(signer);
  const first = await MailboxStore.load({ clock, random: testRandom, file });
  await first.putKey(await makeBundle(signer, ISO0));
  const a = await first.addMessage(mailboxId, makeEnvelope());
  await first.deleteMessage(mailboxId, a.id);
  const second = await MailboxStore.load({ clock, random: testRandom, file });
  clock.advance(2000);
  await second.addMessage(mailboxId, makeEnvelope());
  const listed = await second.listMessages(mailboxId, 0, 100);
  assert.equal(listed.messages[0]?.seq, 2);
});
