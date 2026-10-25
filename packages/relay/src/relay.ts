import type { DomainError, ErrorCode, Hash, IsoUtc, Pubkey, Receipt, Result, SignedEvent } from '../../domain/src/protocol.js';
import { CanonicalError, canonical, eventHash, receiptHash, signCheckpoint, signReceipt } from '../../crypto/src/index.js';
import { validateEvent } from '../../validation/src/index.js';
import { verifyChain } from '../../chain-verifier/src/index.js';
import type { SignedCheckpoint } from '../../chain-verifier/src/index.js';
import type { RelayKeyRange } from '../../domain/src/ports.js';
import type { ClockPort, KeySource, Logger } from './ports.js';
import { keyInForce, stateHash, type Projector } from './projection.js';
import type { RelayState } from './projection.js';
import type { LedgerEntry, LedgerStore } from './store.js';

/** Errors the transport layer adds on top of the protocol codes (spec: docs/relay-spec.md section 5). */
export type RelayErrorCode = ErrorCode | 'READ_ONLY' | 'RATE_LIMITED' | 'NOT_FOUND' | 'BAD_REQUEST' | 'TOO_LARGE' | 'STORE_FAILURE';
export interface RelayError { code: RelayErrorCode; message: string; path: string }
export type RelayResult<T> = { ok: true; value: T } | { ok: false; error: RelayError };
const fail = (code: RelayErrorCode, message: string, path = ''): RelayResult<never> => ({ ok: false, error: { code, message, path } });
const asRelayError = (error: DomainError): RelayResult<never> => ({ ok: false, error });

export interface RelayPolicy {
  /** Maximum canonical size of one event in bytes. */
  readonly maxEventBytes: number;
  /** A signed checkpoint is available for every multiple of this sequence. */
  readonly checkpointEvery: number;
}
export interface RelayDeps {
  readonly store: LedgerStore;
  readonly keys: KeySource;
  readonly clock: ClockPort;
  readonly projector: Projector;
  readonly policy: RelayPolicy;
  readonly log?: Logger;
}
export interface SubmitOutcome { receipt: Receipt; duplicate: boolean }
interface Prepared { event: SignedEvent; hash: Hash; receipt: Receipt; next: RelayState; acceptedAtMs: number; sequence: number; keyId: string }

const isoOf = (ms: number): IsoUtc => new Date(ms).toISOString();

/** Pure replay: verify the whole prefix (L1/L2 chain rules) and fold it through the projector. */
export function replayLedger(entries: readonly LedgerEntry[], projector: Projector): RelayResult<{ state: RelayState; stateHash: Hash }> {
  let state = projector.initial();
  // Key ranges are projection state; derive them first so verifyChain can check every receipt signature, then
  // require the fold to arrive at exactly the same ranges.
  const preScan = projector.initial();
  let ranges: readonly RelayKeyRange[] = preScan.relayKeys;
  for (const entry of entries) {
    if (entry.event.type !== 'RelayKeyRotated') continue;
    const p = entry.event.payload;
    const last = ranges[ranges.length - 1];
    if (last === undefined) break;
    ranges = [...ranges.slice(0, -1), { ...last, validToSequence: p.valid_from_sequence }, { keyId: p.key_id, pubkey: p.pubkey, validFromSequence: p.valid_from_sequence, validToSequence: null }];
  }
  const verified = verifyChain(entries, ranges);
  if (!verified.ok) return asRelayError(verified.error);
  for (const [index, entry] of entries.entries()) {
    const applied = projector.apply(state, entry.event, { sequence: entry.receipt.sequence, acceptedAt: entry.receipt.acceptedAt, previousReceiptHash: entry.receipt.previousReceiptHash });
    if (!applied.ok) return fail(applied.error.code, applied.error.message, `[${index}].${applied.error.path}`);
    state = applied.value;
  }
  if (canonical(state.relayKeys) !== canonical(ranges)) return fail('KEY_UNKNOWN', 'Derived relay key ranges differ from the projected ones', 'relayKeys');
  return { ok: true, value: { state, stateHash: stateHash(state) } };
}

export class Relay {
  readonly #store: LedgerStore;
  readonly #keys: KeySource;
  readonly #clock: ClockPort;
  readonly #projector: Projector;
  readonly #policy: RelayPolicy;
  readonly #log: Logger;
  #state: RelayState;
  #lastAcceptedAt = Number.NEGATIVE_INFINITY;
  #readOnly = false;
  #failed = false;
  #started = false;
  #closing = false;
  #inflight = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: RelayDeps) {
    this.#store = deps.store;
    this.#keys = deps.keys;
    this.#clock = deps.clock;
    this.#projector = deps.projector;
    this.#policy = deps.policy;
    this.#log = deps.log ?? (() => undefined);
    this.#state = deps.projector.initial();
  }

  get readOnly(): boolean { return this.#readOnly || this.#failed; }
  get stateHash(): Hash { return stateHash(this.#state); }
  get state(): RelayState { return this.#state; }
  get tipSequence(): number { return this.#store.tipSequence(); }
  setReadOnly(flag: boolean): void { this.#readOnly = flag; }

  /** Verify-on-start: open the store, verify the whole chain and rebuild the projection. Refuses to start on any error. Sync stores only. */
  start(): RelayResult<{ tip: number; stateHash: Hash }> {
    const opened = this.#store.open();
    if (opened !== undefined) { void opened.catch(() => undefined); throw new Error('start() needs a synchronous store; use startAsync()'); }
    return this.#afterOpen();
  }
  /** Same as start() for stores that open asynchronously (Postgres). */
  async startAsync(): Promise<RelayResult<{ tip: number; stateHash: Hash }>> {
    await this.#store.open();
    return this.#afterOpen();
  }
  #afterOpen(): RelayResult<{ tip: number; stateHash: Hash }> {
    const entries = this.#store.all();
    const replay = replayLedger(entries, this.#projector);
    if (!replay.ok) { void this.#store.close(); return replay; }
    this.#state = replay.value.state;
    const last = entries[entries.length - 1];
    this.#lastAcceptedAt = last === undefined ? Number.NEGATIVE_INFINITY : Date.parse(last.receipt.acceptedAt);
    this.#started = true;
    this.#log('relay.start', { tip: entries.length, stateHash: replay.value.stateHash });
    return { ok: true, value: { tip: entries.length, stateHash: replay.value.stateHash } };
  }
  /** Graceful stop: appends are synchronous, so closing after the current call finishes never splits one. */
  close(): void { this.#closing = true; void this.#store.close(); this.#started = false; }
  /** Graceful stop for async stores: waits for the in-flight submit, then closes the store. */
  async closeAsync(): Promise<void> {
    this.#closing = true;
    await this.#queue;
    this.#started = false;
    await this.#store.close();
  }

  /** Receipt time: the injected clock, forced non-decreasing across receipts and restarts. */
  #acceptedAt(): number {
    const now = this.#clock.nowMs();
    return Number.isSafeInteger(now) ? Math.max(now, this.#lastAcceptedAt) : this.#lastAcceptedAt;
  }

  /**
   * The submit pipeline. Order: limits -> L1 -> idempotency -> signer-tip compare-and-append -> L2/L3 projection ->
   * receipt -> durable append. Nothing is written if any step fails. Sequence assignment, signing and append run in one
   * synchronous step, so concurrent callers can never obtain the same sequence. Sync stores only; see submitAsync().
   */
  submit(raw: unknown): RelayResult<SubmitOutcome> {
    if (this.#inflight) return fail('READ_ONLY', 'An asynchronous append is in flight');
    const prepared = this.#prepare(raw);
    if (!prepared.ok) return prepared;
    if (prepared.value.kind === 'known') return { ok: true, value: prepared.value.outcome };
    const p = prepared.value;
    try {
      const pending = this.#store.append({ event: p.event, receipt: p.receipt });
      if (pending !== undefined) { void pending.catch(() => undefined); this.#failed = true; return fail('STORE_FAILURE', 'submit() needs a synchronous store; use submitAsync()'); }
    } catch (error) { return this.#storeFailure(p.sequence, error); }
    return this.#commit(p);
  }
  /** Submit for any store. Calls are serialized, so sequence assignment stays gap-free while an append is awaited. */
  submitAsync(raw: unknown): Promise<RelayResult<SubmitOutcome>> {
    const run = this.#queue.then(() => this.#runAsync(raw));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
  async #runAsync(raw: unknown): Promise<RelayResult<SubmitOutcome>> {
    const prepared = this.#prepare(raw);
    if (!prepared.ok) return prepared;
    if (prepared.value.kind === 'known') return { ok: true, value: prepared.value.outcome };
    const p = prepared.value;
    this.#inflight = true;
    try { await this.#store.append({ event: p.event, receipt: p.receipt }); }
    catch (error) { return this.#storeFailure(p.sequence, error); }
    finally { this.#inflight = false; }
    return this.#commit(p);
  }
  #storeFailure(sequence: number, error: unknown): RelayResult<never> {
    this.#failed = true;
    this.#log('relay.store_failure', { sequence, message: error instanceof Error ? error.message : 'unknown' });
    return fail('STORE_FAILURE', 'The store failed; the relay is now read-only');
  }
  #commit(p: Prepared): RelayResult<SubmitOutcome> {
    this.#state = p.next;
    this.#lastAcceptedAt = p.acceptedAtMs;
    this.#log('relay.submit', { sequence: p.sequence, eventHash: p.hash, keyId: p.keyId });
    return { ok: true, value: { receipt: p.receipt, duplicate: false } };
  }
  /** Steps 1-6 of the pipeline: pure with respect to the store and the relay state. */
  #prepare(raw: unknown): RelayResult<{ kind: 'known'; outcome: SubmitOutcome } | ({ kind: 'new' } & Prepared)> {
    if (!this.#started || this.#closing) return fail('READ_ONLY', 'Relay is not running');
    if (this.readOnly) return fail('READ_ONLY', 'Relay is in read-only mode');
    // 1. size limit on the canonical form (a value that is not canonical is reported by L1 below)
    try { if (Buffer.byteLength(canonical(raw), 'utf8') > this.#policy.maxEventBytes) return fail('TOO_LARGE', 'Event exceeds the size limit', '$'); }
    catch (error) { if (!(error instanceof CanonicalError)) throw error; }
    // 2. L1 with the relay's own receipt time
    const acceptedAtMs = this.#acceptedAt();
    const checked = validateEvent(raw, acceptedAtMs);
    if (!checked.ok) return asRelayError(checked.error);
    const event: SignedEvent = checked.value;
    const hash = eventHash(event);
    // 3. idempotency
    const known = this.#store.findByEventHash(hash);
    if (known !== null) return { ok: true, value: { kind: 'known', outcome: { receipt: known.receipt, duplicate: true } } };
    // 4. signer-tip compare-and-append
    const tip = this.#store.signerTip(event.signer);
    if (event.prevHash !== tip) {
      const earlier = event.prevHash === null ? null : this.#store.findByEventHash(event.prevHash);
      const consumed = event.prevHash === null || (earlier !== null && earlier.event.signer === event.signer);
      return consumed
        ? fail('FORK', 'The signer tip already has a successor', 'prevHash')
        : fail('CHAIN_LINK', 'prevHash does not match the signer tip', 'prevHash');
    }
    // 5. L2/L3
    const sequence = this.#store.tipSequence() + 1;
    const tipEntry = this.#store.tipEntry();
    const previousReceiptHash = tipEntry === null ? null : receiptHash(tipEntry.receipt);
    const meta = { sequence, acceptedAt: isoOf(acceptedAtMs), previousReceiptHash };
    const next = this.#projector.apply(this.#state, event, meta);
    if (!next.ok) return asRelayError(next.error);
    // 6. receipt under the key in force at this sequence
    const range = keyInForce(this.#state.relayKeys, sequence);
    const privateKey = range === undefined ? null : this.#keys.privateKeyFor(range.keyId);
    if (range === undefined || privateKey === null) return fail('KEY_UNKNOWN', 'No relay private key is available for this sequence', 'receipt.keyId');
    const receipt = signReceipt({ sequence, eventHash: hash, previousReceiptHash, acceptedAt: meta.acceptedAt, keyId: range.keyId }, privateKey);
    // 7 (durable append) and the state swap happen in the caller; the receipt is released only after the store confirmed it
    return { ok: true, value: { kind: 'new', event, hash, receipt, next: next.value, acceptedAtMs, sequence, keyId: range.keyId } };
  }

  receiptFor(eventHashHex: Hash): LedgerEntry | null { return this.#store.findByEventHash(eventHashHex); }
  entries(from: number, to: number): LedgerEntry[] { return this.#store.readRange(from, to); }
  signerTip(signer: Pubkey): Hash | null { return this.#store.signerTip(signer); }

  /** Latest signed checkpoint (Ed25519 is deterministic, so it is recomputed, never stored), or null before the first one. */
  latestCheckpoint(): SignedCheckpoint | null {
    const every = this.#policy.checkpointEvery;
    const sequence = Math.floor(this.#store.tipSequence() / every) * every;
    if (sequence < 1) return null;
    const entry = this.#store.readRange(sequence, sequence)[0];
    if (entry === undefined) return null;
    const range = keyInForce(this.#state.relayKeys, sequence);
    const privateKey = range === undefined ? null : this.#keys.privateKeyFor(range.keyId);
    if (range === undefined || privateKey === null) return null;
    const body = { sequence, receipt_hash: receiptHash(entry.receipt), key_id: range.keyId };
    return { ...body, signature: signCheckpoint(body, privateKey) };
  }
}
export type { Result };
