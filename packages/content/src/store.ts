import type { Readable } from 'node:stream';
import { contentHash } from '../../crypto/src/index.js';
import type { Hash } from '../../domain/src/protocol.js';
import { ContentError } from './errors.js';

/** Content-addressed blob store. The address is the SHA-256 of the raw bytes, exactly as in the protocol. */
export interface ContentStore {
  put(bytes: Readable | Uint8Array): Promise<Hash>;
  /** Verified bytes as a stream. Throws UNAVAILABLE when absent and CORRUPT when the bytes do not match the hash. */
  get(hash: Hash): Promise<Readable>;
  has(hash: Hash): Promise<boolean>;
  delete(hash: Hash): Promise<void>;
}
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const HASH = /^[0-9a-f]{64}$/;
/** Validate before any path or map key is built from a hash. */
export function assertHash(value: unknown): Hash {
  if (typeof value !== 'string' || !HASH.test(value)) throw new ContentError('BAD_HASH', 'not a 64-character lowercase hex hash');
  return value;
}
export async function collectBytes(source: Readable | Uint8Array, maxBytes: number): Promise<Buffer> {
  if (source instanceof Uint8Array) {
    if (source.length > maxBytes) throw new ContentError('OVERSIZE', `limit ${maxBytes}`);
    return Buffer.from(source);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBytes) throw new ContentError('OVERSIZE', `limit ${maxBytes}`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}
export const hashOfBytes = (bytes: Uint8Array): Hash => contentHash(bytes);
