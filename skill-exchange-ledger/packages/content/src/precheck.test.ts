import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, contentHash } from '../../crypto/src/index.js';
import { KeywordPrecheck, MemoryContentStore, collectBytes, runPrecheck } from './index.js';

test('precheck: the ledger gets only the report hash and the result; the report stays in the store', async () => {
  const store = new MemoryContentStore(4096);
  const content = Buffer.from('this contains BadWord inside');
  const input = { contentHash: contentHash(content), content };
  const out = await runPrecheck(new KeywordPrecheck(['badword']), store, input);
  assert.equal(out.result, 'fail');
  const stored = (await collectBytes(await store.get(out.precheckRef), 4096)).toString('utf8');
  assert.equal(out.precheckRef, contentHash(Buffer.from(stored, 'utf8')));
  assert.equal(stored, canonical({ contentHash: input.contentHash, result: 'fail', reasons: ['keyword:badword'], model: 'fake-keyword' }));
});
test('precheck: clean content passes and the report hash is deterministic', async () => {
  const store = new MemoryContentStore(4096);
  const content = Buffer.from('fine');
  const input = { contentHash: contentHash(content), content };
  const a = await runPrecheck(new KeywordPrecheck(['badword']), store, input);
  const b = await runPrecheck(new KeywordPrecheck(['badword']), store, input);
  assert.equal(a.result, 'pass');
  assert.equal(a.precheckRef, b.precheckRef);
});
