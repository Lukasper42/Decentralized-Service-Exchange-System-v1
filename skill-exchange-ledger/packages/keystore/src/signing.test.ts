import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionHash, approvalActionFor, verifyApproval, verifyAttestation, verifyEvent, verifyKeyRotation } from '../../crypto/src/index.js';
import { validateEvent } from '../../validation/src/index.js';
import { T0, iso, h, uuid, newIdentity } from '../../testing/src/fixtures.js';
import { deterministicEntropy, fixedClock, testWordlist } from '../../testing/src/keystore-fixtures.js';
import { Keystore } from './keystore.js';
import type { ConfirmRequest } from './ports.js';
import { generateSeedPhrase } from './bip39.js';

const PASS = 'correct horse battery';
async function make(confirm?: (r: ConfirmRequest) => boolean | Promise<boolean>): Promise<{ keystore: Keystore; mnemonic: string; seen: ConfirmRequest[] }> {
  const entropy = deterministicEntropy('sign');
  const { mnemonic, seed } = generateSeedPhrase(entropy, testWordlist());
  const seen: ConfirmRequest[] = [];
  const policy = confirm === undefined ? {} : { confirm: (r: ConfirmRequest) => { seen.push(r); return confirm(r); } };
  const { keystore } = await Keystore.create({ seed, passphrase: PASS, entropy, clock: fixedClock(T0), kdf: { N: 1024 }, policy });
  return { keystore, mnemonic, seen };
}
const core = (signer: string, type: string, payload: unknown, prevHash: string | null = null): Record<string, unknown> => ({ type, version: 1, payload, signer, timestamp: iso(T0), prevHash });

test('signEvent: the signed event verifies with the project crypto and passes L1 validation', async () => {
  const { keystore } = await make();
  const me = keystore.identity.accountPublicKey;
  const other = newIdentity().publicKey;
  const signed = await keystore.signEvent(core(me, 'DealCreated', { deal_id: uuid(1), buyer: me, seller: other, amount: 1000, criteria_hash: h('c'), deadline: iso(T0 + 86400000) }));
  assert.ok(signed.ok);
  if (!signed.ok) return;
  assert.equal(verifyEvent(signed.value), true);
  const checked = validateEvent(signed.value, T0);
  assert.ok(checked.ok, JSON.stringify(checked));
});

test('signEvent refuses unknown types, foreign signers and malformed cores without throwing', async () => {
  const { keystore } = await make();
  const me = keystore.identity.accountPublicKey;
  const cases: Array<[unknown, string]> = [
    [core(me, 'MintMoney', {}), 'E_UNKNOWN_EVENT_TYPE'],
    [core(me, '', {}), 'E_UNKNOWN_EVENT_TYPE'],
    [core(newIdentity().publicKey, 'DealAccepted', {}), 'E_SIGNER_MISMATCH'],
    [null, 'E_BAD_INPUT'], [[], 'E_BAD_INPUT'], ['DealAccepted', 'E_BAD_INPUT'],
    [core(me, 'DealAccepted', { amount: 1.5 }), 'E_BAD_INPUT'],
    [core(me, 'DealAccepted', { amount: undefined }), 'E_BAD_INPUT'],
  ];
  for (const [input, code] of cases) {
    const result = await keystore.signEvent(input);
    assert.ok(!result.ok && result.code === code, `${JSON.stringify(input)} -> ${JSON.stringify(result)}`);
  }
});

test('money-moving and identity events need an explicit approval; denial, a missing hook and a throwing hook all refuse', async () => {
  const money = ['EscrowFunded', 'EscrowReleased', 'AppealOpened', 'TreasurySpend', 'CurrencyIssued', 'KeyRotated'];
  const none = await make();
  const me = none.keystore.identity.accountPublicKey;
  for (const type of money) {
    const result = await none.keystore.signEvent(core(me, type, {}));
    assert.ok(!result.ok && result.code === 'E_POLICY_DENIED', type);
  }
  const denied = await make(() => false);
  assert.ok(!(await denied.keystore.signEvent(core(denied.keystore.identity.accountPublicKey, 'EscrowFunded', { deal_id: uuid(1), from: denied.keystore.identity.accountPublicKey, amount: 1000 }))).ok);
  const throwing = await make(() => { throw new Error('ui crashed'); });
  const t = await throwing.keystore.signEvent(core(throwing.keystore.identity.accountPublicKey, 'EscrowReleased', {}));
  assert.ok(!t.ok && t.code === 'E_POLICY_DENIED');
  const approved = await make(async () => true);
  const key = approved.keystore.identity.accountPublicKey;
  const ok = await approved.keystore.signEvent(core(key, 'EscrowFunded', { deal_id: uuid(1), from: key, amount: 1000 }));
  assert.ok(ok.ok);
  assert.equal(approved.seen.length, 1);
  assert.equal(approved.seen[0]?.type, 'EscrowFunded');
  assert.match(approved.seen[0]?.digest ?? '', /^[a-f0-9]{64}$/);
  // Non-money events never prompt.
  const quiet = await approved.keystore.signEvent(core(key, 'DealAccepted', { deal_id: uuid(1), by: key }));
  assert.ok(quiet.ok);
  assert.equal(approved.seen.length, 1);
});

test('signAttestation: account kinds verify under the project rules; others are refused', async () => {
  const { keystore } = await make();
  const pub = keystore.identity.accountPublicKey;
  const consent = { deal_id: uuid(1), buyer: pub, seller: pub, amount: 5, criteria_hash: h('c'), deadline: iso(T0) };
  const sig = await keystore.signAttestation('deal-consent', consent);
  assert.ok(sig.ok && verifyAttestation('deal-consent', consent, sig.value, pub));
  assert.equal(verifyAttestation('precheck', consent, sig.ok ? sig.value : '', pub), false, 'a signature never verifies under another kind');
  for (const kind of ['precheck', 'jury-vote']) assert.ok((await keystore.signAttestation(kind, { x: 1 })).ok, kind);
  for (const kind of ['checkpoint', 'treasury-approval', 'key-rotation']) {
    const result = await keystore.signAttestation(kind, {});
    assert.ok(!result.ok, kind);
  }
  for (const kind of ['', 'deal-consent\nx', 'unknown', 7, null]) {
    const result = await keystore.signAttestation(kind, {});
    assert.ok(!result.ok && result.code === 'E_UNKNOWN_ATTESTATION_KIND');
  }
  const bad = await keystore.signAttestation('precheck', { n: 1.5 });
  assert.ok(!bad.ok && bad.code === 'E_BAD_INPUT');
});

test('approve: multisig approval verifies against the action hash and always needs confirmation', async () => {
  const none = await make();
  const source = { type: 'TreasurySpend' as const, payload: { recipient: newIdentity().publicKey, amount: 50, purpose_hash: h('p'), nonce: h('n'), approvals: [] } };
  const refused = await none.keystore.approve(source);
  assert.ok(!refused.ok && refused.code === 'E_POLICY_DENIED');
  const yes = await make(() => true);
  const approval = await yes.keystore.approve(source);
  assert.ok(approval.ok);
  if (!approval.ok) return;
  const hash = actionHash(approvalActionFor(source));
  assert.equal(verifyApproval(hash, approval.value), true);
  assert.equal(verifyApproval(actionHash(approvalActionFor({ ...source, payload: { ...source.payload, amount: 51 } })), approval.value), false);
  const bad = await yes.keystore.approve({ type: 'Nope' } as never);
  assert.ok(!bad.ok && bad.code === 'E_BAD_INPUT');
});

test('role separation: the recovery role signs only key-rotation attestations, and only from a mnemonic keystore', async () => {
  const { keystore, mnemonic } = await make(() => true);
  const body = { old_pubkey: keystore.identity.accountPublicKey, new_pubkey: newIdentity().publicKey, new_recovery_commitment: h('r') };
  const accountOnly = await keystore.signAttestation('key-rotation', body);
  assert.ok(!accountOnly.ok && accountOnly.code === 'E_ROLE_UNAVAILABLE');
  const recovery = Keystore.fromMnemonic({ mnemonic, wordlist: testWordlist(), roles: ['recovery'], policy: { confirm: () => true } });
  assert.ok(recovery.ok);
  if (!recovery.ok) return;
  const sig = await recovery.value.signAttestation('key-rotation', body);
  assert.ok(sig.ok);
  assert.equal(sig.ok && verifyKeyRotation(body, sig.value, recovery.value.identity.recoveryPublicKey ?? ''), true);
  const accountFromRecovery = await recovery.value.signEvent(core(keystore.identity.accountPublicKey, 'DealAccepted', {}));
  assert.ok(!accountFromRecovery.ok && accountFromRecovery.code === 'E_ROLE_UNAVAILABLE');
});
