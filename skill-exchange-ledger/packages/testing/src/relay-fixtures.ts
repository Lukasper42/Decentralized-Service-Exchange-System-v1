/** Test rig for the relay: injected clock, keys, accounts, deal context and per-signer tip tracking. */
import type { EventType, Hash, PayloadMap, Pubkey, SignedEvent } from '../../domain/src/protocol.js';
import { applyIssuance, initialAccountingState } from '../../domain/src/accounting.js';
import type { AccountingState } from '../../domain/src/accounting.js';
import { defaultBetaParams } from '../../domain/src/policy.js';
import type { PolicyParams } from '../../domain/src/policy.js';
import { actionHash, approvalActionFor, eventHash, recoveryCommitment, relayKeyId, signApproval, signAttestation } from '../../crypto/src/index.js';
import { MemoryStore } from '../../relay/src/memory-store.js';
import type { LedgerStore } from '../../relay/src/store.js';
import { Projector } from '../../relay/src/projection.js';
import { Relay } from '../../relay/src/relay.js';
import type { RelayPolicy, RelayResult, SubmitOutcome } from '../../relay/src/relay.js';
import { DAY, T0, eventOf, h, iso, newCast, newIdentity, uuid } from './fixtures.js';
import type { Cast, Identity } from './fixtures.js';

export const RELAY_POLICY: RelayPolicy = { maxEventBytes: 4096, checkpointEvery: 2 };

export class RelayRig {
  readonly cast: Cast;
  readonly genesisKey: Identity;
  readonly approvers: Identity[];
  readonly privateKeys = new Map<string, string>();
  now = T0;
  readonly tips = new Map<Pubkey, Hash | null>();
  readonly store: LedgerStore;
  relay: Relay;
  projector: Projector;

  /** `template` reuses its identities and keys, so a second rig over the same store is a faithful restart. */
  constructor(store: LedgerStore = new MemoryStore(), template?: RelayRig) {
    this.store = store;
    this.cast = template?.cast ?? newCast();
    this.genesisKey = template?.genesisKey ?? newIdentity();
    this.approvers = template?.approvers ?? [newIdentity(), newIdentity(), newIdentity()];
    if (template !== undefined) { this.now = template.now; for (const [k, v] of template.privateKeys) this.privateKeys.set(k, v); }
    this.privateKeys.set(relayKeyId(this.genesisKey.publicKey), this.genesisKey.privateKey);
    this.projector = this.#projector();
    this.relay = this.#build();
  }
  #projector(): Projector {
    const relayKey = { keyId: relayKeyId(this.genesisKey.publicKey), pubkey: this.genesisKey.publicKey };
    return new Projector({
      genesisRelayKey: { ...relayKey, validFromSequence: 1, validToSequence: null },
      genesisPolicy: this.genesisPolicy(),
      policyDocuments: { get: (hash) => this.policyDocuments.get(hash) },
      genesisAccounting: this.genesisAccounting(),
    });
  }
  /** Version-1 policy of the rig: the three approvers form the 2-of-3 multisig; `extra[1]` is the only inviter. */
  genesisPolicy(): PolicyParams {
    const keys = (ids: readonly Identity[]): Pubkey[] => ids.map((i) => i.publicKey);
    const params = defaultBetaParams({
      policyId: 'rig-beta',
      multisigMembers: keys(this.approvers).sort(),
      inviters: keys([this.cast.extra[1] ?? this.cast.outsider]),
      genesisAccounts: [...keys([this.cast.buyer, this.cast.seller, this.cast.outsider, this.cast.checker, ...this.cast.jurors, ...this.cast.extra]), ...keys(this.approvers)],
      checkers: [],
      genesisRelayKey: { keyId: relayKeyId(this.genesisKey.publicKey), pubkey: this.genesisKey.publicKey },
      issuancePolicyIds: ['rig-grant'],
      jurorPayoutPerCase: 0,
      limits: { maxIssuancePerEvent: 1_000_000, maxTreasurySpendPerEvent: 1_000_000, maxDealAmount: 1_000_000 },
    });
    // Every registered account may be a juror in the rig, so small test ledgers can draw one.
    return { ...params, jury: { ...params.jury, tiers: [{ minDeals: 0, minCounterparties: 0, minAccountAgeDays: 0, requirePositiveBalance: false }] } };
  }
  /** Genesis ledger: buyer and seller start with 1,000,000 coins each, the treasury with 1,000,000. */
  genesisAccounting(): AccountingState {
    const empty = initialAccountingState({ treasury: 1_000_000 });
    if (!empty.ok) throw new Error(empty.error.message);
    let state = empty.value;
    for (const [i, who] of [this.cast.buyer, this.cast.seller].entries()) {
      const funded = applyIssuance(state, { recipient: who.publicKey, amount: 1_000_000, nonce: h(`genesis-grant-${i}`) });
      if (!funded.ok) throw new Error(funded.error.message);
      state = funded.value;
    }
    return state;
  }
  #build(): Relay {
    return new Relay({ store: this.store, keys: { privateKeyFor: (id) => this.privateKeys.get(id) ?? null }, clock: { nowMs: () => this.now }, projector: this.projector, policy: RELAY_POLICY });
  }
  /** A fresh Relay instance over the same store: simulates a process restart. */
  restart(): Relay { this.relay = this.#build(); this.tips.clear(); return this.relay; }
  /** Policy documents the rig can serve to PolicyUpdated, by params hash. */
  readonly policyDocuments = new Map<Hash, unknown>();
  /** Build a signed event chained to the rig's view of the signer's tip. */
  build<T extends EventType>(type: T, payload: PayloadMap[T], signer: Identity, timestampMs: number = this.now): SignedEvent {
    return eventOf(type, payload, signer, timestampMs, this.tips.get(signer.publicKey) ?? null) as unknown as SignedEvent;
  }
  submitEvent(event: SignedEvent): RelayResult<SubmitOutcome> {
    const result = this.relay.submit(event);
    if (result.ok && !result.value.duplicate) this.tips.set(event.signer, eventHash(event));
    return result;
  }
  submit<T extends EventType>(type: T, payload: PayloadMap[T], signer: Identity): RelayResult<SubmitOutcome> {
    return this.submitEvent(this.build(type, payload, signer));
  }
  must<T extends EventType>(type: T, payload: PayloadMap[T], signer: Identity): SubmitOutcome {
    const result = this.submit(type, payload, signer);
    if (!result.ok) throw new Error(`${type} rejected: ${result.error.code} ${result.error.message}`);
    return result.value;
  }
  createAccount(who: Identity, inviteRef: Hash | null = null): RelayResult<SubmitOutcome> {
    return this.submit('AccountCreated', { pubkey: who.publicKey, recovery_commitment: recoveryCommitment(this.cast.extra[0]?.publicKey ?? who.publicKey), invite_ref: inviteRef }, who);
  }
  /** Genesis accounts for buyer and seller. */
  bootstrap(): void {
    this.relay.start();
    for (const who of [this.cast.buyer, this.cast.seller]) { this.now += 1000; this.must('AccountCreated', { pubkey: who.publicKey, recovery_commitment: recoveryCommitment(this.cast.extra[0]?.publicKey ?? who.publicKey), invite_ref: null }, who); }
  }
  /** DealCreated + DealConsented + EscrowFunded for one deal; returns the deal id. */
  openDeal(n = 1, amount = 1000): string {
    const dealId = uuid(n);
    const { buyer, seller } = this.cast;
    const base = { deal_id: dealId, buyer: buyer.publicKey, seller: seller.publicKey, amount, criteria_hash: h(`criteria${n}`), deadline: iso(this.now + 30 * DAY) };
    this.now += 1000;
    this.must('DealCreated', base, buyer);
    this.now += 1000;
    const consentBody = { deal_id: base.deal_id, buyer: base.buyer, seller: base.seller, amount: base.amount, criteria_hash: base.criteria_hash, deadline: base.deadline };
    this.must('DealConsented', { deal_id: dealId, seller: seller.publicKey, consent_sig: signAttestation('deal-consent', consentBody, seller.privateKey) }, seller);
    this.now += 1000;
    this.must('EscrowFunded', { deal_id: dealId, from: buyer.publicKey, amount }, buyer);
    return dealId;
  }
  /** RelayKeyRotated payload approved by two approvers. */
  rotationPayload(next: Identity, validFromSequence: number): PayloadMap['RelayKeyRotated'] {
    const fields = { key_id: relayKeyId(next.publicKey), pubkey: next.publicKey, valid_from_sequence: validFromSequence };
    const hash = actionHash(approvalActionFor({ type: 'RelayKeyRotated', payload: { ...fields, approvals: [] } }));
    const [a, b] = this.approvers;
    if (a === undefined || b === undefined) throw new Error('approvers missing');
    return { ...fields, approvals: [signApproval(hash, a.publicKey, a.privateKey), signApproval(hash, b.publicKey, b.privateKey)] };
  }
}
