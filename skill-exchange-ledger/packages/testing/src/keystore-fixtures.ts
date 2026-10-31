/** Test support for the keystore: deterministic entropy, fixed clock and a generated test wordlist. */
import { createHash } from 'node:crypto';
import { parseWordlist } from '../../keystore/src/bip39.js';
import type { Wordlist } from '../../keystore/src/bip39.js';
import type { ClockPort, EntropyPort } from '../../keystore/src/ports.js';

/** Deterministic byte stream: SHA-256(label || counter). Never used outside tests. */
export function deterministicEntropy(label: string): EntropyPort & { drawn: number } {
  let counter = 0;
  let pool = Buffer.alloc(0);
  const port = {
    drawn: 0,
    bytes(count: number): Uint8Array {
      while (pool.length < count) {
        pool = Buffer.concat([pool, createHash('sha256').update(`${label}/${counter}`).digest()]);
        counter += 1;
      }
      const out = Uint8Array.from(pool.subarray(0, count));
      pool = pool.subarray(count);
      port.drawn += count;
      return out;
    },
  };
  return port;
}
export const fixedClock = (ms: number): ClockPort => ({ nowMs: () => ms });

/**
 * A structurally valid 2048-word test list (three letters, sorted). It is NOT the BIP39 list; it exists so the
 * mnemonic algorithm, which is list-agnostic, can be exercised without the vendored data file.
 */
export function testWordlist(): Wordlist {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const words: string[] = [];
  for (let i = 0; i < 2048; i += 1) words.push(`${letters[Math.floor(i / 676)] ?? 'a'}${letters[Math.floor(i / 26) % 26] ?? 'a'}${letters[i % 26] ?? 'a'}`);
  return parseWordlist(`${words.join('\n')}\n`);
}
