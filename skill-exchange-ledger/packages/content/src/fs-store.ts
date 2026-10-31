import { constants, createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Hash } from '../../domain/src/protocol.js';
import { ContentError } from './errors.js';
import { assertHash, collectBytes, hashOfBytes } from './store.js';
import type { ContentStore } from './store.js';

export interface FsContentStoreOptions {
  root: string;
  maxBytes: number;
  /** Unique temporary file name per call (injected: the library has no randomness or clock of its own). */
  uniqueName: () => string;
}
function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
}

/**
 * Local content-addressed store at `<root>/<aa>/<bb>/<hash>`. Writes go to `<root>/.tmp/<unique>` and are renamed into
 * place, so a torn write never appears at a final path. Reads refuse symlinks and verify the SHA-256 before serving.
 * The hash is validated against /^[0-9a-f]{64}$/ before any path exists, so traversal through it is impossible.
 */
export class FsContentStore implements ContentStore {
  readonly #root: string;
  readonly #tmp: string;
  readonly #options: FsContentStoreOptions;
  #ready: Promise<void> | null = null;
  constructor(options: FsContentStoreOptions) {
    this.#options = options;
    this.#root = path.resolve(options.root);
    this.#tmp = path.join(this.#root, '.tmp');
  }
  #init(): Promise<void> {
    this.#ready ??= fsp.mkdir(this.#tmp, { recursive: true }).then(() => undefined);
    return this.#ready;
  }
  #pathFor(hash: Hash): string {
    assertHash(hash);
    return path.join(this.#root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }
  async put(bytes: Readable | Uint8Array): Promise<Hash> {
    await this.#init();
    const buffer = await collectBytes(bytes, this.#options.maxBytes);
    const hash = hashOfBytes(buffer);
    const temp = path.join(this.#tmp, `put-${this.#options.uniqueName().replace(/[^A-Za-z0-9_-]/g, '')}`);
    try {
      await pipeline(Readable.from([buffer]), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const handle = await fsp.open(temp, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      const final = this.#pathFor(hash);
      await fsp.mkdir(path.dirname(final), { recursive: true });
      await fsp.rename(temp, final);
    } catch (error) {
      await fsp.unlink(temp).catch(() => undefined);
      throw error;
    }
    return hash;
  }
  async get(hash: Hash): Promise<Readable> {
    await this.#init();
    const file = this.#pathFor(hash);
    let handle: fsp.FileHandle;
    try { handle = await fsp.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ELOOP') throw new ContentError('UNAVAILABLE', hash);
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.#options.maxBytes) throw new ContentError('CORRUPT', hash);
      const buffer = await collectBytes(handle.createReadStream({ autoClose: false }), this.#options.maxBytes).catch((error: unknown) => {
        if (error instanceof ContentError && error.code === 'OVERSIZE') throw new ContentError('CORRUPT', hash);
        throw error;
      });
      if (hashOfBytes(buffer) !== hash) throw new ContentError('CORRUPT', hash);
      return Readable.from([buffer]);
    } finally { await handle.close(); }
  }
  async has(hash: Hash): Promise<boolean> {
    await this.#init();
    try { const stat = await fsp.lstat(this.#pathFor(hash)); return stat.isFile() && !stat.isSymbolicLink(); }
    catch (error) { if (errnoCode(error) === 'ENOENT') return false; throw error; }
  }
  async delete(hash: Hash): Promise<void> {
    await this.#init();
    try { await fsp.unlink(this.#pathFor(hash)); } catch (error) { if (errnoCode(error) !== 'ENOENT') throw error; }
  }
}
