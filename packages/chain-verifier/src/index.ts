import type { DomainError, Receipt, Result, SignedEvent } from '../../domain/src/protocol.js';
import { eventHash, hash, verifyReceipt } from '../../crypto/src/index.js';
import { validateEvent } from '../../validation/src/index.js';

export interface LedgerEntry { event: SignedEvent; receipt: Receipt }
export interface VerifiedChain { tipSequence: number; tipEventHash: string | null; tipReceiptHash: string | null }

function invalid(code: string, message: string, path: string): Result<never> {
  return { ok: false, error: { code, message, path } };
}

/** Verify every event and signed receipt in a complete ledger prefix. */
export function verifyChain(entries: readonly LedgerEntry[], relayPublicKey: string, now: number): Result<VerifiedChain> {
  let previousEventHash: string | null = null;
  let previousReceiptHash: string | null = null;
  for (const [index, entry] of entries.entries()) {
    const result = verifyEntry(entry, index, previousEventHash, previousReceiptHash, relayPublicKey, now);
    if (!result.ok) return result;
    previousEventHash = eventHash(entry.event);
    previousReceiptHash = receiptHash(entry.receipt);
  }
  return { ok: true, value: { tipSequence: entries.length, tipEventHash: previousEventHash, tipReceiptHash: previousReceiptHash } };
}

function verifyEntry(
  entry: LedgerEntry,
  index: number,
  previousEventHash: string | null,
  previousReceiptHash: string | null,
  relayPublicKey: string,
  now: number,
): Result<true> {
  if (!entry || !entry.event || !entry.receipt) return invalid('ENVELOPE', 'Missing event or receipt', `[${index}]`);
  const eventResult = validateEvent(entry.event, now);
  if (!eventResult.ok) return eventResult;
  if (entry.event.prevHash !== previousEventHash) return invalid('CHAIN_LINK', 'Event previous hash does not match prior event', `[${index}].event.prevHash`);
  if (entry.receipt.sequence !== index + 1) return invalid('RECEIPT_SEQUENCE', 'Receipt sequence is not contiguous', `[${index}].receipt.sequence`);
  if (entry.receipt.eventHash !== eventHash(entry.event)) return invalid('RECEIPT_EVENT_HASH', 'Receipt does not identify this event', `[${index}].receipt.eventHash`);
  if (entry.receipt.previousReceiptHash !== previousReceiptHash) return invalid('RECEIPT_LINK', 'Receipt link does not match prior receipt', `[${index}].receipt.previousReceiptHash`);
  if (!verifyReceipt(entry.receipt, relayPublicKey)) return invalid('SIGNATURE', 'Invalid relay receipt signature', `[${index}].receipt.signature`);
  return { ok: true, value: true };
}

function receiptHash(receipt: Receipt): string {
  const { signature: _signature, ...unsignedReceipt } = receipt;
  return hash(unsignedReceipt);
}

/** Preserve a stable error type for callers that need to render verification failures. */
export type ChainVerificationError = DomainError;
