import { createHash, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeystoreError, kerr, kok } from './errors.js';
import type { KResult } from './errors.js';
import { takeBytes, wipe } from './bytes.js';
import type { EntropyPort } from './ports.js';

/**
 * SHA-256 of the canonical BIP39 English wordlist file (LF endings, trailing newline).
 * UNVERIFIED in this repository: confirm it against your own copy of bip-0039/english.txt before trusting it.
 */
export const EXPECTED_WORDLIST_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';
export interface Wordlist { readonly words: readonly string[]; readonly index: ReadonlyMap<string, number> }

const VALID_ENTROPY_BYTES = [16, 20, 24, 28, 32];
const VALID_WORD_COUNTS = [12, 15, 18, 21, 24];

/** Parse and structurally validate a wordlist: 2048 sorted unique lowercase words. Optional pinned digest. */
export function parseWordlist(text: string, pinnedSha256?: string): Wordlist {
  if (pinnedSha256 !== undefined) {
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    if (digest !== pinnedSha256) throw new KeystoreError('E_BAD_WORDLIST', `digest mismatch (${digest})`);
  }
  const words = text.split('\n');
  if (words.length > 0 && words[words.length - 1] === '') words.pop();
  if (words.length !== 2048) throw new KeystoreError('E_BAD_WORDLIST', `expected 2048 words, got ${words.length}`);
  let previous = '';
  for (const [i, word] of words.entries()) {
    if (!/^[a-z]+$/.test(word)) throw new KeystoreError('E_BAD_WORDLIST', `malformed word at line ${i + 1}`);
    if (i > 0 && !(previous < word)) throw new KeystoreError('E_BAD_WORDLIST', `not strictly sorted at line ${i + 1}`);
    previous = word;
  }
  return { words: Object.freeze([...words]), index: new Map(words.map((word, i) => [word, i] as const)) };
}

/** Where the vendored file lives, relative to the compiled module (dist/packages/keystore/src). */
export function vendoredWordlistPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'keystore', 'data', 'bip39-english.txt');
}
/** Load the vendored BIP39 English wordlist and verify its pinned digest. */
export function loadVendoredWordlist(): Wordlist {
  let text: string;
  try { text = readFileSync(vendoredWordlistPath(), 'utf8'); }
  catch { throw new KeystoreError('E_BAD_WORDLIST', 'packages/keystore/data/bip39-english.txt is missing; see packages/keystore/data/README.md'); }
  return parseWordlist(text, EXPECTED_WORDLIST_SHA256);
}

function bitsOf(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  for (const byte of bytes) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  return bits;
}

export function entropyToMnemonic(entropy: Uint8Array, wordlist: Wordlist): string {
  if (!VALID_ENTROPY_BYTES.includes(entropy.length)) throw new KeystoreError('E_BAD_INPUT', 'entropy must be 16/20/24/28/32 bytes');
  const checksumBits = (entropy.length * 8) / 32;
  const bits = [...bitsOf(entropy), ...bitsOf(createHash('sha256').update(entropy).digest()).slice(0, checksumBits)];
  const out: string[] = [];
  for (let i = 0; i < bits.length; i += 11) {
    let index = 0;
    for (let j = 0; j < 11; j += 1) index = (index << 1) | (bits[i + j] ?? 0);
    const word = wordlist.words[index];
    if (word === undefined) throw new KeystoreError('E_BAD_WORDLIST', 'index out of range');
    out.push(word);
  }
  return out.join(' ');
}

export function mnemonicToEntropy(mnemonic: unknown, wordlist: Wordlist): KResult<Buffer> {
  if (typeof mnemonic !== 'string' || mnemonic.length > 1024) return kerr('E_BAD_MNEMONIC', 'mnemonic must be a string');
  const parts = mnemonic.normalize('NFKD').trim().split(/\s+/);
  if (!VALID_WORD_COUNTS.includes(parts.length)) return kerr('E_BAD_MNEMONIC', `unexpected word count ${parts.length}`);
  const bits: number[] = [];
  for (const word of parts) {
    const index = wordlist.index.get(word);
    if (index === undefined) return kerr('E_BAD_MNEMONIC', 'word not in wordlist');
    for (let b = 10; b >= 0; b -= 1) bits.push((index >> b) & 1);
  }
  const checksumBits = parts.length / 3;
  const entropyBits = bits.length - checksumBits;
  const entropy = Buffer.alloc(entropyBits / 8);
  for (let i = 0; i < entropyBits; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | (bits[i + j] ?? 0);
    entropy[i / 8] = value;
  }
  const expected = bitsOf(createHash('sha256').update(entropy).digest()).slice(0, checksumBits);
  for (let i = 0; i < checksumBits; i += 1) if (bits[entropyBits + i] !== expected[i]) { wipe(entropy); return kerr('E_BAD_MNEMONIC', 'checksum mismatch'); }
  return kok(entropy);
}

export function validateMnemonic(mnemonic: unknown, wordlist: Wordlist): KResult<true> {
  const entropy = mnemonicToEntropy(mnemonic, wordlist);
  if (!entropy.ok) return entropy;
  wipe(entropy.value);
  return kok(true);
}

/** BIP39 seed (PBKDF2-HMAC-SHA512, 2048 rounds). The BIP39 passphrase is fixed to the empty string in v1. */
export function mnemonicToSeed(mnemonic: string, bip39Passphrase = ''): Buffer {
  const m = mnemonic.normalize('NFKD');
  const salt = `mnemonic${bip39Passphrase.normalize('NFKD')}`;
  return pbkdf2Sync(Buffer.from(m, 'utf8'), Buffer.from(salt, 'utf8'), 2048, 64, 'sha512');
}

export function generateSeedPhrase(entropy: EntropyPort, wordlist: Wordlist, strengthBits = 128): { mnemonic: string; seed: Buffer } {
  if (![128, 160, 192, 224, 256].includes(strengthBits)) throw new KeystoreError('E_BAD_INPUT', 'strength must be 128/160/192/224/256');
  const raw = takeBytes(entropy, strengthBits / 8);
  try {
    const mnemonic = entropyToMnemonic(raw, wordlist);
    return { mnemonic, seed: mnemonicToSeed(mnemonic) };
  } finally { wipe(raw); }
}
