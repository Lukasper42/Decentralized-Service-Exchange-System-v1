import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, signAttestation } from '../../crypto/src/index.js';
import { EVENT_TYPES, TIMESTAMP_SKEW_MS } from '../../domain/src/protocol.js';
import type { EventType } from '../../domain/src/protocol.js';
import { DAY, T0, eventOf, h, iso, newCast, rawEvent, uuid, validPayload } from '../../testing/src/fixtures.js';
import type { Identity } from '../../testing/src/fixtures.js';
import { eventFields, validateEvent } from './index.js';

const cast = newCast();
/** Which cast member signs a valid event of this type. */
function signerFor(type: EventType): Identity {
  switch (type) {
    case 'DealCreated': case 'EscrowFunded': case 'DealAccepted': case 'DealRejected': return cast.buyer;
    case 'DealConsented': case 'DeliverableSubmitted': case 'DealAutoAccepted': return cast.seller;
    case 'PrecheckCompleted': return cast.checker;
    case 'JuryVoted': return cast.jurors[0] ?? cast.outsider;
    case 'AppealOpened': case 'DealExpired': case 'DisputeOpened': case 'EvidenceRevealed': return cast.buyer;
    default: return cast.outsider;
  }
}
function validEvent(type: EventType) {
  const signer = signerFor(type);
  const payload = validPayload(type, cast, signer, T0);
  return { signer, payload, event: eventOf(type, payload as never, signer, T0) };
}
function withPayload(type: EventType, patch: Record<string, unknown>, remove: string[] = []): Record<string, unknown> {
  const { signer, payload } = validEvent(type);
  const next: Record<string, unknown> = { ...payload, ...patch };
  for (const key of remove) delete next[key];
  return rawEvent({ type, version: 1, payload: next, signer: signer.publicKey, timestamp: iso(T0), prevHash: null }, signer);
}
function code(result: ReturnType<typeof validateEvent>): string { return result.ok ? 'OK' : result.error.code; }

test('E19/B4: every one of the 27 event types validates at L1 without any state', () => {
  assert.equal(EVENT_TYPES.length, 27);
  for (const type of EVENT_TYPES) {
    const { event } = validEvent(type);
    const result = validateEvent(event, T0);
    assert.equal(result.ok, true, `${type}: ${result.ok ? '' : `${result.error.code} ${result.error.path} ${result.error.message}`}`);
  }
});

test('B4: exact payload — every field missing or extra is rejected with a stable code and path', () => {
  for (const type of EVENT_TYPES) {
    for (const field of eventFields(type)) {
      const missing = validateEvent(withPayload(type, {}, [field]), T0);
      assert.deepEqual([code(missing), missing.ok ? '' : missing.error.path], ['MISSING_FIELD', `payload.${field}`], `${type}.${field} missing`);
    }
    const extra = validateEvent(withPayload(type, { extra: true }), T0);
    assert.deepEqual([code(extra), extra.ok ? '' : extra.error.path], ['UNKNOWN_FIELD', 'payload.extra']);
  }
});

test('A2: no coercion — wrong JS types are rejected for every enum, range and flag field', () => {
  const cases: Array<[EventType, string, unknown[]]> = [
    ['JuryAssigned', 'appeal_round', ['1', true, null, [], [1], 1.5, '', 2, -1, {}]],
    ['JuryVoted', 'appeal_round', ['1', true, null, [], [0], '0']],
    ['JuryVoted', 'vote', [['buyer'], null, 1, true, 'BUYER', {}]],
    ['PrecheckCompleted', 'result', [['pass'], null, 1, true, 'PASS', {}]],
    ['DisputeResolved', 'outcome', [['buyer'], null, 0, 'returned']],
    ['DisputeResolved', 'appeal_round', ['0', false, null, []]],
    ['AppealFeeSettled', 'outcome', [['returned'], 'buyer', null]],
    ['ReputationEvent', 'delta', ['1', true, null, '', [], [1], 2, -2, 0.5, '0', false]],
    ['CurrencyIssued', 'grant_kind', [['activity'], null, 1, 'Activity']],
    ['EvidenceRevealed', 'kind', [['criteria'], null, 'other']],
    ['EscrowFunded', 'amount', ['1000', true, null, [], 1.5, 0, 1, -5]],
    ['DealCreated', 'amount', ['1000', null, 900719925475]],
    ['DealCreated', 'deal_id', [1, null, [], 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']],
    ['PolicyUpdated', 'policy_version', ['2', true, null, 0, -1]],
  ];
  for (const [type, field, values] of cases) {
    for (const value of values) {
      const result = validateEvent(withPayload(type, { [field]: value }), T0);
      assert.equal(result.ok, false, `${type}.${field}=${JSON.stringify(value)} must be rejected`);
      if (!result.ok) assert.ok(['FIELD_FORMAT', 'AMOUNT', 'PAYLOAD'].includes(result.error.code), `${type}.${field}: ${result.error.code}`);
    }
  }
  const amountResult = validateEvent(withPayload('EscrowFunded', { amount: 1 }), T0);
  assert.equal(code(amountResult), 'AMOUNT');
  assert.equal(code(validateEvent(withPayload('EscrowFunded', { amount: 2 }), T0)), 'OK');
  assert.equal(code(validateEvent(withPayload('EscrowFunded', { amount: 900719925474 }), T0)), 'OK');
  assert.equal(code(validateEvent(withPayload('EscrowFunded', { amount: 900719925475 }), T0)), 'AMOUNT');
});

test('A9: no wall-clock window — an old event validates against its own receipt time; skew is symmetric 5 minutes', () => {
  const old = Date.parse('2020-01-01T00:00:00.000Z');
  const { signer } = validEvent('AccountCreated');
  const payload = validPayload('AccountCreated', cast, signer, old);
  const event = eventOf('AccountCreated', payload as never, signer, old);
  assert.equal(validateEvent(event, old).ok, true);
  assert.equal(validateEvent(event, old + TIMESTAMP_SKEW_MS).ok, true);
  assert.equal(validateEvent(event, old - TIMESTAMP_SKEW_MS).ok, true);
  assert.equal(code(validateEvent(event, old + TIMESTAMP_SKEW_MS + 1)), 'TIMESTAMP');
  assert.equal(code(validateEvent(event, old - TIMESTAMP_SKEW_MS - 1)), 'TIMESTAMP');
  assert.equal(code(validateEvent(event, Number.NaN)), 'TIMESTAMP');
  assert.equal(code(validateEvent(event, 1.5)), 'TIMESTAMP');
});

test('E2: DealCreated deadline must be later than acceptedAt, not than the claimed timestamp', () => {
  const { signer, payload } = validEvent('DealCreated');
  const make = (deadline: number) => eventOf('DealCreated', { ...(payload as never as Record<string, unknown>), deadline: iso(deadline) } as never, signer, T0);
  assert.equal(validateEvent(make(T0 + 1), T0).ok, true);
  assert.equal(code(validateEvent(make(T0), T0)), 'TIMESTAMP');
  // acceptedAt is 4 minutes after the claimed timestamp: a deadline between them is rejected.
  assert.equal(code(validateEvent(make(T0 + 60000), T0 + 240000)), 'TIMESTAMP');
});

test('A15: approvals must contain 2 to 3 unique entries (LIMIT)', () => {
  const { payload } = validEvent('TreasurySpend');
  const approvals = (payload as { approvals: Array<{ signer: string; sig: string }> }).approvals;
  const [first, second] = approvals;
  assert.ok(first && second);
  const extra = createIdentity();
  const third = { signer: extra.publicKey, sig: signAttestation('treasury-approval', { x: 1 }, extra.privateKey) };
  const fourth = { signer: createIdentity().publicKey, sig: third.sig };
  assert.equal(code(validateEvent(withPayload('TreasurySpend', { approvals: [first] }), T0)), 'LIMIT');
  assert.equal(code(validateEvent(withPayload('TreasurySpend', { approvals: [] }), T0)), 'LIMIT');
  assert.equal(code(validateEvent(withPayload('TreasurySpend', { approvals: [first, second, third, fourth] }), T0)), 'LIMIT');
  assert.equal(code(validateEvent(withPayload('TreasurySpend', { approvals: [first, { ...second, signer: first.signer }] }), T0)), 'LIMIT');
  assert.equal(code(validateEvent(withPayload('TreasurySpend', { approvals: [first, second, third] }), T0)), 'OK');
  assert.equal(code(validateEvent(withPayload('TreasurySpend', { approvals: [first, { ...second, extra: 1 }] }), T0)), 'PAYLOAD');
});

test('B4: jurors are exactly 3 (round 0) or 5 (round 1) unique keys', () => {
  const keys = (n: number) => cast.jurors.slice(0, n).map((j) => j.publicKey);
  assert.equal(code(validateEvent(withPayload('JuryAssigned', { jurors: keys(5), appeal_round: 1 }), T0)), 'OK');
  assert.equal(code(validateEvent(withPayload('JuryAssigned', { jurors: keys(3), appeal_round: 1 }), T0)), 'LIMIT');
  assert.equal(code(validateEvent(withPayload('JuryAssigned', { jurors: keys(5), appeal_round: 0 }), T0)), 'LIMIT');
  assert.equal(code(validateEvent(withPayload('JuryAssigned', { jurors: [...keys(2), keys(2)[0]], appeal_round: 0 }), T0)), 'LIMIT');
  assert.equal(code(validateEvent(withPayload('JuryAssigned', { jurors: keys(4), appeal_round: 0 }), T0)), 'LIMIT');
});

test('E11: EvidenceRevealed salt is 64 hex, except the empty sentinel for precheck-report', () => {
  assert.equal(code(validateEvent(withPayload('EvidenceRevealed', { kind: 'precheck-report', salt: '' }), T0)), 'OK');
  assert.equal(code(validateEvent(withPayload('EvidenceRevealed', { kind: 'precheck-report', salt: h('s') }), T0)), 'FIELD_FORMAT');
  assert.equal(code(validateEvent(withPayload('EvidenceRevealed', { kind: 'reason', salt: '' }), T0)), 'FIELD_FORMAT');
  assert.equal(code(validateEvent(withPayload('EvidenceRevealed', { kind: 'reason', salt: 'a'.repeat(63) }), T0)), 'FIELD_FORMAT');
  assert.equal(code(validateEvent(withPayload('EvidenceRevealed', { kind: 'purpose', salt: h('s').toUpperCase() }), T0)), 'FIELD_FORMAT');
});

test('E9: old both_sigs reputation shape and self-reputation are rejected', () => {
  assert.equal(code(validateEvent(withPayload('ReputationEvent', { both_sigs: { account_sig: 'x', counterparty_sig: 'y' } }), T0)), 'UNKNOWN_FIELD');
  assert.equal(code(validateEvent(withPayload('ReputationEvent', { counterparty: cast.outsider.publicKey, account: cast.outsider.publicKey }), T0)), 'PAYLOAD');
});

test('B4: signer authority that needs only the payload', () => {
  const cases: Array<[EventType, Record<string, unknown>]> = [
    ['AccountCreated', { pubkey: cast.seller.publicKey }],
    ['KeyRotated', { new_pubkey: cast.seller.publicKey }],
    ['DealCreated', { buyer: cast.seller.publicKey, seller: cast.buyer.publicKey }],
    ['DealConsented', { seller: cast.buyer.publicKey }],
    ['PrecheckCompleted', { checker_id: cast.seller.publicKey }],
    ['DealAccepted', { by: cast.seller.publicKey }],
    ['DealAutoAccepted', { by: cast.buyer.publicKey }],
    ['DealExpired', { by: cast.seller.publicKey }],
    ['DisputeOpened', { by: cast.seller.publicKey }],
    ['JuryVoted', { juror: cast.buyer.publicKey }],
    ['AppealOpened', { by: cast.seller.publicKey }],
    ['EvidenceRevealed', { by: cast.seller.publicKey }],
  ];
  for (const [type, patch] of cases) assert.equal(code(validateEvent(withPayload(type, patch), T0)), 'SIGNER_AUTHORITY', type);
  // Treasury-class events: the signer must be one of the listed approvers.
  const { payload } = validEvent('TreasurySpend');
  const forged = rawEvent({ type: 'TreasurySpend', version: 1, payload, signer: cast.seller.publicKey, timestamp: iso(T0), prevHash: null }, cast.seller);
  assert.equal(code(validateEvent(forged, T0)), 'SIGNER_AUTHORITY');
});

test('B4: PrecheckCompleted and JuryVoted attestations are verified at L1; KeyRotated.sig is not', () => {
  const wrongKey = createIdentity();
  const badSig = signAttestation('precheck', { x: 1 }, wrongKey.privateKey);
  assert.equal(code(validateEvent(withPayload('PrecheckCompleted', { sig: badSig }), T0)), 'ATTESTATION');
  assert.equal(code(validateEvent(withPayload('JuryVoted', { sig: badSig }), T0)), 'ATTESTATION');
  assert.equal(code(validateEvent(withPayload('KeyRotated', { sig: badSig }), T0)), 'OK');
});

test('E18: malformed input yields stable codes with a path, never an exception', () => {
  const { event } = validEvent('AccountCreated');
  const bad: Array<[unknown, string]> = [
    [null, 'ENVELOPE'], [[], 'ENVELOPE'], ['x', 'ENVELOPE'], [{ ...event, version: 2 }, 'VERSION'], [{ ...event, extra: 1 }, 'ENVELOPE'],
    [{ ...event, type: 'Nope' }, 'UNKNOWN_TYPE'], [{ ...event, timestamp: '2026-10-01' }, 'FIELD_FORMAT'], [{ ...event, payload: [] }, 'PAYLOAD'],
    [{ ...event, signer: 'x' }, 'FIELD_FORMAT'], [{ ...event, signature: 'x' }, 'FIELD_FORMAT'], [{ ...event, prevHash: 'x' }, 'FIELD_FORMAT'],
    [{ ...event, signature: `${event.signature.slice(0, 10)}${event.signature[10] === 'A' ? 'B' : 'A'}${event.signature.slice(11)}` }, 'SIGNATURE'],
    [{ ...event, payload: { ...event.payload, recovery_commitment: 1.5 } }, 'PAYLOAD'],
  ];
  const { version: _v, ...noVersion } = event;
  bad.push([noVersion, 'VERSION']);
  const hostile = { ...event }; Object.defineProperty(hostile, 'payload', { get() { throw new Error('boom'); }, enumerable: true });
  bad.push([hostile, 'PAYLOAD']);
  for (const [input, expected] of bad) {
    const result = validateEvent(input, T0);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, expected); assert.equal(typeof result.error.path, 'string'); assert.ok(result.error.path.length > 0); }
  }
});

test('E19: L1 does not infer state — a DealAccepted for an unknown deal is structurally valid', () => {
  assert.equal(validateEvent(validEvent('DealAccepted').event, T0).ok, true);
  assert.equal(validateEvent(eventOf('DealAccepted', { deal_id: uuid(99), by: cast.buyer.publicKey }, cast.buyer, T0 + DAY - DAY), T0).ok, true);
});
