import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { entropyToMnemonic, loadVendoredWordlist, mnemonicToEntropy, vendoredWordlistPath } from './bip39.js';

test('vendored wordlist: digest, structure and the official all-zero entropy vector', (t) => {
  if (!existsSync(vendoredWordlistPath())) { t.skip('packages/keystore/data/bip39-english.txt is not vendored; see data/README.md'); return; }
  const wordlist = loadVendoredWordlist();
  assert.equal(wordlist.words.length, 2048);
  assert.equal(wordlist.words[0], 'abandon');
  assert.equal(wordlist.words[2047], 'zoo');
  const mnemonic = entropyToMnemonic(Buffer.alloc(16), wordlist);
  assert.equal(mnemonic, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const back = mnemonicToEntropy(mnemonic, wordlist);
  assert.ok(back.ok && back.value.equals(Buffer.alloc(16)));
});

test('vendored wordlist: a missing file fails closed with a clear code', (t) => {
  if (existsSync(vendoredWordlistPath())) { t.skip('the wordlist file is present'); return; }
  assert.throws(() => loadVendoredWordlist(), /E_BAD_WORDLIST/);
});
