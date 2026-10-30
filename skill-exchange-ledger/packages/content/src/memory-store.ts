import { Readable } from 'node:stream';
import type { Hash } from '../../domain/src/protocol.js';
import { ContentError } from './errors.js';
import { assertHash, collectBytes, hashOfBytes } from './store.js';
import type { ContentStore } from './store.js';

export class MemoryContentStore implements ContentStore {
  readonly #blobs = new Map<Hash, Buffer>();
  constructor(private readonly maxBytes: number) {}
  async put(bytes: Readable | Uint8Array): Promise<Hash> {
    const buffer = await collectBytes(bytes, this.maxBytes);
    const hash = hashOfBytes(buffer);
    this.#blobs.set(hash, buffer);
    return hash;
  }
  async get(hash: Hash): Promise<Readable> {
    assertHash(hash);
    const buffer = this.#blobs.get(hash);
    if (buffer === undefined) throw new ContentError('UNAVAILABLE', hash);
    if (hashOfBytes(buffer) !== hash) throw new ContentError('CORRUPT', hash);
    return Readable.from([Buffer.from(buffer)]);
  }
  async has(hash: Hash): Promise<boolean> { assertHash(hash); return this.#blobs.has(hash); }
  async delete(hash: Hash): Promise<void> { assertHash(hash); this.#blobs.delete(hash); }
  /** Test hook: flip a stored byte to simulate silent corruption. */
  corruptForTest(hash: Hash): void {
    const buffer = this.#blobs.get(hash);
    if (buffer !== undefined && buffer.length > 0) buffer[0] = ((buffer[0] ?? 0) ^ 1);
  }
}
