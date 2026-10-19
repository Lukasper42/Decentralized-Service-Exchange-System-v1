/**
 * Test-support fixtures. Everything is generated at run time by the code under test (createIdentity, signEvent, ...);
 * no literal keys, hashes or signatures. Time is explicit and deterministic.
 */
import type { EventCore, EventType, Hash, PayloadMap, Pubkey, Receipt, SignedEvent } from '../../domain/src/protocol.js';
import type { RelayKeyRange } from '../../domain/src/ports.js';
import {
  CanonicalError, actionHash, approvalActionFor, commitment, createIdentity, eventHash, receiptHash, recoveryCommitment, relayKeyId,
  sha256Hex, signApproval, signAttestation, signEvent, signReceipt,
} from '../../crypto/src/index.js';

export interface Identity { privateKey: string; publicKey: string }
export const DAY = 86400000;
export const T0 = Date.parse('2026-10-01T00:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();
export const newIdentity = (): Identity => createIdentity();
/** Deterministic hash-shaped value derived at run time. */
export const h = (label: string): Hash => sha256Hex(`fixture/${label}`);
/** Deterministic lowercase UUIDv4. */
export function uuid(n: number): string { return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`; }

export function eventOf<T extends EventType>(type: T, payload: PayloadMap[T], signer: Identity, timestampMs: number, prevHash: Hash | null = null): SignedEvent<T> {
  const core = { type, version: 1, payload, signer: signer.publicKey, timestamp: iso(timestampMs), prevHash } as EventCore<T>;
  return signEvent(core, signer.privateKey);
}
/** Sign an arbitrary (possibly invalid) envelope body so validation, not signing, is what rejects it. */
export function rawEvent(body: Record<string, unknown>, signer: Identity): Record<string, unknown> {
  const core = body as unknown as EventCore;
  try { return { ...body, signature: signEvent(core, signer.privateKey).signature }; }
  catch (error) {
    if (!(error instanceof CanonicalError)) throw error;
    // Not canonically representable (e.g. a float amount): the signature is irrelevant, only its format matters.
    return { ...body, signature: signEvent({ ...core, payload: {} } as unknown as EventCore, signer.privateKey).signature };
  }
}

/** Relay with one key and a ledger that issues receipts. */
export class TestLedger {
  readonly relay = newIdentity();
  readonly entries: Array<{ event: SignedEvent; receipt: Receipt }> = [];
  private readonly tips = new Map<string, Hash>();
  get keyRanges(): RelayKeyRange[] {
    return [{ keyId: relayKeyId(this.relay.publicKey), pubkey: this.relay.publicKey, validFromSequence: 1, validToSequence: null }];
  }
  /** Append a signed event for `signer`, linking to that signer's tip, with a receipt at `acceptedAtMs`. */
  append<T extends EventType>(type: T, payload: PayloadMap[T], signer: Identity, acceptedAtMs: number): { event: SignedEvent<T>; receipt: Receipt } {
    const typed = eventOf(type, payload, signer, acceptedAtMs, this.tips.get(signer.publicKey) ?? null);
    const event = typed as unknown as SignedEvent;
    const receipt = this.receiptFor(event, acceptedAtMs);
    this.entries.push({ event, receipt });
    this.tips.set(signer.publicKey, eventHash(event));
    return { event: typed, receipt };
  }
  receiptFor(event: SignedEvent, acceptedAtMs: number, relayKey: Identity = this.relay): Receipt {
    const last = this.entries[this.entries.length - 1];
    return signReceipt({
      sequence: this.entries.length + 1, eventHash: eventHash(event), previousReceiptHash: last === undefined ? null : receiptHash(last.receipt),
      acceptedAt: iso(acceptedAtMs), keyId: relayKeyId(relayKey.publicKey),
    }, relayKey.privateKey);
  }
}

export interface Cast { buyer: Identity; seller: Identity; outsider: Identity; checker: Identity; jurors: Identity[]; extra: Identity[] }
export function newCast(): Cast {
  return { buyer: newIdentity(), seller: newIdentity(), outsider: newIdentity(), checker: newIdentity(), jurors: Array.from({ length: 12 }, newIdentity), extra: Array.from({ length: 4 }, newIdentity) [...]
}

/** A structurally valid payload for every event type (L1), signed attestations included. */
export function validPayload(type: EventType, cast: Cast, signer: Identity, nowMs: number): PayloadMap[EventType] {
  const dealId = uuid(1);
  const pub = (i: Identity): Pubkey => i.publicKey;
  switch (type) {
    case 'AccountCreated': return { pubkey: pub(signer), recovery_commitment: recoveryCommitment(pub(cast.extra[0] ?? signer)), invite_ref: null };
    case 'AccountInvited': return { invitee: pub(cast.extra[1] ?? signer), expires: iso(nowMs + DAY) };
    case 'KeyRotated': return { old_pubkey: pub(cast.extra[2] ?? signer), new_pubkey: pub(signer), recovery_pubkey: pub(cast.extra[0] ?? signer), new_recovery_commitment: h('rec'), sig: signAttestatio[...]
    case 'DealCreated': return { deal_id: dealId, buyer: pub(cast.buyer), seller: pub(cast.seller), amount: 1000, criteria_hash: commitment('criteria', Uint8Array.from({ length: 32 }, (_, i) => i), ne[...]
    case 'DealConsented': return { deal_id: dealId, seller: pub(cast.seller), consent_sig: signAttestation('deal-consent', { x: 1 }, cast.seller.privateKey) };
    case 'EscrowFunded': return { deal_id: dealId, from: pub(cast.buyer), amount: 1000 };
    case 'DeliverableSubmitted': return { deal_id: dealId, content_hash: h('content'), precheck_ref: null };
    case 'PrecheckCompleted': return { deal_id: dealId, content_hash: h('content'), result: 'pass', checker_id: pub(signer), sig: signAttestation('precheck', { deal_id: dealId, content_hash: h('conten[...]
    case 'DealAccepted': return { deal_id: dealId, by: pub(signer) };
    case 'DealRejected': return { deal_id: dealId, by: pub(signer), reason_hash: h('reason') };
    case 'DealAutoAccepted': return { deal_id: dealId, by: pub(signer) };
    case 'DealExpired': return { deal_id: dealId, by: pub(signer) };
    case 'DisputeOpened': return { deal_id: dealId, by: pub(signer) };
    case 'JuryAssigned': return { deal_id: dealId, jurors: cast.jurors.slice(0, 3).map(pub), appeal_round: 0 };
    case 'JuryVoted': return { deal_id: dealId, juror: pub(signer), vote: 'buyer', appeal_round: 0, sig: signAttestation('jury-vote', { deal_id: dealId, juror: pub(signer), vote: 'buyer', appeal_round[...]
    case 'JurorReplaced': return { deal_id: dealId, appeal_round: 0, missing_juror: pub(cast.jurors[0] ?? signer), replacement: pub(cast.jurors[3] ?? signer) };
    case 'DisputeResolved': return { deal_id: dealId, outcome: 'buyer', appeal_round: 0 };
    case 'AppealOpened': return { deal_id: dealId, by: pub(signer), fee_amount: 100 };
    case 'AppealFeeSettled': return { deal_id: dealId, outcome: 'returned', amount: 100 };
    case 'EscrowReleased': return { deal_id: dealId, to: pub(cast.seller), amount: 990 };
    case 'FeeBurned': return { deal_id: dealId, amount: 10 };
    case 'ReputationEvent': return { account: pub(signer), counterparty: pub(cast.seller), deal_id: dealId, delta: 1, reason_hash: h('rep') };
    case 'EvidenceRevealed': return { deal_id: dealId, by: pub(signer), kind: 'criteria', salt: sha256Hex('salt') };
    case 'TreasurySpend': return treasury(type, signer, cast, { recipient: pub(cast.outsider), amount: 50, purpose_hash: h('purpose'), nonce: h('nonce') });
    case 'CurrencyIssued': return treasury(type, signer, cast, { recipient: pub(cast.outsider), amount: 50, policy_id: 'beta.v1', basis_hash: h('basis'), grant_kind: 'beta-grant', nonce: h('nonce2') }[...]
    case 'RelayKeyRotated': return treasury(type, signer, cast, { key_id: h('keyid'), pubkey: pub(cast.extra[3] ?? signer), valid_from_sequence: 10 });
    case 'PolicyUpdated': return treasury(type, signer, cast, { policy_version: 2, params_hash: h('params'), activation_sequence: 20 });
    default: { const _x: never = type; return _x; }
  }
}

function treasury(type: 'TreasurySpend' | 'CurrencyIssued' | 'RelayKeyRotated' | 'PolicyUpdated', signer: Identity, cast: Cast, fields: Record<string, unknown>): PayloadMap[EventType] {
  const second = cast.extra[0] ?? signer;
  const draft = { type, payload: { ...fields, approvals: [] } } as unknown as Parameters<typeof approvalActionFor>[0];
  const action = actionHash(approvalActionFor(draft));
  const approvals = [signApproval(action, signer.publicKey, signer.privateKey), signApproval(action, second.publicKey, second.privateKey)];
  return { ...fields, approvals } as unknown as PayloadMap[EventType];
}
