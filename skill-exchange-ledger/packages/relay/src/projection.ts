import type { DealState } from '../../domain/src/deal-machine.js';
import { applyDealEvent } from '../../domain/src/deal-machine.js';
import type { AccountingState } from '../../domain/src/accounting.js';
import { applyIssuance, applyMovements, applyTreasurySpend, initialAccountingState, spendableView } from '../../domain/src/accounting.js';
import type { DealContext, ReceiptMeta, RelayKeyRange } from '../../domain/src/ports.js';
import type { PolicyDocumentSource, PolicyParams, PolicyRegistry } from '../../domain/src/policy.js';
import { applyPolicyUpdated, checkIssuance, checkTreasurySpend, dealPolicyView, genesisPolicyRegistry, isActiveInviter, resolvePolicy, verifyApprovals } from '../../domain/src/policy.js';
import type { JuryDraws } from '../../domain/src/jury-draws.js';
import { closeDraws, initialJuryDraws, juryContextSource, openDraw, recordBeacon } from '../../domain/src/jury-draws.js';
import { createJuryOracle } from '../../domain/src/jury.js';
import type { ReputationState } from '../../domain/src/reputation.js';
import { applyDealCompleted, applyDisputeOutcome, applyReputationEvent, canonicalizeReputationState, initialReputationState, registerAccount, toJuryCandidate } from '../../domain/src/reputation.js';
import type { EventType, Hash, IsoUtc, Pubkey, Result, SignedEvent } from '../../domain/src/protocol.js';
import { err, ok } from '../../domain/src/protocol.js';
import { eventHash, hashCanonical, recoveryCommitment, relayKeyId, verifyAttestation } from '../../crypto/src/index.js';

/** Projection state: plain data only, so its canonical hash is a pure function of the ledger prefix. */
export interface RelayState {
  readonly appliedSequence: number;
  readonly accounts: Readonly<Record<Pubkey, { createdSequence: number; recoveryCommitment: Hash }>>;
  /** Recovery-signed rotations that have not taken over yet, oldest first. The old key is frozen while one is pending. */
  readonly pendingRotations: readonly PendingRotation[];
  /** Retired key -> the key that replaced it. A retired key can never be registered or used again. */
  readonly retiredKeys: Readonly<Record<Pubkey, Pubkey>>;
  readonly invitesUsed: readonly Hash[];
  /** Invitations by the hash of their AccountInvited event (that hash is the `invite_ref`). */
  readonly invitations: Readonly<Record<Hash, { readonly invitee: Pubkey; readonly expires: IsoUtc }>>;
  readonly deals: Readonly<Record<string, DealState>>;
  readonly relayKeys: readonly RelayKeyRange[];
  readonly accounting: AccountingState;
  readonly reputation: ReputationState;
  readonly policy: PolicyRegistry;
  /** Jury pool snapshots and beacon hashes of the disputes that are still open. */
  readonly juryDraws: JuryDraws;
}

export interface PendingRotation {
  readonly oldPubkey: Pubkey;
  readonly newPubkey: Pubkey;
  readonly newRecoveryCommitment: Hash;
  readonly effectiveAtMs: number;
  readonly sequence: number;
}

/** The receipt of the event being applied, plus the hash of the receipt before it (the beacon source). */
export interface ProjectionMeta extends ReceiptMeta { readonly previousReceiptHash: Hash | null }
export function stateHash(state: RelayState): Hash { return hashCanonical(state); }

export interface ProjectorConfig {
  /** The relay key valid from sequence 1. */
  readonly genesisRelayKey: RelayKeyRange;
  /** Version-1 policy document; its hash is part of the replayed state. */
  readonly genesisPolicy: PolicyParams;
  /** Resolves the policy documents named by PolicyUpdated.params_hash. */
  readonly policyDocuments: PolicyDocumentSource;
  /** Genesis accounting state (treasury and any testnet balances). Defaults to an empty ledger. */
  readonly genesisAccounting?: AccountingState;
}

const DEAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'DealCreated', 'DealConsented', 'EscrowFunded', 'DeliverableSubmitted', 'PrecheckCompleted', 'DealAccepted', 'DealRejected',
  'DealAutoAccepted', 'DealExpired', 'DisputeOpened', 'JuryAssigned', 'JuryVoted', 'JurorReplaced', 'DisputeResolved',
  'AppealOpened', 'AppealFeeSettled', 'EscrowReleased', 'FeeBurned', 'EvidenceRevealed',
]);

function keyInForce(ranges: readonly RelayKeyRange[], sequence: number): RelayKeyRange | undefined {
  return ranges.find((r) => sequence >= r.validFromSequence && (r.validToSequence === null || sequence < r.validToSequence));
}
export { keyInForce };

function failFrom<T>(error: { code: Parameters<typeof err>[0]; message: string; path: string }): Result<T> { return err(error.code, error.message, error.path); }
/** True iff the key is registered, retired, or the target of a pending rotation. */
function isKnownKey(state: RelayState, key: Pubkey): boolean {
  return Object.hasOwn(state.accounts, key) || Object.hasOwn(state.retiredKeys, key) || state.pendingRotations.some((r) => r.newPubkey === key);
}

const compareKeys = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
function nullRecord<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) out[key] = value;
  return out;
}

/** Moves every trace of `from` in the projection to `to`: roles in deals, balances, reputation, jury snapshots. */
function rekey(state: RelayState, rotation: PendingRotation): Result<RelayState> {
  const from = rotation.oldPubkey;
  const to = rotation.newPubkey;
  const swap = (key: Pubkey): Pubkey => (key === from ? to : key);
  const sorted = (keys: readonly Pubkey[]): Pubkey[] => [...new Set(keys.map(swap))].sort(compareKeys);
  const account = Object.hasOwn(state.accounts, from) ? state.accounts[from] : undefined;
  if (account === undefined) return err('STATE', 'Rotated account is missing', 'state.accounts');
  if (isKnownKeyExceptPending(state, to, rotation)) return err('STATE', 'New key is already in use', 'state.accounts');

  const { [from]: _gone, ...otherAccounts } = state.accounts;
  const accounts = { ...otherAccounts, [to]: { createdSequence: account.createdSequence, recoveryCommitment: rotation.newRecoveryCommitment } };

  const deals: Record<string, DealState> = {};
  for (const id of Object.keys(state.deals)) {
    const d = state.deals[id];
    if (d === undefined) continue;
    deals[id] = {
      ...d,
      buyer: swap(d.buyer), seller: swap(d.seller),
      appellant: d.appellant === null ? null : swap(d.appellant),
      jurors: d.jurors.map(swap), round0Jurors: d.round0Jurors.map(swap), seatedJurors: d.seatedJurors.map(swap),
      voteDeadlines: Object.fromEntries(Object.entries(d.voteDeadlines).map(([k, v]) => [swap(k), v])),
      votes: Object.fromEntries(Object.entries(d.votes).map(([k, v]) => [swap(k), v])),
      release: d.release === null ? null : { ...d.release, signer: swap(d.release.signer), to: swap(d.release.to) },
      prechecks: d.prechecks.map((c) => ({ ...c, checker: swap(c.checker) })),
      reveals: d.reveals.map((r) => ({ ...r, by: swap(r.by) })),
    };
  }

  const spendable = nullRecord(Object.keys(state.accounting.spendable).map((k) => [swap(k), state.accounting.spendable[k] ?? 0] as const));
  const accounting: AccountingState = { ...state.accounting, spendable };

  const repAccounts = nullRecord(Object.keys(state.reputation.accounts).flatMap((k) => {
    const r = state.reputation.accounts[k];
    return r === undefined ? [] : [[swap(k), { ...r, counterparties: sorted(r.counterparties) }] as const];
  }));
  const reputation = canonicalizeReputationState({
    accounts: repAccounts,
    rated: state.reputation.rated.map((key) => (key.endsWith(`:${from}`) ? `${key.slice(0, key.length - from.length)}${to}` : key)),
    settled: state.reputation.settled,
  });

  const juryDraws = nullRecord(Object.keys(state.juryDraws).flatMap((k) => {
    const draw = state.juryDraws[k];
    if (draw === undefined) return [];
    const candidates = draw.candidates.map((c) => ({ ...c, pubkey: swap(c.pubkey) })).sort((a, b) => compareKeys(a.pubkey, b.pubkey));
    return [[k, { ...draw, candidates, excluded: sorted(draw.excluded) }] as const];
  }));

  return ok({
    ...state, accounts, deals, accounting, reputation, juryDraws,
    pendingRotations: state.pendingRotations.filter((r) => r !== rotation),
    retiredKeys: { ...state.retiredKeys, [from]: to },
  });
}
function isKnownKeyExceptPending(state: RelayState, key: Pubkey, own: PendingRotation): boolean {
  return Object.hasOwn(state.accounts, key) || Object.hasOwn(state.retiredKeys, key) || state.pendingRotations.some((r) => r !== own && r.newPubkey === key);
}

/** Rotations whose delay has run out take over, in the order they were accepted, before the event at `at` is applied. */
function activateRotations(state: RelayState, at: number): Result<RelayState> {
  let current = state;
  const due = state.pendingRotations.filter((r) => r.effectiveAtMs <= at).sort((a, b) => a.effectiveAtMs - b.effectiveAtMs || a.sequence - b.sequence);
  for (const rotation of due) {
    const next = rekey(current, rotation);
    if (!next.ok) return next;
    current = next.value;
  }
  return ok(current);
}

/** Jurors seated so far in the given round of a deal (empty before the first assignment). */
function seatedOf(state: RelayState, dealId: string, round: 0 | 1): readonly Pubkey[] {
  const deal = Object.hasOwn(state.deals, dealId) ? state.deals[dealId] : undefined;
  return deal !== undefined && deal.appealRound === round ? deal.seatedJurors : [];
}
function timeOf(meta: ReceiptMeta): number { return Date.parse(meta.acceptedAt); }

/**
 * L2 + L3 projector: signer existence, invitations, relay key rotation, policy, accounting, reputation and the deal machine.
 * KeyRotated is still rejected with POLICY (its delay and emergency-override design is pending): the relay fails closed.
 */
export class Projector {
  readonly #genesisPolicy: PolicyRegistry;
  readonly #genesisAccounting: AccountingState;
  constructor(private readonly config: ProjectorConfig) {
    const registry = genesisPolicyRegistry(config.genesisPolicy);
    if (!registry.ok) throw new Error(`Invalid genesis policy: ${registry.error.message}`);
    this.#genesisPolicy = registry.value;
    if (config.genesisAccounting !== undefined) this.#genesisAccounting = config.genesisAccounting;
    else {
      const empty = initialAccountingState();
      if (!empty.ok) throw new Error(`Invalid genesis accounting: ${empty.error.message}`);
      this.#genesisAccounting = empty.value;
    }
  }

  initial(): RelayState {
    return {
      appliedSequence: 0, accounts: {}, pendingRotations: [], retiredKeys: {}, invitesUsed: [], invitations: {}, deals: {}, relayKeys: [this.config.genesisRelayKey],
      accounting: this.#genesisAccounting, reputation: initialReputationState(), policy: this.#genesisPolicy, juryDraws: initialJuryDraws(),
    };
  }

  apply(previous: RelayState, event: SignedEvent, meta: ProjectionMeta): Result<RelayState> {
    if (meta.sequence !== previous.appliedSequence + 1) return err('RECEIPT_SEQUENCE', 'Projection applied out of order', 'receipt.sequence');
    const at = timeOf(meta);
    if (!Number.isSafeInteger(at)) return err('TIMESTAMP', 'Receipt acceptedAt is not a valid IsoUtc value', 'receipt.acceptedAt');
    // The receipt before this one is the beacon of every draw whose trigger was ten receipts earlier.
    const beacons = recordBeacon(previous.juryDraws, meta.sequence, meta.previousReceiptHash);
    if (!beacons.ok) return failFrom(beacons.error);
    const withBeacons: RelayState = beacons.value === previous.juryDraws ? previous : { ...previous, juryDraws: beacons.value };
    const activated = activateRotations(withBeacons, at);
    if (!activated.ok) return activated;
    const state = activated.value;
    if (event.type !== 'KeyRotated' && state.pendingRotations.some((r) => r.oldPubkey === event.signer)) return err('STATE', 'Account is frozen by a pending key rotation', 'signer');
    const base = { ...state, appliedSequence: meta.sequence };
    const type = event.type;
    switch (type) {
      case 'AccountCreated': return this.#accountCreated(base, event, meta, at);
      case 'AccountInvited': return this.#accountInvited(base, event, meta, at);
      case 'RelayKeyRotated': return this.#relayKeyRotated(base, event, meta);
      case 'ReputationEvent': return this.#reputationEvent(base, event);
      case 'TreasurySpend': case 'CurrencyIssued': return this.#governedSpend(base, event, meta);
      case 'PolicyUpdated': return this.#policyUpdated(base, event, meta);
      case 'DealCreated': case 'DealConsented': case 'EscrowFunded': case 'DeliverableSubmitted': case 'PrecheckCompleted':
      case 'DealAccepted': case 'DealRejected': case 'DealAutoAccepted': case 'DealExpired': case 'DisputeOpened': case 'JuryAssigned':
      case 'JuryVoted': case 'JurorReplaced': case 'DisputeResolved': case 'AppealOpened': case 'AppealFeeSettled':
      case 'EscrowReleased': case 'FeeBurned': case 'EvidenceRevealed':
        return this.#dealEvent(state, base, event, meta, at);
      case 'KeyRotated': return this.#keyRotated(base, event, meta, at);
      default: { const _x: never = type; return _x; }
    }
  }

  #activePolicy(state: RelayState, sequence: number): Result<PolicyParams> {
    const entry = resolvePolicy(state.policy, sequence);
    return entry.ok ? ok(entry.value.params) : failFrom(entry.error);
  }

  #accountCreated(base: RelayState, event: SignedEvent<'AccountCreated'>, meta: ReceiptMeta, at: number): Result<RelayState> {
    const p = event.payload;
    if (Object.hasOwn(base.accounts, p.pubkey) || isKnownKey(base, p.pubkey)) return err('DUPLICATE', 'Account already exists', 'payload.pubkey');
    const policy = this.#activePolicy(base, meta.sequence);
    if (!policy.ok) return policy;
    const reputation = registerAccount(base.reputation, p.pubkey, at);
    if (!reputation.ok) return failFrom(reputation.error);
    const accounts = { ...base.accounts, [p.pubkey]: { createdSequence: meta.sequence, recoveryCommitment: p.recovery_commitment } };
    if (p.invite_ref === null) {
      if (!policy.value.genesisAccounts.includes(p.pubkey)) return err('POLICY', 'Account creation requires an invitation', 'payload.invite_ref');
      return ok({ ...base, accounts, reputation: reputation.value });
    }
    if (base.invitesUsed.includes(p.invite_ref)) return err('REPLAY', 'Invitation has already been used', 'payload.invite_ref');
    const invitation = Object.hasOwn(base.invitations, p.invite_ref) ? base.invitations[p.invite_ref] : undefined;
    if (invitation === undefined) return err('POLICY', 'invite_ref does not name a valid invitation', 'payload.invite_ref');
    if (invitation.invitee !== p.pubkey) return err('SIGNER_AUTHORITY', 'Invitation was issued to a different pubkey', 'payload.invite_ref');
    if (!(at < Date.parse(invitation.expires))) return err('WINDOW', 'Invitation has expired', 'payload.invite_ref');
    return ok({ ...base, accounts, reputation: reputation.value, invitesUsed: [...base.invitesUsed, p.invite_ref].sort() });
  }

  #accountInvited(base: RelayState, event: SignedEvent<'AccountInvited'>, meta: ReceiptMeta, at: number): Result<RelayState> {
    const p = event.payload;
    if (!Object.hasOwn(base.accounts, event.signer)) return err('STATE', 'Signer is not a registered account', 'signer');
    const policy = this.#activePolicy(base, meta.sequence);
    if (!policy.ok) return policy;
    if (!isActiveInviter(policy.value, event.signer)) return err('SIGNER_AUTHORITY', 'Signer is not an active inviter', 'signer');
    if (Object.hasOwn(base.accounts, p.invitee)) return err('DUPLICATE', 'Invitee already has an account', 'payload.invitee');
    if (!(at < Date.parse(p.expires))) return err('WINDOW', 'Invitation expires before it is accepted', 'payload.expires');
    const ref = eventHash(event);
    if (Object.hasOwn(base.invitations, ref)) return err('DUPLICATE', 'Invitation already recorded', 'payload');
    return ok({ ...base, invitations: { ...base.invitations, [ref]: { invitee: p.invitee, expires: p.expires } } });
  }

  #keyRotated(base: RelayState, event: SignedEvent<'KeyRotated'>, meta: ReceiptMeta, at: number): Result<RelayState> {
    const p = event.payload;
    if (event.signer !== p.new_pubkey) return err('SIGNER_AUTHORITY', 'KeyRotated must be signed by the new key', 'signer');
    if (p.old_pubkey === p.new_pubkey) return err('FIELD_FORMAT', 'The new key must differ from the old key', 'payload.new_pubkey');
    const account = Object.hasOwn(base.accounts, p.old_pubkey) ? base.accounts[p.old_pubkey] : undefined;
    if (account === undefined) return err('STATE', 'old_pubkey is not a registered account', 'payload.old_pubkey');
    const policy = this.#activePolicy(base, meta.sequence);
    if (!policy.ok) return policy;
    const governance = [...policy.value.multisig.members, ...policy.value.inviters, ...policy.value.checkers];
    if (governance.includes(p.old_pubkey)) return err('POLICY', 'Governance keys cannot be rotated; change them with a policy update', 'payload.old_pubkey');
    if (base.pendingRotations.some((r) => r.oldPubkey === p.old_pubkey)) return err('DUPLICATE', 'A key rotation is already pending for this account', 'payload.old_pubkey');
    if (isKnownKey(base, p.new_pubkey)) return err('DUPLICATE', 'new_pubkey is already in use or retired', 'payload.new_pubkey');
    if (recoveryCommitment(p.recovery_pubkey) !== account.recoveryCommitment) return err('SIGNER_AUTHORITY', 'recovery_pubkey does not match the account recovery commitment', 'payload.recovery_pubkey');
    const body = { old_pubkey: p.old_pubkey, new_pubkey: p.new_pubkey, new_recovery_commitment: p.new_recovery_commitment };
    if (!verifyAttestation('key-rotation', body, p.sig, p.recovery_pubkey)) return err('ATTESTATION', 'Recovery signature does not verify', 'payload.sig');
    const pending: PendingRotation = { oldPubkey: p.old_pubkey, newPubkey: p.new_pubkey, newRecoveryCommitment: p.new_recovery_commitment, effectiveAtMs: at + policy.value.keyRotationDelayMs, sequence: meta.sequence };
    return ok({ ...base, pendingRotations: [...base.pendingRotations, pending] });
  }

  #relayKeyRotated(base: RelayState, event: SignedEvent<'RelayKeyRotated'>, meta: ReceiptMeta): Result<RelayState> {
    const p = event.payload;
    if (relayKeyId(p.pubkey) !== p.key_id) return err('FIELD_FORMAT', 'key_id must be the SHA-256 of the pubkey string', 'payload.key_id');
    if (p.valid_from_sequence <= meta.sequence) return err('WINDOW', 'A relay key rotation must take effect after its own receipt', 'payload.valid_from_sequence');
    if (base.relayKeys.some((r) => r.keyId === p.key_id)) return err('REPLAY', 'Relay key id was already used', 'payload.key_id');
    const last = base.relayKeys[base.relayKeys.length - 1];
    if (last === undefined || (last.validToSequence !== null) || p.valid_from_sequence <= last.validFromSequence) return err('WINDOW', 'Rotation must start after the current key range', 'payload.valid_from_sequence');
    const policy = this.#activePolicy(base, meta.sequence);
    if (!policy.ok) return policy;
    const approved = verifyApprovals(policy.value, { type: 'RelayKeyRotated', payload: p }, event.signer);
    if (!approved.ok) return failFrom(approved.error);
    const closed: RelayKeyRange = { ...last, validToSequence: p.valid_from_sequence };
    const next: RelayKeyRange = { keyId: p.key_id, pubkey: p.pubkey, validFromSequence: p.valid_from_sequence, validToSequence: null };
    return ok({ ...base, relayKeys: [...base.relayKeys.slice(0, -1), closed, next] });
  }

  #reputationEvent(base: RelayState, event: SignedEvent<'ReputationEvent'>): Result<RelayState> {
    const p = event.payload;
    if (event.signer !== p.account) return err('SIGNER_AUTHORITY', 'ReputationEvent must be signed by its account', 'signer');
    const deal = Object.hasOwn(base.deals, p.deal_id) ? base.deals[p.deal_id] : undefined;
    if (deal === undefined) return err('STATE', 'Unknown deal', 'payload.deal_id');
    const next = applyReputationEvent(base.reputation, p, { buyer: deal.buyer, seller: deal.seller }, deal.status);
    return next.ok ? ok({ ...base, reputation: next.value }) : failFrom(next.error);
  }

  #governedSpend(base: RelayState, event: SignedEvent<'TreasurySpend' | 'CurrencyIssued'>, meta: ReceiptMeta): Result<RelayState> {
    if (!Object.hasOwn(base.accounts, event.signer)) return err('STATE', 'Signer is not a registered account', 'signer');
    const policy = this.#activePolicy(base, meta.sequence);
    if (!policy.ok) return policy;
    const recipient = event.payload.recipient;
    if (!Object.hasOwn(base.accounts, recipient)) return err('STATE', 'Recipient is not a registered account', 'payload.recipient');
    const approved = event.type === 'TreasurySpend'
      ? verifyApprovals(policy.value, { type: 'TreasurySpend', payload: event.payload }, event.signer)
      : verifyApprovals(policy.value, { type: 'CurrencyIssued', payload: event.payload }, event.signer);
    if (!approved.ok) return failFrom(approved.error);
    if (event.type === 'TreasurySpend') {
      const limit = checkTreasurySpend(policy.value, event.payload);
      if (!limit.ok) return failFrom(limit.error);
      const next = applyTreasurySpend(base.accounting, event.payload);
      return next.ok ? ok({ ...base, accounting: next.value }) : failFrom(next.error);
    }
    const limit = checkIssuance(policy.value, event.payload);
    if (!limit.ok) return failFrom(limit.error);
    const next = applyIssuance(base.accounting, event.payload);
    return next.ok ? ok({ ...base, accounting: next.value }) : failFrom(next.error);
  }

  #policyUpdated(base: RelayState, event: SignedEvent<'PolicyUpdated'>, meta: ReceiptMeta): Result<RelayState> {
    if (!Object.hasOwn(base.accounts, event.signer)) return err('STATE', 'Signer is not a registered account', 'signer');
    const next = applyPolicyUpdated(base.policy, event.payload, event.signer, meta, this.config.policyDocuments);
    return next.ok ? ok({ ...base, policy: next.value }) : failFrom(next.error);
  }

  #dealEvent(before: RelayState, base: RelayState, event: SignedEvent, meta: ReceiptMeta, at: number): Result<RelayState> {
    if (!DEAL_EVENTS.has(event.type)) return err('STATE', 'Not a deal event', 'type');
    if (!Object.hasOwn(before.accounts, event.signer)) return err('STATE', 'Signer is not a registered account', 'signer');
    const payload = event.payload as { deal_id?: unknown };
    const dealId = typeof payload.deal_id === 'string' ? payload.deal_id : null;
    if (dealId === null) return err('MISSING_FIELD', 'Deal event without deal_id', 'payload.deal_id');
    const policy = this.#activePolicy(before, meta.sequence);
    if (!policy.ok) return policy;
    if (event.type === 'DealCreated' && event.payload.amount > policy.value.limits.maxDealAmount) return err('LIMIT', 'Deal amount exceeds the policy limit', 'payload.amount');
    if (event.type === 'DealCreated') {
      if (!Object.hasOwn(before.accounts, event.payload.buyer)) return err('STATE', 'Buyer is not a registered account', 'payload.buyer');
      if (!Object.hasOwn(before.accounts, event.payload.seller)) return err('STATE', 'Seller is not a registered account', 'payload.seller');
    }
    const existing = Object.hasOwn(before.deals, dealId) ? before.deals[dealId] : undefined;
    const ctx: DealContext = { policy: dealPolicyView(policy.value), funds: spendableView(before.accounting), jury: createJuryOracle(juryContextSource(before.juryDraws, (id, round) => seatedOf(before, id, round))) };
    const result = applyDealEvent(existing, event, meta, ctx);
    if (!result.ok) return failFrom(result.error);
    const accounting = applyMovements(before.accounting, result.value.movements);
    if (!accounting.ok) return failFrom(accounting.error);
    const reputation = this.#settleReputation(before.reputation, existing?.status, result.value.state, at);
    if (!reputation.ok) return reputation;
    const draws = this.#trackJuryDraws(before, existing?.status, result.value.state, reputation.value, policy.value, meta, at);
    if (!draws.ok) return draws;
    return ok({ ...base, deals: { ...base.deals, [dealId]: result.value.state }, accounting: accounting.value, reputation: reputation.value, juryDraws: draws.value });
  }

  /** A dispute or appeal freezes its jury pool; a finished deal drops its snapshots. */
  #trackJuryDraws(before: RelayState, previous: DealState['status'] | undefined, state: DealState, reputation: ReputationState, params: PolicyParams, meta: ReceiptMeta, at: number): Result<JuryDraws> {
    if (state.status === 'completed' || state.status === 'refunded') return ok(closeDraws(before.juryDraws, state.dealId));
    const round = state.status === 'disputed' && previous !== 'disputed' ? 0 : state.status === 'appealed' && previous !== 'appealed' ? 1 : null;
    if (round === null) return ok(before.juryDraws);
    const candidates = Object.keys(reputation.accounts).flatMap((pubkey) => {
      const account = reputation.accounts[pubkey];
      return account === undefined ? [] : [toJuryCandidate(pubkey, account)];
    });
    const excluded = round === 0 ? [state.buyer, state.seller] : [state.buyer, state.seller, ...state.round0Jurors];
    const rules = { tiers: params.jury.tiers, minPoolSizeRound0: params.jury.minPoolSizeRound0, minPoolSizeRound1: params.jury.minPoolSizeRound1 };
    const opened = openDraw(before.juryDraws, state.dealId, round, { triggerSequence: meta.sequence, triggerAcceptedAtMs: at, candidates, excluded, rules });
    return opened.ok ? opened : failFrom(opened.error);
  }

  /** A deal reaching `completed` counts for both sides; a terminal deal that went through a jury also books the derived +1/-1. */
  #settleReputation(reputation: ReputationState, previous: DealState['status'] | undefined, state: DealState, at: number): Result<ReputationState> {
    const terminal = (s: DealState['status'] | undefined): boolean => s === 'completed' || s === 'refunded';
    let next = reputation;
    if (state.status === 'completed' && previous !== 'completed') {
      const done = applyDealCompleted(next, state.dealId, state.buyer, state.seller, at);
      if (!done.ok) return done;
      next = done.value;
    }
    if (terminal(state.status) && !terminal(previous)) {
      const outcome = state.finalOutcome ?? state.round0Outcome;
      if (outcome !== null) {
        const winner = outcome === 'buyer' ? state.buyer : state.seller;
        const loser = outcome === 'buyer' ? state.seller : state.buyer;
        const decided = applyDisputeOutcome(next, state.dealId, winner, loser);
        if (!decided.ok) return decided;
        next = decided.value;
      }
    }
    return ok(next);
  }
}
