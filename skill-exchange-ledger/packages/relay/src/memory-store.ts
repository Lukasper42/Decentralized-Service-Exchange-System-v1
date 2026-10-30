import type { Hash, Pubkey } from '../../domain/src/protocol.js';
import { eventHash } from '../../crypto/src/index.js';
import { StoreError } from './store.js';
import type { LedgerEntry, LedgerStore } from './store.js';

/** In-memory store: same contract as the file store, no durability. Used by tests and the replay tooling. */
export class MemoryStore implements LedgerStore {
  protected readonly entries: LedgerEntry[] = [];
  protected readonly byEventHash = new Map<Hash, LedgerEntry>();
  protected readonly tips = new Map<Pubkey, Hash>();

  open(): void { /* nothing to open */ }
  close(): void { /* nothing to close */ }

  /** Shared validation for both stores; throws StoreError and changes nothing on violation. */
  protected check(entry: LedgerEntry): Hash {
    if (entry.receipt.sequence !== this.entries.length + 1) throw new StoreError(`sequence ${entry.receipt.sequence} is not contiguous (tip ${this.entries.length})`);
    const hash = eventHash(entry.event);
    if (entry.receipt.eventHash !== hash) throw new StoreError('receipt does not identify the event');
    if (this.byEventHash.has(hash)) throw new StoreError('duplicate event hash');
    return hash;
  }
  protected index(entry: LedgerEntry, hash: Hash): void {
    this.entries.push(entry);
    this.byEventHash.set(hash, entry);
    this.tips.set(entry.event.signer, hash);
  }
  append(entry: LedgerEntry): void { this.index(entry, this.check(entry)); }
  readRange(fromSequence: number, toSequence: number): LedgerEntry[] {
    if (!Number.isSafeInteger(fromSequence) || !Number.isSafeInteger(toSequence) || fromSequence < 1 || toSequence < fromSequence) return [];
    return this.entries.slice(fromSequence - 1, toSequence);
  }
  signerTip(signer: Pubkey): Hash | null { return this.tips.get(signer) ?? null; }
  findByEventHash(hash: Hash): LedgerEntry | null { return this.byEventHash.get(hash) ?? null; }
  tipSequence(): number { return this.entries.length; }
  tipEntry(): LedgerEntry | null { return this.entries[this.entries.length - 1] ?? null; }
  all(): LedgerEntry[] { return [...this.entries]; }
}
