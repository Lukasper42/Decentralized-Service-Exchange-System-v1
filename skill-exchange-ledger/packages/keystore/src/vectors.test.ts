import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SLIP10_SEED_HEX, SLIP10_VECTOR_1, BIP39_TREZOR_MNEMONIC, BIP39_TREZOR_SEED_HEX } from '../../testing/src/slip10-vectors.js';
import { deterministicEntropy, testWordlist } from '../../testing/src/keystore-fixtures.js';
import { PATH_ACCOUNT, PATH_RECOVERY, derivePath, parsePath, masterNode } from './slip10.js';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeed, generateSeedPhrase, parseWordlist, validateMnemonic } from './bip39.js';
import { keyPairFromSeed } from './keys.js';

// Independent SLIP-0010 reference: hex strings and Buffer.concat only, no shared code with slip10.ts.
function referenceDerive(seedHex: string, path: string): { key: string; chainCode: string } {
  let digest = createHmac('sha512', 'ed25519 seed').update(Buffer.from(seedHex, 'hex')).digest('hex');
  for (const segment of path.split('/').slice(1)) {
    const index = (Number.parseInt(segment, 10) + 0x80000000).toString(16).padStart(8, '0');
    digest = createHmac('sha512', Buffer.from(digest.slice(64), 'hex')).update(Buffer.from(`00${digest.slice(0, 64)}${index}`, 'hex')).digest('hex');
  }
  return { key: digest.slice(0, 64), chainCode: digest.slice(64) };
}

test('SLIP-0010: official Ed25519 vector 1 matches the implementation and the independent reference', () => {
  const reference = referenceDerive(SLIP10_SEED_HEX, "m/0'");
  assert.equal(derivePath(Buffer.from(SLIP10_SEED_HEX, 'hex'), "m/0'").key.toString('hex'), reference.key);
  const master = masterNode(Buffer.from(SLIP10_SEED_HEX, 'hex'));
  const first = SLIP10_VECTOR_1[0];
  assert.equal(master.key.toString('hex'), first.key);
  assert.equal(master.chainCode.toString('hex'), first.chainCode);
  const child = derivePath(Buffer.from(SLIP10_SEED_HEX, 'hex'), "m/0'");
  const second = SLIP10_VECTOR_1[1];
  assert.equal(child.key.toString('hex'), second.key);
  assert.equal(child.chainCode.toString('hex'), second.chainCode);
});

test('SLIP-0010: the fixed application paths are hardened, distinct and match the reference', () => {
  const seed = Buffer.from(mnemonicToSeed(BIP39_TREZOR_MNEMONIC, 'TREZOR'));
  const account = derivePath(seed, PATH_ACCOUNT);
  const recovery = derivePath(seed, PATH_RECOVERY);
  assert.notEqual(account.key.toString('hex'), recovery.key.toString('hex'));
  assert.equal(account.key.toString('hex'), referenceDerive(seed.toString('hex'), "m/19283'/0'/0'").key);
  assert.equal(recovery.key.toString('hex'), referenceDerive(seed.toString('hex'), "m/19283'/0'/1'").key);
  assert.throws(() => parsePath('m/0'), /hardened/);
  assert.throws(() => parsePath('x/0\''), /path/);
  assert.throws(() => parsePath(`m/${2 ** 31}'`), /range/);
  assert.throws(() => masterNode(Buffer.alloc(8)), /seed/);
});

test('BIP39: official TREZOR vector 1 seed (PBKDF2 part) and key-pair shape', () => {
  assert.equal(mnemonicToSeed(BIP39_TREZOR_MNEMONIC, 'TREZOR').toString('hex'), BIP39_TREZOR_SEED_HEX);
  const pair = keyPairFromSeed(derivePath(Buffer.from(BIP39_TREZOR_SEED_HEX, 'hex'), PATH_ACCOUNT).key);
  assert.equal(Buffer.from(pair.publicKey, 'base64').length, 44);
  assert.equal(Buffer.from(pair.privateKey, 'base64').length, 48);
});

// Independent BIP39 reference with BigInt: entropy+checksum as one big binary string.
function referenceMnemonic(entropyHex: string, words: readonly string[], sha: (hex: string) => string): string {
  const entropyBits = entropyHex.length * 4;
  const bitString = BigInt(`0x${entropyHex}`).toString(2).padStart(entropyBits, '0');
  const checksumBits = entropyBits / 32;
  const checksum = BigInt(`0x${sha(entropyHex)}`).toString(2).padStart(256, '0').slice(0, checksumBits);
  const all = bitString + checksum;
  const out: string[] = [];
  for (let i = 0; i < all.length; i += 11) out.push(words[Number.parseInt(all.slice(i, i + 11), 2)] ?? '?');
  return out.join(' ');
}
import { createHash } from 'node:crypto';
const shaHex = (hex: string): string => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

test('BIP39: entropy to mnemonic matches the BigInt reference for every strength, and roundtrips', () => {
  const wordlist = testWordlist();
  const entropy = deterministicEntropy('bip39-ref');
  for (const bytes of [16, 20, 24, 28, 32]) {
    const raw = Buffer.from(entropy.bytes(bytes));
    const mnemonic = entropyToMnemonic(raw, wordlist);
    assert.equal(mnemonic, referenceMnemonic(raw.toString('hex'), wordlist.words, shaHex));
    const back = mnemonicToEntropy(mnemonic, wordlist);
    assert.ok(back.ok && back.value.equals(raw));
  }
  const zero = entropyToMnemonic(Buffer.alloc(16), wordlist);
  assert.equal(zero, `${Array(11).fill(wordlist.words[0]).join(' ')} ${wordlist.words[3]}`, 'all-zero entropy ends in word index 3 (the checksum "about" position in BIP39)');
});

test('BIP39: bad input is rejected with stable codes and never throws', () => {
  const wordlist = testWordlist();
  const good = entropyToMnemonic(Buffer.alloc(16, 7), wordlist);
  assert.equal(validateMnemonic(good, wordlist).ok, true);
  const words = good.split(' ');
  // A wrong last word breaks the 4-bit checksum for all but one candidate in sixteen; pick one that does.
  const swapped = wordlist.words.slice(0, 32).map((w) => [...words.slice(0, 11), w].join(' ')).find((m) => m !== good && !validateMnemonic(m, wordlist).ok) ?? '';
  assert.notEqual(swapped, '');
  const cases: unknown[] = [swapped, `${good} extra`, words.slice(0, 11).join(' '), 'zzz '.repeat(12), 42, null, undefined, 'x'.repeat(5000)];
  for (const input of cases) {
    const result = validateMnemonic(input, wordlist);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'E_BAD_MNEMONIC');
  }
  assert.throws(() => entropyToMnemonic(Buffer.alloc(15), wordlist), /entropy/);
  assert.throws(() => generateSeedPhrase(deterministicEntropy('x'), wordlist, 100), /strength/);
});

test('wordlist: structure and pinned digest are enforced', () => {
  const words = Array.from({ length: 2048 }, (_, i) => `w${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}${String.fromCharCode(97 + Math.floor(i / 676))}`);
  assert.throws(() => parseWordlist(`${words.slice(0, 2047).join('\n')}\n`), /2048/);
  assert.throws(() => parseWordlist(`${words.join('\n')}\n`), /malformed|sorted/);
  const good = `${testWordlist().words.join('\n')}\n`;
  assert.throws(() => parseWordlist(good, 'not-the-digest'), /digest mismatch/);
  const duplicate = good.split('\n'); duplicate[5] = duplicate[4] ?? ''; assert.throws(() => parseWordlist(duplicate.join('\n')), /sorted/);
});
