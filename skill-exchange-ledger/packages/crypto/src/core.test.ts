import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTESTATION_KINDS, CanonicalError, CryptoInputError, actionHash, approvalActionFor, canonical, commitment, createIdentity, eventHash,
  hashCanonical, receiptHash, recoveryCommitment, relayKeyId, sha256Hex, signApproval, signAttestation, signCheckpoint, signEvent,
  signKeyRotation, signReceipt, verifyApproval, verifyAttestation, verifyCheckpoint, verifyEvent, verifyKeyRotation, verifyReceipt,
} from './index.js';
import type { EventCore, Receipt } from '../../domain/src/protocol.js';
import { h, iso, T0 } from '../../testing/src/fixtures.js';

function accountEvent() {
  const identity = createIdentity();
  const core: EventCore<'AccountCreated'> = { type: 'AccountCreated', version: 1, payload: { pubkey: identity.publicKey, recovery_commitment: h('rc'), invite_ref: null }, signer: identity.publicKey, timestamp: iso(T0), prevHash: null };
  return { identity, event: signEvent(core, identity.privateKey) };
}

test('canonical JSON sorts object keys and preserves arrays', () => {
  assert.equal(canonical({ z: 1, a: [2, 1] }), '{"a":[2,1],"z":1}');
});

test('canonical rejects non-representable values with CanonicalError', () => {
  for (const bad of [1.5, -0, Number.MAX_SAFE_INTEGER + 1, undefined, 10n, '\ud800', Symbol('s'), new Map(), { ['__proto__']: 1 }]) {
    assert.throws(() => canonical(bad), CanonicalError);
  }
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => canonical(cyclic), CanonicalError);
  assert.throws(() => canonical([1, , 3]), CanonicalError); // eslint-disable-line no-sparse-arrays
});

test('property: canonical is idempotent and key-order independent', () => {
  let seed = 12345;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const value = (depth: number): unknown => {
    const kind = rnd(depth > 2 ? 4 : 6);
    if (kind === 0) return rnd(2000) - 1000;
    if (kind === 1) return `s${rnd(100)}é\u{1f600}`;
    if (kind === 2) return rnd(2) === 0;
    if (kind === 3) return null;
    if (kind === 4) return Array.from({ length: rnd(4) }, () => value(depth + 1));
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < rnd(5); i += 1) obj[`k${rnd(50)}`] = value(depth + 1);
    return obj;
  };
  for (let i = 0; i < 300; i += 1) {
    const v = value(0);
    const text = canonical(v);
    assert.equal(canonical(JSON.parse(text)), text);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const reversed = Object.fromEntries(Object.entries(v).reverse());
      assert.equal(canonical(reversed), text);
    }
  }
});

test('A14: canonical string escaping is pinned', () => {
  // SPEC-GAP is recorded in the implementation: string escaping is JSON.stringify (RFC 8785 compatible for well-formed strings).
  assert.equal(canonical('\u0000'), '"\\u0000"');
  assert.equal(canonical('\u001f'), '"\\u001f"');
  assert.equal(canonical('\b\f\n\r\t'), '"\\b\\f\\n\\r\\t"');
  assert.equal(canonical('"'), '"\\""');
  assert.equal(canonical('\\'), '"\\\\"');
  assert.equal(canonical('\u007f'), '"\u007f"');
  assert.equal(canonical('  '), '"  "');
  assert.equal(canonical('\u{1f600}'), '"\u{1f600}"');
  assert.equal(canonical({ 'a\nb': 1 }), '{"a\\nb":1}');
});

test('A12: sha256Hex and hashCanonical are distinct, explicit functions', () => {
  assert.notEqual(hashCanonical('abc'), sha256Hex('abc'));
  assert.equal(hashCanonical('abc'), sha256Hex('"abc"'));
  assert.equal(sha256Hex('héllo'), sha256Hex(new TextEncoder().encode('héllo')));
  assert.equal(hashCanonical({ b: 1, a: 2 }), sha256Hex('{"a":2,"b":1}'));
  const { event } = accountEvent();
  assert.equal(eventHash(event), hashCanonical(event));
});

test('signed event verifies, and payload tampering is detected', () => {
  const { event } = accountEvent();
  assert.equal(verifyEvent(event), true);
  assert.equal(eventHash(event).length, 64);
  assert.equal(verifyEvent({ ...event, payload: { ...event.payload, recovery_commitment: h('other') } }), false);
});

test('E16: malformed signatures and keys are rejected without throwing', () => {
  const { event } = accountEvent();
  assert.equal(verifyEvent({ ...event, signature: event.signature.slice(0, -4) }), false);
  assert.equal(verifyEvent({ ...event, signature: `${event.signature}\n` }), false);
  assert.equal(verifyEvent({ ...event, signature: Buffer.alloc(63).toString('base64') }), false);
  assert.equal(verifyEvent({ ...event, signer: 'not-a-key' }), false);
  assert.equal(verifyEvent({ ...event, payload: { ...event.payload, recovery_commitment: 1.5 as unknown as string } }), false);
});

test('A13: attestation kinds are a closed set', () => {
  const id = createIdentity();
  for (const kind of ATTESTATION_KINDS) {
    const signature = signAttestation(kind, { x: 1 }, id.privateKey);
    assert.equal(verifyAttestation(kind, { x: 1 }, signature, id.publicKey), true);
    assert.equal(verifyAttestation(kind, { x: 2 }, signature, id.publicKey), false);
  }
  const good = signAttestation('precheck', { x: 1 }, id.privateKey);
  assert.equal(verifyAttestation('precheck\nx', { x: 1 }, good, id.publicKey), false);
  assert.equal(verifyAttestation('unknown', { x: 1 }, good, id.publicKey), false);
  assert.equal(verifyAttestation('jury-vote', { x: 1 }, good, id.publicKey), false, 'domain separation');
  // @ts-expect-error unknown kinds are a compile error as well
  assert.throws(() => signAttestation('bad\nkind', { x: 1 }, id.privateKey), CryptoInputError);
});

test('B3: receipt sign/verify binds keyId and every field; receiptHash includes the signature', () => {
  const relay = createIdentity();
  const core = { sequence: 1, eventHash: h('e'), previousReceiptHash: null, acceptedAt: iso(T0), keyId: relayKeyId(relay.publicKey) };
  const receipt = signReceipt(core, relay.privateKey);
  assert.equal(verifyReceipt(receipt, relay.publicKey), true);
  assert.equal(verifyReceipt({ ...receipt, sequence: 2 }, relay.publicKey), false);
  assert.equal(verifyReceipt({ ...receipt, keyId: h('wrong') }, relay.publicKey), false);
  assert.equal(verifyReceipt(receipt, createIdentity().publicKey), false);
  const { keyId: _k, ...legacy } = receipt;
  assert.equal(verifyReceipt(legacy as unknown as Receipt, relay.publicKey), false);
  assert.equal(relayKeyId(relay.publicKey), sha256Hex(relay.publicKey));
  assert.equal(receiptHash(receipt), hashCanonical(receipt));
  assert.notEqual(receiptHash(receipt), receiptHash({ ...receipt, signature: signReceipt({ ...core, sequence: 3 }, relay.privateKey).signature }));
});

test('E11: commitment uses domain prefix, kind, 32-byte salt and content', () => {
  const salt = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const content = new TextEncoder().encode('content');
  const expected = sha256Hex(Buffer.concat([Buffer.from('skillx/v1/commit/criteria\n'), salt, content]));
  assert.equal(commitment('criteria', salt, content), expected);
  assert.notEqual(commitment('reason', salt, content), expected);
  assert.throws(() => commitment('criteria', salt.subarray(0, 31), content), CryptoInputError);
  assert.throws(() => commitment('criteria', new Uint8Array(33), content), CryptoInputError);
  // @ts-expect-error closed kind set
  assert.throws(() => commitment('other', salt, content), CryptoInputError);
  const recovery = createIdentity().publicKey;
  assert.equal(recoveryCommitment(recovery), sha256Hex(`skillx/v1/recovery\n${recovery}`));
});

test('E10: action hashes bind every listed field and approvals verify only for that hash', () => {
  const signer = createIdentity();
  const base = { recipient: signer.publicKey, amount: 10, purpose_hash: h('p'), nonce: h('n'), approvals: [] };
  const hashOf = (p: typeof base) => actionHash(approvalActionFor({ type: 'TreasurySpend', payload: p }));
  const original = hashOf(base);
  assert.notEqual(hashOf({ ...base, amount: 11 }), original);
  assert.notEqual(hashOf({ ...base, nonce: h('n2') }), original);
  assert.equal(original, sha256Hex(canonical({ action: 'treasury-spend', recipient: base.recipient, amount: 10, purpose_hash: base.purpose_hash, nonce: base.nonce })));
  const issued = actionHash(approvalActionFor({ type: 'CurrencyIssued', payload: { recipient: signer.publicKey, amount: 5, policy_id: 'p.v1', basis_hash: h('b'), grant_kind: 'activity', nonce: h('n'), approvals: [] } }));
  const rotated = actionHash(approvalActionFor({ type: 'RelayKeyRotated', payload: { key_id: h('k'), pubkey: signer.publicKey, valid_from_sequence: 5, approvals: [] } }));
  const policy = actionHash(approvalActionFor({ type: 'PolicyUpdated', payload: { policy_version: 2, params_hash: h('x'), activation_sequence: 9, approvals: [] } }));
  assert.equal(new Set([original, issued, rotated, policy]).size, 4);
  const approval = signApproval(original, signer.publicKey, signer.privateKey);
  assert.equal(verifyApproval(original, approval), true);
  assert.equal(verifyApproval(issued, approval), false);
  assert.equal(verifyApproval(original, { ...approval, signer: createIdentity().publicKey }), false);
});

test('B3: checkpoint and key-rotation attestations verify only with the right key', () => {
  const relay = createIdentity(); const recovery = createIdentity();
  const checkpoint = { sequence: 4, receipt_hash: h('r'), key_id: relayKeyId(relay.publicKey) };
  const checkpointSig = signCheckpoint(checkpoint, relay.privateKey);
  assert.equal(verifyCheckpoint(checkpoint, checkpointSig, relay.publicKey), true);
  assert.equal(verifyCheckpoint({ ...checkpoint, sequence: 5 }, checkpointSig, relay.publicKey), false);
  const rotation = { old_pubkey: createIdentity().publicKey, new_pubkey: createIdentity().publicKey, new_recovery_commitment: h('nrc') };
  const rotationSig = signKeyRotation(rotation, recovery.privateKey);
  assert.equal(verifyKeyRotation(rotation, rotationSig, recovery.publicKey), true);
  assert.equal(verifyKeyRotation(rotation, rotationSig, relay.publicKey), false);
  assert.equal(verifyKeyRotation(rotation, checkpointSig, recovery.publicKey), false);
});
