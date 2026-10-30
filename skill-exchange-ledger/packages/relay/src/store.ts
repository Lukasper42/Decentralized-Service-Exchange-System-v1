import type { Hash, Pubkey, Receipt, SignedEvent } from '../../domain/src/protocol.js';

/** One ledger row: the client-signed event and the relay-signed receipt that accepted it. */
export interface LedgerEntry { event: SignedEvent; receipt: Receipt }

/**
 * Append-only ledger store.
 *
 * Atomicity guarantee: an append either becomes a complete, checksummed, contiguously sequenced record that every
 * later read observes, or it leaves the store as it was; a torn final record is truncated during recovery and is
 * never observed by a reader. After an I/O failure the store refuses all further appends (it is "poisoned").
 */
export interface LedgerStore {
  /** Stores with a remote backend (Postgres) return a Promise; Relay.startAsync/submitAsync/closeAsync await it. Reads stay synchronous (served from the in-memory view). */
  open(): void | Promise<void>;
  close(): void | Promise<void>;
  /** Append one entry. Must carry receipt.sequence === tipSequence() + 1 and an unseen event hash. Throws on violation or I/O failure. */
  append(entry: LedgerEntry): void | Promise<void>;
  /** Entries with fromSequence <= sequence <= toSequence (inclusive), in order. */
  readRange(fromSequence: number, toSequence: number): LedgerEntry[];
  /** Hash of the signer's latest event, or null when the signer has no event. */
  signerTip(signer: Pubkey): Hash | null;
  findByEventHash(eventHash: Hash): LedgerEntry | null;
  tipSequence(): number;
  tipEntry(): LedgerEntry | null;
  all(): LedgerEntry[];
}

export class StoreError extends Error {
  constructor(message: string) { super(message); this.name = 'StoreError'; }
}
