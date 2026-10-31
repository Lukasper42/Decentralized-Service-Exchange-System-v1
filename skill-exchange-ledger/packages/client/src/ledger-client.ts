import { ChainCursor, type LedgerEntry } from '../../chain-verifier/src/index.js';
import { eventHash, receiptHash, verifyCheckpoint } from '../../crypto/src/index.js';
import type { DealState } from '../../domain/src/deal-machine.js';
import type { PolicyParams } from '../../domain/src/policy.js';
import { resolvePolicy } from '../../domain/src/policy.js';
import { balanceOf } from '../../domain/src/accounting.js';
import type { AccountReputation } from '../../domain/src/reputation.js';
import { rankOf } from '../../domain/src/reputation.js';
import type { EventCore, EventType, Hash, PayloadMap, Pubkey, SignedEvent } from '../../domain/src/protocol.js';
import type { Projector, RelayState } from '../../relay/src/projection.js';
import { stateHash } from '../../relay/src/projection.js';
import type { ClientClock, ClientError, ClientResult, EventSigner, LedgerTransport, SubmitReceipt } from './ports.js';
import { cerr, cok } from './ports.js';

export interface LedgerClientConfig {
  readonly transport: LedgerTransport;
  /** Built from the same genesis configuration as the relay's projector; it is what the client checks the relay against. */
  readonly projector: Projector;
  readonly clock: ClientClock;
  /** Needed only to write. Reading, syncing and verifying work without one. */
  readonly signer?: EventSigner;
}

/** What the verified local state says about a key a deal would be made with. */
export type KeyStatus =
  | { readonly kind: 'active' }
  /** A recovery-signed rotation is pending: the key can do nothing; `newPubkey` takes over at `effectiveAtMs`. */
  | { readonly kind: 'frozen'; readonly newPubkey: Pubkey; readonly effectiveAtMs: number }
  /** The key was replaced (follow `replacedBy` for the current one). */
  | { readonly kind: 'retired'; readonly replacedBy: Pubkey }
  | { readonly kind: 'unknown' };

export interface SyncReport { readonly fetched: number; readonly tipSequence: number; readonly stateHash: Hash }
export interface SubmitOutcome extends SubmitReceipt { readonly event: SignedEvent }

const isoOf = (ms: number): string => new Date(ms).toISOString();
const fromDomain = (error: { code: ClientError['code']; message: string; path: string }): ClientError => ({ code: error.code, message: error.message, path: error.path });

/**
 * The client side of the ledger. It never trusts the relay: every entry is verified (signatures, per-signer chains,
 * signed receipt chain, relay key ranges) and replayed through its own projector, and the resulting state hash must
 * equal the relay's. What it reports (balances, deals, ranks) comes from that local, verified projection.
 */
export class LedgerClient {
  readonly #transport: LedgerTransport;
  readonly #projector: Projector;
  readonly #clock: ClientClock;
  readonly #signer: EventSigner | undefined;
  readonly #cursor = new ChainCursor();
  readonly #receiptHashes: Hash[] = [];
  #state: RelayState;
  #broken: ClientError | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(config: LedgerClientConfig) {
    this.#transport = config.transport;
    this.#projector = config.projector;
    this.#clock = config.clock;
    this.#signer = config.signer;
    this.#state = config.projector.initial();
  }

  /** The verified local projection at `tipSequence`. */
  get state(): RelayState { return this.#state; }
  get tipSequence(): number { return this.#cursor.tipSequence; }
  /** Set once the relay contradicted the client. The client then refuses to read or write until it is rebuilt. */
  get divergence(): ClientError | null { return this.#broken; }

  /** Serialises the operations that move the cursor, so a sync and a submit never interleave. */
  #exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(job, job);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #diverged<T>(message: string, path: string): ClientResult<T> {
    const error: ClientError = { code: 'DIVERGENCE', message, path };
    this.#broken = error;
    return { ok: false, error };
  }

  sync(): Promise<ClientResult<SyncReport>> { return this.#exclusive(() => this.#sync()); }

  async #sync(): Promise<ClientResult<SyncReport>> {
    if (this.#broken !== null) return { ok: false, error: this.#broken };
    const tip = await this.#transport.tip();
    if (!tip.ok) return tip;
    if (tip.value.tipSequence < this.#cursor.tipSequence) return this.#diverged('The relay tip is behind the verified prefix', 'tipSequence');
    let fetched = 0;
    while (this.#cursor.tipSequence < tip.value.tipSequence) {
      const from = this.#cursor.tipSequence + 1;
      const page = await this.#transport.entries(from, tip.value.tipSequence);
      if (!page.ok) return page;
      if (page.value.entries.length === 0) return cerr('TRANSPORT', 'The relay returned no entries for a range below its tip', 'entries');
      for (const entry of page.value.entries) {
        const applied = this.#append(entry);
        if (!applied.ok) return applied;
        fetched += 1;
        if (this.#cursor.tipSequence >= tip.value.tipSequence) break;
      }
    }
    const local = stateHash(this.#state);
    if (local !== tip.value.stateHash) return this.#diverged('The relay state hash differs from the locally projected state', 'stateHash');
    return cok({ fetched, tipSequence: this.#cursor.tipSequence, stateHash: local });
  }

  #append(entry: LedgerEntry): ClientResult<true> {
    const verified = this.#cursor.append(entry, this.#state.relayKeys);
    if (!verified.ok) return { ok: false, error: fromDomain(verified.error) };
    const projected = this.#projector.apply(this.#state, entry.event, { sequence: entry.receipt.sequence, acceptedAt: entry.receipt.acceptedAt, previousReceiptHash: entry.receipt.previousReceiptHash });
    if (!projected.ok) return this.#diverged(`A verified entry does not project locally: ${projected.error.code} ${projected.error.message}`, `entries[${entry.receipt.sequence}]`);
    this.#state = projected.value;
    this.#receiptHashes.push(receiptHash(entry.receipt));
    return cok(true);
  }

  /**
   * Compare the relay's latest signed checkpoint with the receipt chain the client verified itself. A checkpoint that
   * names a different receipt at a sequence the client holds is proof that the relay signed two histories.
   * Returns false when the checkpoint is ahead of the verified prefix (sync first) or there is none yet.
   */
  verifyCheckpoint(): Promise<ClientResult<boolean>> {
    return this.#exclusive(async () => {
      if (this.#broken !== null) return { ok: false, error: this.#broken } as const;
      const checkpoint = await this.#transport.latestCheckpoint();
      if (!checkpoint.ok) return checkpoint;
      const cp = checkpoint.value;
      if (cp === null || cp.sequence > this.#cursor.tipSequence) return cok(false);
      const range = this.#state.relayKeys.find((r) => r.keyId === cp.key_id);
      if (range === undefined || !verifyCheckpoint({ sequence: cp.sequence, receipt_hash: cp.receipt_hash, key_id: cp.key_id }, cp.signature, range.pubkey)) {
        return cerr('SIGNATURE', 'The checkpoint is not signed by a known relay key', 'checkpoint');
      }
      if (this.#receiptHashes[cp.sequence - 1] !== cp.receipt_hash) return this.#diverged('A signed checkpoint contradicts the verified receipt chain', 'checkpoint');
      return cok(true);
    });
  }

  /** Sign and submit one event for the configured account, then pull it back through verification. */
  submit<T extends EventType>(type: T, payload: PayloadMap[T]): Promise<ClientResult<SubmitOutcome>> {
    return this.#exclusive(async () => {
      if (this.#broken !== null) return { ok: false, error: this.#broken } as const;
      const signer = this.#signer;
      if (signer === undefined) return cerr('SIGNING', 'No signer is configured', 'signer');
      if (type === 'DealCreated') {
        const synced = await this.#sync();
        if (!synced.ok) return synced;
        const refused = this.#dealPartnerCheck(payload as PayloadMap['DealCreated'], signer.publicKey);
        if (refused !== null) return refused;
      }
      let outcome: ClientResult<SubmitOutcome> = cerr('TRANSPORT', 'No attempt was made', 'submit');
      // A second try covers one lost race on the signer's own chain (CHAIN_LINK / FORK after a concurrent submit).
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prev = await this.#transport.signerTip(signer.publicKey);
        if (!prev.ok) return prev;
        const core = { type, version: 1, payload, signer: signer.publicKey, timestamp: isoOf(this.#clock.nowMs()), prevHash: prev.value } as unknown as EventCore;
        const signed = await signer.signEvent(core);
        if (!signed.ok) return signed;
        const sent = await this.#transport.submit(signed.value);
        if (!sent.ok) {
          outcome = sent;
          if (sent.error.code === 'CHAIN_LINK' || sent.error.code === 'FORK') continue;
          return sent;
        }
        if (sent.value.receipt.eventHash !== eventHash(signed.value)) return this.#diverged('The receipt does not identify the submitted event', 'receipt.eventHash');
        const synced = await this.#sync();
        if (!synced.ok) return synced;
        return cok({ ...sent.value, event: signed.value });
      }
      return outcome;
    });
  }

  // ---- read model: everything below reads the verified local projection ----

  /** Status of a key in the verified local state; a retired key resolves to the end of its replacement chain. */
  keyStatus(pubkey: Pubkey): KeyStatus {
    const pending = this.#state.pendingRotations.find((r) => r.oldPubkey === pubkey);
    if (pending !== undefined) return { kind: 'frozen', newPubkey: pending.newPubkey, effectiveAtMs: pending.effectiveAtMs };
    if (Object.hasOwn(this.#state.accounts, pubkey)) return { kind: 'active' };
    if (!Object.hasOwn(this.#state.retiredKeys, pubkey)) return { kind: 'unknown' };
    let current: Pubkey = this.#state.retiredKeys[pubkey] ?? pubkey;
    for (let hops = 0; hops < 64 && Object.hasOwn(this.#state.retiredKeys, current); hops += 1) current = this.#state.retiredKeys[current] ?? current;
    return { kind: 'retired', replacedBy: current };
  }

  /** Refuse a deal with a counterparty whose key cannot act, and say which key to use instead. */
  #dealPartnerCheck(payload: PayloadMap['DealCreated'], own: Pubkey): ClientResult<never> | null {
    const partner = payload.buyer === own ? payload.seller : payload.buyer;
    const status = this.keyStatus(partner);
    switch (status.kind) {
      case 'active': return null;
      case 'unknown': return cerr('STATE', 'The counterparty is not a registered account', payload.buyer === own ? 'payload.seller' : 'payload.buyer');
      case 'retired': return cerr('STATE', `The counterparty replaced this key; ask them for their current key (it is ${status.replacedBy})`, payload.buyer === own ? 'payload.seller' : 'payload.buyer');
      case 'frozen': return cerr('STATE', `The counterparty is rotating this key; the new key ${status.newPubkey} takes over at ${isoOf(status.effectiveAtMs)}`, payload.buyer === own ? 'payload.seller' : 'payload.buyer');
      default: { const _x: never = status; return _x; }
    }
  }

  /** Active policy at the next sequence. */
  policy(): ClientResult<PolicyParams> {
    const entry = resolvePolicy(this.#state.policy, Math.max(1, this.#state.appliedSequence + 1));
    return entry.ok ? cok(entry.value.params) : cerr(entry.error.code, entry.error.message, entry.error.path);
  }
  balanceOf(pubkey: Pubkey): number { return balanceOf(this.#state.accounting, pubkey); }
  deal(dealId: string): DealState | undefined { return Object.hasOwn(this.#state.deals, dealId) ? this.#state.deals[dealId] : undefined; }
  reputation(pubkey: Pubkey): AccountReputation | undefined { return Object.hasOwn(this.#state.reputation.accounts, pubkey) ? this.#state.reputation.accounts[pubkey] : undefined; }
  /** Rank as of the client clock: distinct completed counterparties plus decayed work quality. */
  rankOf(pubkey: Pubkey): ClientResult<number> {
    const account = this.reputation(pubkey);
    if (account === undefined) return cerr('STATE', 'Unknown account', 'pubkey');
    const policy = this.policy();
    if (!policy.ok) return policy;
    const day = 86_400_000;
    const ranked = rankOf(account, this.#clock.nowMs(), { activeWindowMs: policy.value.reputation.activeWindowDays * day, decayHalfLifeMs: policy.value.reputation.decayHalfLifeDays * day });
    return ranked.ok ? cok(ranked.value) : cerr(ranked.error.code, ranked.error.message, ranked.error.path);
  }

  // ---- signed actions that need an attestation next to the event ----

  /** Seller consent: signs the deal-consent attestation over the deal terms as the client sees them. */
  consentDeal(dealId: string): Promise<ClientResult<SubmitOutcome>> {
    const signer = this.#signer;
    const deal = this.deal(dealId);
    if (signer === undefined) return Promise.resolve(cerr('SIGNING', 'No signer is configured', 'signer'));
    if (deal === undefined) return Promise.resolve(cerr('STATE', 'Unknown deal; sync first', 'dealId'));
    const body = { deal_id: deal.dealId, buyer: deal.buyer, seller: deal.seller, amount: deal.amount, criteria_hash: deal.criteriaHash, deadline: deal.deadline };
    return signer.signAttestation('deal-consent', body).then((sig) => (sig.ok
      ? this.submit('DealConsented', { deal_id: dealId, seller: signer.publicKey, consent_sig: sig.value })
      : sig));
  }

  /** Juror vote for the deal's current round, with the jury-vote attestation. */
  castVote(dealId: string, vote: 'buyer' | 'seller'): Promise<ClientResult<SubmitOutcome>> {
    const signer = this.#signer;
    const deal = this.deal(dealId);
    if (signer === undefined) return Promise.resolve(cerr('SIGNING', 'No signer is configured', 'signer'));
    if (deal === undefined) return Promise.resolve(cerr('STATE', 'Unknown deal; sync first', 'dealId'));
    const body = { deal_id: dealId, juror: signer.publicKey, vote, appeal_round: deal.appealRound };
    return signer.signAttestation('jury-vote', body).then((sig) => (sig.ok
      ? this.submit('JuryVoted', { deal_id: dealId, juror: signer.publicKey, vote, appeal_round: deal.appealRound, sig: sig.value })
      : sig));
  }
}
