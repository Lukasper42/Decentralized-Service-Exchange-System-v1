import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '../../crypto/src/index.js';
import { Retention, ContentError, MemoryContentStore, commitTo, revealAndStore, revealWindow, verifyReveal } from './index.js';

const salt = Buffer.alloc(32, 7);
const saltHex = salt.toString('hex');
const bytes = Buffer.from('deliverable bytes');
const window = revealWindow(1000, 2000);
async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; return 'none'; } catch (error) { return error instanceof ContentError ? error.code : 'other'; }
}

test('reveal with the right salt verifies and stores; the hash is of the revealed bytes', async () => {
  const store = new MemoryContentStore(1024);
  const c = commitTo('criteria', salt, bytes);
  const draft = await revealAndStore(store, { kind: 'criteria', commitment: c, bytes, saltHex, window, nowMs: 1500 });
  assert.equal(draft.contentHash, contentHash(bytes));
  assert.equal(draft.salt, saltHex);
  assert.equal(await store.has(draft.contentHash), true);
});
test('reveal with a wrong salt or wrong bytes is rejected and stores nothing', async () => {
  const store = new MemoryContentStore(1024);
  const c = commitTo('criteria', salt, bytes);
  const wrong = Buffer.alloc(32, 8).toString('hex');
  assert.equal(await code(revealAndStore(store, { kind: 'criteria', commitment: c, bytes, saltHex: wrong, window, nowMs: 1500 })), 'COMMITMENT_MISMATCH');
  assert.equal(await code(revealAndStore(store, { kind: 'criteria', commitment: c, bytes: Buffer.from('other'), saltHex, window, nowMs: 1500 })), 'COMMITMENT_MISMATCH');
  assert.equal(await code(revealAndStore(store, { kind: 'criteria', commitment: c, bytes, saltHex: 'zz', window, nowMs: 1500 })), 'BAD_SALT');
  assert.equal(await store.has(contentHash(bytes)), false);
});
test('a commitment of one kind does not verify as another kind', () => {
  const c = commitTo('criteria', salt, bytes);
  assert.equal(verifyReveal('criteria', c, bytes, saltHex), true);
  assert.equal(verifyReveal('reason', c, bytes, saltHex), false);
});
test('reveal window is inclusive at both ends and closed outside', async () => {
  const store = new MemoryContentStore(1024);
  const c = commitTo('reason', salt, bytes);
  for (const now of [1000, 2000]) await revealAndStore(store, { kind: 'reason', commitment: c, bytes, saltHex, window, nowMs: now });
  for (const now of [999, 2001]) assert.equal(await code(revealAndStore(store, { kind: 'reason', commitment: c, bytes, saltHex, window, nowMs: now })), 'REVEAL_WINDOW');
  assert.throws(() => revealWindow(5, 4), ContentError);
});
test('precheck-report commitment is the plain content hash with an empty salt', async () => {
  const store = new MemoryContentStore(1024);
  const c = contentHash(bytes);
  assert.equal(verifyReveal('precheck-report', c, bytes, ''), true);
  assert.equal(verifyReveal('precheck-report', c, bytes, saltHex), false);
  const draft = await revealAndStore(store, { kind: 'precheck-report', commitment: c, bytes, saltHex: '', window, nowMs: 1500 });
  assert.equal(draft.salt, '');
});
test('retention: deletable strictly after the appeal deadline; a deleted blob is Unavailable', async () => {
  const store = new MemoryContentStore(1024);
  const hash = await store.put(bytes);
  const retention = new Retention(5000);
  assert.equal(await code(retention.deleteIfAllowed(store, hash, 5000)), 'RETENTION');
  assert.equal(await store.has(hash), true);
  await retention.deleteIfAllowed(store, hash, 5001);
  assert.equal(await code(store.get(hash)), 'UNAVAILABLE');
});
