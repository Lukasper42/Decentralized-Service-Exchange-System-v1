import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { contentHash } from '../../crypto/src/index.js';
import { ContentError, FsContentStore, MemoryContentStore, collectBytes } from './index.js';
import type { ContentStore } from './index.js';

let counter = 0;
const unique = (): string => `t${counter++}`;
async function fsStore(maxBytes = 1024): Promise<{ store: FsContentStore; root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'content-'));
  return { store: new FsContentStore({ root, maxBytes, uniqueName: unique }), root };
}
async function read(store: ContentStore, hash: string): Promise<string> { return (await collectBytes(await store.get(hash), 1 << 20)).toString('utf8'); }
async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; return 'none'; } catch (error) { return error instanceof ContentError ? error.code : 'other'; }
}

for (const kind of ['memory', 'fs'] as const) {
  test(`${kind}: put/get/has/delete roundtrip with hash = SHA-256`, async () => {
    const store = kind === 'memory' ? new MemoryContentStore(1024) : (await fsStore()).store;
    const hash = await store.put(Buffer.from('hello'));
    assert.equal(hash, contentHash(Buffer.from('hello')));
    assert.equal(await read(store, hash), 'hello');
    assert.equal(await store.has(hash), true);
    assert.equal(await store.put(Readable.from([Buffer.from('hel'), Buffer.from('lo')])), hash, 'streams hash identically');
    await store.delete(hash);
    assert.equal(await store.has(hash), false);
    assert.equal(await code(store.get(hash)), 'UNAVAILABLE', 'deleted is Unavailable, not Corrupt');
  });
  test(`${kind}: oversize is rejected for bytes and streams`, async () => {
    const store = kind === 'memory' ? new MemoryContentStore(8) : (await fsStore(8)).store;
    assert.equal(await code(store.put(Buffer.alloc(9))), 'OVERSIZE');
    assert.equal(await code(store.put(Readable.from([Buffer.alloc(5), Buffer.alloc(5)]))), 'OVERSIZE');
  });
  test(`${kind}: malformed hashes never reach a path or key`, async () => {
    const store = kind === 'memory' ? new MemoryContentStore(8) : (await fsStore(8)).store;
    for (const bad of ['../../etc/passwd', 'A'.repeat(64), 'ab', '', `${'a'.repeat(63)}/`]) {
      assert.equal(await code(store.get(bad)), 'BAD_HASH');
      assert.equal(await code(store.delete(bad)), 'BAD_HASH');
      assert.equal(await code(store.has(bad)), 'BAD_HASH');
    }
  });
}
test('memory: silent corruption is detected as CORRUPT', async () => {
  const store = new MemoryContentStore(64);
  const hash = await store.put(Buffer.from('abc'));
  store.corruptForTest(hash);
  assert.equal(await code(store.get(hash)), 'CORRUPT');
});
test('fs: a hash mismatch on disk is CORRUPT; an absent file is UNAVAILABLE', async () => {
  const { store, root } = await fsStore();
  const hash = await store.put(Buffer.from('payload'));
  assert.equal(await code(store.get('0'.repeat(64))), 'UNAVAILABLE');
  await fsp.writeFile(path.join(root, hash.slice(0, 2), hash.slice(2, 4), hash), 'tampered');
  assert.equal(await code(store.get(hash)), 'CORRUPT');
});
test('fs: a torn write leaves only a temp file, never a final path, and leaves no temp after success', async () => {
  const { store, root } = await fsStore();
  await fsp.mkdir(path.join(root, '.tmp'), { recursive: true });
  await fsp.writeFile(path.join(root, '.tmp', 'put-crashed'), 'half');
  const hash = await store.put(Buffer.from('whole'));
  assert.equal(await store.has(contentHash(Buffer.from('half'))), false);
  assert.equal(await read(store, hash), 'whole');
  assert.deepEqual(await fsp.readdir(path.join(root, '.tmp')), ['put-crashed']);
});
test('fs: a symlink at the final path is not followed', async (t) => {
  const { store, root } = await fsStore();
  const hash = contentHash(Buffer.from('secret'));
  const outside = path.join(root, 'outside.txt');
  await fsp.writeFile(outside, 'secret');
  await fsp.mkdir(path.join(root, hash.slice(0, 2), hash.slice(2, 4)), { recursive: true });
  try {
    await fsp.symlink(outside, path.join(root, hash.slice(0, 2), hash.slice(2, 4), hash));
  } catch (error) {
    if ((error as { code?: unknown }).code === 'EPERM') {
      t.skip('creating symlinks needs a privilege on this system');
      return;
    }
    throw error;
  }
  assert.equal(await store.has(hash), false);
  assert.equal(await code(store.get(hash)), 'UNAVAILABLE');
});
test('fs: a unique-name with path characters cannot escape the temp directory', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'content-'));
  const store = new FsContentStore({ root, maxBytes: 64, uniqueName: () => '../../evil' });
  const hash = await store.put(Buffer.from('x'));
  assert.equal(await read(store, hash), 'x');
  assert.deepEqual((await fsp.readdir(root)).sort(), ['.tmp', hash.slice(0, 2)].sort());
});
