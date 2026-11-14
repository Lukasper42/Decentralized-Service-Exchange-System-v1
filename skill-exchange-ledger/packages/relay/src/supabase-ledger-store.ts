import { canonical, sha256Hex } from '../../crypto/src/index.js';
import type { LedgerEntry } from './store.js';
import { StoreError } from './store.js';
import { MemoryStore } from './memory-store.js';

/** Narrow transport port so the relay core does not depend on Supabase's HTTP client. */
export interface SupabaseRpcPort {
  rpc<T = unknown>(functionName: string, args?: Readonly<Record<string, unknown>>): Promise<T>;
}

interface LedgerRow {
  sequence: number | string;
  checksum: string;
  entry_json: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLedgerEntry(value: unknown): LedgerEntry {
  if (!isRecord(value)) throw new StoreError('ledger entry is not an object');
  const event = value['event'];
  const receipt = value['receipt'];
  if (!isRecord(event) || !isRecord(receipt)) {
    throw new StoreError('ledger entry must contain event and receipt objects');
  }
  if (typeof event['signer'] !== 'string' ||
      typeof receipt['sequence'] !== 'number' ||
      !Number.isSafeInteger(receipt['sequence']) ||
      typeof receipt['eventHash'] !== 'string') {
    throw new StoreError('ledger entry has invalid required fields');
  }
  return { event: event as unknown as LedgerEntry['event'], receipt: receipt as unknown as LedgerEntry['receipt'] };
}

function positiveSequence(value: unknown): number {
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new StoreError('invalid persisted ledger sequence');
  }
  return parsed;
}

/**
 * A request-scoped, replayable ledger store backed by Supabase Database Functions.
 *
 * The database append RPC must lock its singleton guard row, compare the expected
 * sequence and signer tip, and insert in one transaction. This class deliberately
 * does not hold a database connection or session-level advisory lock.
 */
export class SupabaseLedgerStore extends MemoryStore {
  private readonly rpc: SupabaseRpcPort;
  private opened = false;

  constructor(rpc: SupabaseRpcPort) {
    super();
    this.rpc = rpc;
  }

  override async open(): Promise<void> {
    if (this.opened || this.entries.length !== 0) {
      throw new StoreError('store is already open or has already been used');
    }

    let rows: unknown;
    try {
      rows = await this.rpc.rpc<unknown>('skillx_runtime_ledger_load');
    } catch {
      throw new StoreError('failed to load the persisted ledger');
    }

    if (!Array.isArray(rows)) {
      throw new StoreError('persisted ledger response is not an array');
    }

    for (let index = 0; index < rows.length; index += 1) {
      const raw = rows[index];
      if (!isRecord(raw)) throw new StoreError(`invalid persisted ledger row ${index + 1}`);

      const sequence = positiveSequence(raw['sequence']);
      if (sequence !== index + 1) {
        throw new StoreError(`persisted ledger sequence gap at row ${index + 1}`);
      }
      const checksum = raw['checksum'];
      const entryJson = raw['entry_json'];
      if (typeof checksum !== 'string' || typeof entryJson !== 'string') {
        throw new StoreError(`invalid persisted ledger data at row ${index + 1}`);
      }
      if (sha256Hex(entryJson) !== checksum) {
        throw new StoreError(`persisted ledger checksum mismatch at row ${index + 1}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(entryJson) as unknown;
      } catch {
        throw new StoreError(`persisted ledger JSON is invalid at row ${index + 1}`);
      }
      if (canonical(parsed) !== entryJson) {
        throw new StoreError(`persisted ledger JSON is not canonical at row ${index + 1}`);
      }

      const entry = readLedgerEntry(parsed);
      const hash = this.check(entry);
      this.index(entry, hash);
    }

    this.opened = true;
  }

  override async append(entry: LedgerEntry): Promise<void> {
    if (!this.opened) throw new StoreError('store is not open');

    const hash = this.check(entry);
    let entryJson: string;
    try {
      entryJson = canonical(entry);
    } catch {
      throw new StoreError('ledger entry cannot be encoded');
    }

    try {
      await this.rpc.rpc('skillx_runtime_ledger_append', {
        p_sequence: entry.receipt.sequence,
        p_event_hash: hash,
        p_signer: entry.event.signer,
        p_prev_hash: entry.event.prevHash ?? null,
        p_checksum: sha256Hex(entryJson),
        p_entry_json: entryJson,
      });
    } catch {
      // The caller receives a generic store error. Database details and credentials
      // must never escape through the public Relay HTTP response.
      throw new StoreError('Supabase rejected or could not confirm the ledger append');
    }

    this.index(entry, hash);
  }

  override async close(): Promise<void> {
    this.opened = false;
  }
}
