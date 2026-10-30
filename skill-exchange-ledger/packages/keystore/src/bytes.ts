import { KeystoreError } from './errors.js';
import type { EntropyPort } from './ports.js';

export function wipe(...buffers: Array<Uint8Array | null | undefined>): void {
  for (const buffer of buffers) if (buffer !== null && buffer !== undefined) buffer.fill(0);
}
export function u32be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}
/** Draw exactly `count` bytes from the port or fail; a short read is never accepted. */
export function takeBytes(port: EntropyPort | undefined, count: number): Buffer {
  if (port === undefined || typeof port.bytes !== 'function') throw new KeystoreError('E_NO_PORT', 'entropy port is required');
  const out = port.bytes(count);
  if (!(out instanceof Uint8Array) || out.length !== count) throw new KeystoreError('E_NO_PORT', `entropy returned wrong length for ${count}`);
  return Buffer.from(out);
}
/** Uniform integer in [0, bound) by rejection sampling over single bytes (bound <= 256). */
export function uniformIndex(port: EntropyPort, bound: number): number {
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 256) throw new KeystoreError('E_BAD_INPUT', 'bound must be 1..256');
  const limit = 256 - (256 % bound);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const byte = takeBytes(port, 1)[0];
    if (byte !== undefined && byte < limit) return byte % bound;
  }
  throw new KeystoreError('E_NO_PORT', 'entropy source rejected too many samples');
}
