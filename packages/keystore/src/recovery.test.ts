import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventHash, recoveryCommitment, verifyEvent, verifyKeyRotation } from '../../crypto/src/index.js';
import { validateEvent } from '../../validation/src/index.js';
import { verifyChain } from '../../chain-verifier/src/index.js';
import { T0, TestLedger, iso } from '../../testing/src/fixtures.js';
import { deterministicEntropy, fixedClock, testWordlist } from '../../testing/src/keystore-fixtures.js';
import { RecoveryFlow } from './recovery.js';
import type { Keystore } from './keystore.js';
import type { SignedEvent } from '../../domain/src/protocol.js';

const PASS = 'correct horse battery';
function flowFor(label: string): RecoveryFlow {
  return new RecoveryFlow({ entropy: deterministicEntropy(label), clock: fixedClock(T0), wordlist: testWordlist(), policy: { confirm: () => true }, kdf: { N: 1024 } });
}
async function createAccount(label: string): Promise<{ flow: RecoveryFlow; words: string[]; keystore: Keystore; accountCreated: { pubkey: string; recovery_commitment: string; invite_ref: string | null } }> {
  const flow = flowFor(label);
  const { words } = flow.beginCreation();
  const { challenge } = flow.acknowledgeSeed();
  assert.equal(challenge.length, 3);
  const answered = flow.answerChallenge(challenge.map((index) => ({ index, word: words[index] ?? '' })));
  assert.equal(answered.ok, true);
  const { keystore, accountCreated } = await flow.commit({ passphrase: PASS });
  return { flow, words, keystore, accountCreated };
}
function put(ledger: TestLedger, event: SignedEvent, ms: number): void { ledger.entries.push({ event, receipt: ledger.receiptFor(event, ms) }); }

test('create path: seed shown once, challenge verified, commit yields an AccountCreated payload that passes L1', async () => {
  const { flow, words, keystore, accountCreated } = await createAccount('create');
  assert.equal(flow.state, 'active');
  assert.equal(words.length, 12);
  assert.equal(accountCreated.recovery_commitment, keystore.identity.recoveryCommitment);
  const signed = await keystore.signEvent({ type: 'AccountCreated', version: 1, signer: accountCreated.pubkey, timestamp: iso(T0), prevHash: null, payload: accountCreated });
  assert.ok(signed.ok);
  if (!signed.ok) return;
  assert.ok(validateEvent(signed.value, T0).ok);
  assert.throws(() => flow.beginCreation(), /E_STATE/, 'a second show of the seed is impossible');
  assert.ok(!JSON.stringify(accountCreated).includes(words[0] ?? '#'));
});

test('failure paths: wrong word, exhausted attempts re-show the seed with a new challenge, out-of-order calls are refused', async () => {
  const flow = flowFor('fail');
  assert.throws(() => flow.acknowledgeSeed(), /E_STATE/);
  const { words } = flow.beginCreation();
  const first = flow.acknowledgeSeed().challenge;
  const wrong = first.map((index) => ({ index, word: 'zzz' }));
  const r1 = flow.answerChallenge(wrong);
  assert.deepEqual([r1.ok, r1.reason, r1.remaining], [false, 'wrong_word', 2]);
  assert.equal(flow.answerChallenge(wrong).remaining, 1);
  const r3 = flow.answerChallenge(wrong);
  assert.deepEqual([r3.ok, r3.reason, r3.state], [false, 'attempts_exhausted', 'seed_shown']);
  await assert.rejects(flow.commit({ passphrase: PASS }), /E_STATE/);
  const second = flow.acknowledgeSeed().challenge;
  assert.equal(second.length, 3);
  assert.ok(second.every((i) => i >= 0 && i < words.length));
  assert.equal(flow.answerChallenge([]).ok, false, 'wrong answer shape never passes');
  await assert.rejects(flow.commit({ passphrase: PASS }), /E_STATE/, 'commit needs a verified challenge');
});

test('full recovery: lost device, restore from the words, rotate; the ledger accepts the chain and the signature binds the old commitment', async () => {
  const ledger = new TestLedger();
  const { words, keystore: oldKeystore, accountCreated } = await createAccount('recovery-old');
  const created = await oldKeystore.signEvent({ type: 'AccountCreated', version: 1, signer: accountCreated.pubkey, timestamp: iso(T0), prevHash: null, payload: accountCreated });
  assert.ok(created.ok);
  if (!created.ok) return;
  put(ledger, created.value, T0);
  oldKeystore.destroy(); // the device is gone

  const newDevice = await createAccount('recovery-new');
  const recoveryFlow = flowFor('recovery-flow');
  const begun = recoveryFlow.beginRecovery({ mnemonic: words.join(' '), expectedCommitment: accountCreated.recovery_commitment });
  assert.ok(begun.ok);
  const rotated = await recoveryFlow.buildRotation({ newKeystore: newDevice.keystore, oldPubkey: accountCreated.pubkey, timestamp: iso(T0 + 1000) });
  assert.ok(rotated.ok, JSON.stringify(rotated));
  if (!rotated.ok) return;
  const event = rotated.value;
  assert.equal(verifyEvent(event), true);
  assert.equal(event.signer, newDevice.keystore.identity.accountPublicKey);
  assert.ok(validateEvent(event, T0 + 1000).ok);
  const p = event.payload;
  assert.equal(recoveryCommitment(p.recovery_pubkey), accountCreated.recovery_commitment, 'the recovery key matches the commitment recorded at account creation');
  assert.equal(verifyKeyRotation({ old_pubkey: p.old_pubkey, new_pubkey: p.new_pubkey, new_recovery_commitment: p.new_recovery_commitment }, p.sig, p.recovery_pubkey), true);
  assert.equal(p.new_recovery_commitment, newDevice.keystore.identity.recoveryCommitment);

  put(ledger, event, T0 + 1000);
  const verified = verifyChain(ledger.entries, ledger.keyRanges);
  assert.ok(verified.ok, JSON.stringify(verified));
  assert.notEqual(eventHash(event), eventHash(created.value));
  assert.equal(recoveryFlow.confirmRotation(true), 'rotated');
});

test('recovery failure paths: wrong words, wrong commitment, rejected rotation, replayed build and abort all end in refusal', async () => {
  const { words, accountCreated } = await createAccount('rf-old');
  const other = await createAccount('rf-other');
  const wrongWords = flowFor('rf-1');
  const r1 = wrongWords.beginRecovery({ mnemonic: other.words.join(' '), expectedCommitment: accountCreated.recovery_commitment });
  assert.ok(!r1.ok && r1.code === 'E_COMMITMENT_MISMATCH');
  assert.equal(wrongWords.state, 'failed');
  assert.throws(() => wrongWords.beginRecovery({ mnemonic: words.join(' '), expectedCommitment: accountCreated.recovery_commitment }), /E_STATE/);

  const garbage = flowFor('rf-2');
  const r2 = garbage.beginRecovery({ mnemonic: 'not a mnemonic at all', expectedCommitment: accountCreated.recovery_commitment });
  assert.ok(!r2.ok && r2.code === 'E_BAD_MNEMONIC');

  const flow = flowFor('rf-3');
  assert.ok(flow.beginRecovery({ mnemonic: words.join(' '), expectedCommitment: accountCreated.recovery_commitment }).ok);
  const built = await flow.buildRotation({ newKeystore: other.keystore, oldPubkey: accountCreated.pubkey, timestamp: iso(T0) });
  assert.ok(built.ok);
  await assert.rejects(flow.buildRotation({ newKeystore: other.keystore, oldPubkey: accountCreated.pubkey, timestamp: iso(T0) }), /E_STATE/, 'a second build in the same flow is refused');
  assert.equal(flow.confirmRotation(false, 'CHAIN_LINK'), 'failed');
  assert.equal(flow.lastError, 'CHAIN_LINK');

  const aborted = flowFor('rf-4');
  aborted.beginCreation();
  aborted.abort();
  assert.equal(aborted.state, 'failed');
  assert.throws(() => aborted.acknowledgeSeed(), /E_STATE/);
});

test('rotation without a confirmation hook is refused: the recovery key never signs silently', async () => {
  const { words, accountCreated } = await createAccount('nc-old');
  const next = await createAccount('nc-new');
  const silent = new RecoveryFlow({ entropy: deterministicEntropy('nc'), clock: fixedClock(T0), wordlist: testWordlist(), kdf: { N: 1024 } });
  assert.ok(silent.beginRecovery({ mnemonic: words.join(' '), expectedCommitment: accountCreated.recovery_commitment }).ok);
  const result = await silent.buildRotation({ newKeystore: next.keystore, oldPubkey: accountCreated.pubkey, timestamp: iso(T0) });
  assert.ok(!result.ok && result.code === 'E_POLICY_DENIED');
});
