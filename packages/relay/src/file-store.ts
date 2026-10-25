import { closeSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, sha256Hex } from '../../crypto/src/index.js';
import { MemoryStore } from './memory-store.js';
import { StoreError } from './store.js';
import type { LedgerEntry } from './store.js';

/** Byte-level file operations, injectable so tests can simulate a crash after k bytes. */
export interface FileOps {
  open(path: string): number;
  /** Write the whole buffer or throw; a partial write that then throws leaves the written prefix on disk. */
  write(fd: number, bytes: Buffer): void;
  sync(fd: number): void;
  truncate(fd: number, length: number): void;
  close(fd: number): void;
  readAll(path: string): Buffer;
  syncDirectory(path: string): void;
}
/** Write positions per handle: the file is opened read-write (not append) because Windows cannot ftruncate an append handle. */
const positions = new Map<number, number>();
export const nodeFileOps: FileOps = {
  open(path) {
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, 'a'));
    const fd = openSync(path, 'r+');
    positions.set(fd, fstatSync(fd).size);
    return fd;
  },
  write(fd, bytes) {
    let offset = 0;
    let position = positions.get(fd) ?? 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, position);
      offset += written;
      position += written;
      positions.set(fd, position);
    }
  },
  sync(fd) { fsyncSync(fd); },
  truncate(fd, length) { ftruncateSync(fd, length); positions.set(fd, length); },
  close(fd) { positions.delete(fd); closeSync(fd); },
  readAll(path) { try { return readFileSync(path); } catch { return Buffer.alloc(0); } },
  syncDirectory(path) {
    if (process.platform === 'win32') return; // Windows cannot fsync a directory handle (EPERM)
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  },
};

export type FsyncPolicy = 'always' | 'none';
export interface FileStoreOptions { path: string; fsync?: FsyncPolicy; ops?: FileOps }

function isEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { event?: unknown; receipt?: unknown };
  return typeof v.event === 'object' && v.event !== null && typeof v.receipt === 'object' && v.receipt !== null;
}

/**
 * Durable store: one append-only NDJSON file, `<sha256 of canonical json> <canonical json>\n` per entry.
 * Recovery on open(): the first line that is incomplete, fails its checksum, does not re-serialize to the same
 * canonical bytes, or breaks sequence contiguity is truncated together with everything after it.
 */
export class FileStore extends MemoryStore {
  readonly #path: string;
  readonly #fsync: FsyncPolicy;
  readonly #ops: FileOps;
  #fd: number | null = null;
  #size = 0;
  #poisoned = false;
  /** Number of bytes removed by the last recovery (0 when the file was clean). */
  recoveredBytes = 0;

  constructor(options: FileStoreOptions) {
    super();
    this.#path = options.path;
    this.#fsync = options.fsync ?? 'always';
    this.#ops = options.ops ?? nodeFileOps;
  }

  override open(): void {
    if (this.#fd !== null) throw new StoreError('already open');
    const existed = this.#ops.readAll(this.#path).length > 0;
    const fd = this.#ops.open(this.#path);
    if (!existed && this.#fsync === 'always') this.#ops.syncDirectory(dirname(this.#path));
    const data = this.#ops.readAll(this.#path);
    let offset = 0;
    while (offset < data.length) {
      const end = data.indexOf(0x0a, offset);
      if (end === -1) break;
      const entry = this.#parseLine(data.subarray(offset, end).toString('utf8'));
      if (entry === null) break;
      let hash: string;
      try { hash = this.check(entry); } catch { break; }
      this.index(entry, hash);
      offset = end + 1;
    }
    this.recoveredBytes = data.length - offset;
    if (this.recoveredBytes > 0) {
      this.#ops.truncate(fd, offset);
      if (this.#fsync === 'always') this.#ops.sync(fd);
    }
    this.#size = offset;
    this.#fd = fd;
    this.#poisoned = false;
  }
  #parseLine(line: string): LedgerEntry | null {
    const space = line.indexOf(' ');
    if (space !== 64) return null;
    const checksum = line.slice(0, space);
    const body = line.slice(space + 1);
    if (sha256Hex(body) !== checksum) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return null; }
    if (!isEntry(parsed)) return null;
    try { if (canonical(parsed) !== body) return null; } catch { return null; }
    return parsed;
  }
  override close(): void {
    if (this.#fd !== null) { this.#ops.close(this.#fd); this.#fd = null; }
  }
  override append(entry: LedgerEntry): void {
    if (this.#fd === null) throw new StoreError('store is not open');
    if (this.#poisoned) throw new StoreError('store is poisoned by an earlier I/O failure; reopen it');
    const hash = this.check(entry);
    const body = canonical({ event: entry.event, receipt: entry.receipt });
    const record = Buffer.from(`${sha256Hex(body)} ${body}\n`, 'utf8');
    try {
      this.#ops.write(this.#fd, record);
      if (this.#fsync === 'always') this.#ops.sync(this.#fd);
    } catch (error) {
      this.#poisoned = true;
      throw new StoreError(`I/O failure during append: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    this.#size += record.length;
    this.index(entry, hash);
  }
  get fileSize(): number { return this.#size; }
}
