import type { DomainError, Hash, Receipt, Result, Sig, SignedEvent } from '../../domain/src/protocol.js';
import { err, ok } from '../../domain/src/protocol.js';
import type { RelayKeyRange, SignerResolver } from '../../domain/src/ports.js';
import { eventHash, receiptHash, relayKeyId, verifyCheckpoint, verifyReceipt } from '../../crypto/src/index.js';
import { validateEvent } from '../../validation/src/index.js';

export type { RelayKeyRange, SignerResolver } from '../../domain/src/ports.js';

export interface LedgerEntry { event: SignedEvent; receipt: Receipt }
export interface VerifiedChain {
  tipSequence: number;
  tipEventHash: Hash | null;
  tipReceiptHash: Hash | null;
  /** Latest event hash per signer pubkey. */
  signerTips: ReadonlyMap<string, Hash>;
  /** 'skipped' when no SignerResolver was supplied: L2 account checks did NOT run. */
  accountChecks: 'skipped' | 'applied';
}

const HASH = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function strictIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

/**
 * Relay key ranges must be well formed and must not overlap.
 * SPEC-GAP: section 10 defines no code for malformed or overlapping key ranges; the conservative choice is
 * KEY_UNKNOWN, because no key can be trusted for the affected sequences.
 */
function checkKeyRanges(ranges: readonly RelayKeyRange[]): Result<true> {
  const sorted: RelayKeyRange[] = [];
  for (const [index, range] of ranges.entries()) {
    const path = `relayKeys[${index}]`;
    if (typeof range !== 'object' || range === null) return err('KEY_UNKNOWN', 'Malformed relay key range', path);
    if (!Number.isSafeInteger(range.validFromSequence) || range.validFromSequence < 1) return err('KEY_UNKNOWN', 'validFromSequence must be an integer >= 1', `${path}.validFromSequence`);
    if (range.validToSequence !== null && (!Number.isSafeInteger(range.validToSequence) || range.validToSequence <= range.validFromSequence)) {
      return err('KEY_UNKNOWN', 'validToSequence must be null or greater than validFromSequence', `${path}.validToSequence`);
    }
    if (typeof range.pubkey !== 'string' || typeof range.keyId !== 'string' || range.keyId !== relayKeyId(range.pubkey)) return err('KEY_UNKNOWN', 'keyId must be SHA-256 of the pubkey string', `${path}.keyId`);
    sorted.push(range);
  }
  sorted.sort((a, b) => a.validFromSequence - b.validFromSequence);
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (current === undefined || next === undefined) continue;
    if (current.validToSequence === null || current.validToSequence > next.validFromSequence) return err('KEY_UNKNOWN', 'Relay key ranges overlap', 'relayKeys');
  }
  return ok(true);
}

function keyInForce(ranges: readonly RelayKeyRange[], sequence: number): RelayKeyRange | undefined {
  return ranges.find((range) => sequence >= range.validFromSequence && (range.validToSequence === null || sequence < range.validToSequence));
}

function invalid(code: DomainError['code'], message: string, path: string): Result<never> { return err(code, message, path); }

interface SignerHistory { hashes: Set<Hash>; tip: Hash | null; extended: Set<Hash | null> }

/**
 * Incremental form of verifyChain: append entries one at a time and keep the same guarantees. The relay key ranges
 * are passed with every append, because a RelayKeyRotated event extends them while the chain grows.
 */
export class ChainCursor {
  #histories = new Map<string, SignerHistory>();
  #previousEventHash: Hash | null = null;
  #previousReceiptHash: Hash | null = null;
  #previousAcceptedAt = Number.NEGATIVE_INFINITY;
  #count = 0;
  #checkedRanges: readonly RelayKeyRange[] | null = null;

  get tipSequence(): number { return this.#count; }
  get tipReceiptHash(): Hash | null { return this.#previousReceiptHash; }
  get tipEventHash(): Hash | null { return this.#previousEventHash; }
  /** Latest event hash of a signer, or null when the signer has no event yet. */
  signerTip(signer: string): Hash | null { return this.#histories.get(signer)?.tip ?? null; }

  append(entry: LedgerEntry, relayKeys: readonly RelayKeyRange[], resolver?: SignerResolver): Result<true> {
    if (this.#checkedRanges !== relayKeys) {
      const ranges = checkKeyRanges(relayKeys);
      if (!ranges.ok) return ranges;
      this.#checkedRanges = relayKeys;
    }
    const index = this.#count;
    const at = `[${index}]`;
    if (typeof entry !== 'object' || entry === null || typeof entry.event !== 'object' || entry.event === null || typeof entry.receipt !== 'object' || entry.receipt === null) {
      return invalid('ENVELOPE', 'Missing event or receipt', at);
    }
    const { event, receipt } = entry;
    if (receipt.sequence !== index + 1) return invalid('RECEIPT_SEQUENCE', 'Receipt sequence is not contiguous from 1', `${at}.receipt.sequence`);
    const acceptedAtMs = strictIsoMs(receipt.acceptedAt);
    if (acceptedAtMs === null) return invalid('TIMESTAMP', 'Receipt acceptedAt is not a valid IsoUtc value', `${at}.receipt.acceptedAt`);

    const checked = validateEvent(event, acceptedAtMs);
    if (!checked.ok) return err(checked.error.code, checked.error.message, `${at}.event.${checked.error.path}`);

    const computedEventHash = eventHash(event);
    if (receipt.eventHash !== computedEventHash) return invalid('RECEIPT_EVENT_HASH', 'Receipt does not identify this event', `${at}.receipt.eventHash`);
    if (receipt.previousReceiptHash !== this.#previousReceiptHash) return invalid('RECEIPT_LINK', 'Receipt link does not match prior receipt', `${at}.receipt.previousReceiptHash`);

    const range = keyInForce(relayKeys, receipt.sequence);
    if (range === undefined || receipt.keyId !== range.keyId) return invalid('KEY_UNKNOWN', 'No relay key in force for this receipt', `${at}.receipt.keyId`);
    if (!verifyReceipt(receipt, range.pubkey)) return invalid('RECEIPT_SIGNATURE', 'Invalid relay receipt signature', `${at}.receipt.signature`);
    if (acceptedAtMs < this.#previousAcceptedAt) return invalid('TIMESTAMP', 'acceptedAt decreases', `${at}.receipt.acceptedAt`);

    const history = this.#histories.get(event.signer) ?? { hashes: new Set<Hash>(), tip: null, extended: new Set<Hash | null>() };
    if (event.prevHash === history.tip) {
      if (history.extended.has(event.prevHash)) return invalid('FORK', 'Competing append to the same signer tip', `${at}.event.prevHash`);
    } else if (event.prevHash === null || history.hashes.has(event.prevHash)) {
      return invalid('FORK', 'Event extends a signer tip that already has a successor', `${at}.event.prevHash`);
    } else {
      return invalid('CHAIN_LINK', 'Event previous hash does not match the signer tip', `${at}.event.prevHash`);
    }
    if (resolver !== undefined) {
      const resolved = resolver.resolve(event.signer, receipt.sequence);
      if (!resolved.ok) return resolved;
    }
    // Commit only after every check passed, so a rejected entry leaves the cursor untouched.
    history.extended.add(event.prevHash);
    history.hashes.add(computedEventHash);
    history.tip = computedEventHash;
    this.#histories.set(event.signer, history);
    this.#previousEventHash = computedEventHash;
    this.#previousReceiptHash = receiptHash(receipt);
    this.#previousAcceptedAt = acceptedAtMs;
    this.#count += 1;
    return ok(true);
  }

  signerTips(): ReadonlyMap<string, Hash> {
    const tips = new Map<string, Hash>();
    for (const [signer, history] of this.#histories) if (history.tip !== null) tips.set(signer, history.tip);
    return tips;
  }
}

/**
 * Verify a complete ledger prefix (spec sections 2, 7 L2, 10): per-signer prevHash chains, contiguous signed
 * receipt chain, event binding, relay key ranges and non-decreasing acceptedAt. Never reads the wall clock.
 *
 * Fork vs stale: an entry whose prevHash points at an earlier event of the same signer that already has a successor
 * (or a second null-prevHash entry) is a FORK; a prevHash that matches nothing in that signer's chain is CHAIN_LINK.
 */
export function verifyChain(entries: readonly LedgerEntry[], relayKeys: readonly RelayKeyRange[], resolver?: SignerResolver): Result<VerifiedChain> {
  const ranges = checkKeyRanges(relayKeys);
  if (!ranges.ok) return ranges;
  const cursor = new ChainCursor();
  for (const entry of entries) {
    const appended = cursor.append(entry, relayKeys, resolver);
    if (!appended.ok) return appended;
  }
  return ok({
    tipSequence: cursor.tipSequence, tipEventHash: cursor.tipEventHash, tipReceiptHash: cursor.tipReceiptHash,
    signerTips: cursor.signerTips(), accountChecks: resolver === undefined ? 'skipped' : 'applied',
  });
}

export interface SignedCheckpoint { sequence: number; receipt_hash: Hash; key_id: Hash; signature: Sig }
export interface EquivocationProof { first: SignedCheckpoint; second: SignedCheckpoint }

function checkCheckpoint(checkpoint: SignedCheckpoint, relayKeys: readonly RelayKeyRange[], path: string): Result<true> {
  if (typeof checkpoint !== 'object' || checkpoint === null || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1
    || typeof checkpoint.receipt_hash !== 'string' || !HASH.test(checkpoint.receipt_hash) || typeof checkpoint.key_id !== 'string' || !HASH.test(checkpoint.key_id)) {
    return invalid('ATTESTATION', 'Malformed checkpoint', path);
  }
  const range = keyInForce(relayKeys, checkpoint.sequence);
  if (range === undefined || range.keyId !== checkpoint.key_id) return invalid('KEY_UNKNOWN', 'No relay key in force for this checkpoint', `${path}.key_id`);
  const body = { sequence: checkpoint.sequence, receipt_hash: checkpoint.receipt_hash, key_id: checkpoint.key_id };
  return verifyCheckpoint(body, checkpoint.signature, range.pubkey) ? ok(true) : invalid('ATTESTATION', 'Invalid checkpoint signature', `${path}.signature`);
}

/**
 * Spec section 10: two validly signed checkpoints for the same sequence with different receipt hashes prove relay
 * equivocation. Returns the proof, or null when the checkpoints are consistent.
 */
export function detectEquivocation(a: SignedCheckpoint, b: SignedCheckpoint, relayKeys: readonly RelayKeyRange[]): Result<EquivocationProof | null> {
  const keys = checkKeyRanges(relayKeys); if (!keys.ok) return keys;
  const first = checkCheckpoint(a, relayKeys, 'a'); if (!first.ok) return first;
  const second = checkCheckpoint(b, relayKeys, 'b'); if (!second.ok) return second;
  if (a.sequence !== b.sequence || a.receipt_hash === b.receipt_hash) return ok(null);
  return ok({ first: a, second: b });
}

/** Preserve a stable error type for callers that need to render verification failures. */
export type ChainVerificationError = DomainError;
