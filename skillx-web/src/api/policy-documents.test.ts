import assert from 'node:assert/strict';
import test from 'node:test';
import { createPolicyDocumentFiles } from './policy-documents.js';

const hash = 'a'.repeat(64);
const genesis = '{"version":1}';

test('policy document file port resolves only the requested hash', () => {
  const document = { version: 2, policyId: 'beta' };
  const files = createPolicyDocumentFiles(genesis, JSON.stringify({ [hash]: document }));

  assert.equal(files.readText('SKILLX_GENESIS_JSON'), genesis);
  assert.deepEqual(JSON.parse(files.readText(`policies/${hash}.json`)), document);
  assert.throws(() => files.readText(`policies/${'b'.repeat(64)}.json`), /not configured/);
  assert.throws(() => files.readText('policies/../genesis.json'), /Unknown/);
});

test('policy document manifest rejects malformed and unsafe input', () => {
  assert.throws(() => createPolicyDocumentFiles(genesis, '{'), /Invalid policy document manifest JSON/);
  assert.throws(() => createPolicyDocumentFiles(genesis, '[]'), /must be an object/);
  assert.throws(() => createPolicyDocumentFiles(genesis, JSON.stringify({ nope: {} })), /Invalid policy document manifest hash/);

  const unsafe = JSON.parse(`{"${hash}":{"constructor":{"polluted":true}}}`) as unknown;
  assert.throws(() => createPolicyDocumentFiles(genesis, JSON.stringify(unsafe)), /Unsafe policy document key/);
});

test('policy document manifest and individual documents are size limited', () => {
  const tooLargeDocument = { content: 'x'.repeat(32_769) };
  assert.throws(
    () => createPolicyDocumentFiles(genesis, JSON.stringify({ [hash]: tooLargeDocument })),
    /Policy document exceeds size limit/,
  );
  assert.throws(
    () => createPolicyDocumentFiles(genesis, JSON.stringify({ padding: 'x'.repeat(49_153) })),
    /manifest exceeds size limit/,
  );
});


