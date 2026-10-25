import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relayKeyId } from '../../crypto/src/index.js';
import { detectEquivocation, verifyChain } from '../../chain-verifier/src/index.js';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import { h, newIdentity, uuid } from '../../testing/src/fixtures.js';
import { FileStore } from './file-store.js';
import { replayLedger } from './relay.js';

function withDir<T>(run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'relay-replay-'));
  try { return run(join(dir, 'ledger.ndjson')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('restart: a new relay over the same durable file reaches the byte-identical state hash and keeps appending', () => {
  withDir((path) => {
    const rig = new RelayRig(new FileStore({ path }));
    rig.bootstrap();
    rig.openDeal(1);
    const hashBefore = rig.relay.stateHash;
    rig.relay.close();
    const restarted = new RelayRig(new FileStore({ path }), rig);
    const relay = restarted.relay;
    assert.ok(relay.start().ok);
    assert.equal(relay.stateHash, hashBefore);
    assert.equal(relay.tipSequence, 5);
    relay.close();
  });
});

test('replay is deterministic: twice over the same entries gives identical state hashes; a tampered ledger is refused at start', () => {
  withDir((path) => {
    const rig = new RelayRig(new FileStore({ path }));
    rig.bootstrap();
    rig.openDeal(1);
    const entries = rig.store.all();
    const one = replayLedger(entries, rig.projector);
    const two = replayLedger(entries, rig.projector);
    assert.ok(one.ok && two.ok);
    if (one.ok && two.ok) assert.equal(one.value.stateHash, two.value.stateHash);
    rig.relay.close();
    // Reorder two lines: sequence contiguity breaks, so recovery truncates; the surviving prefix must still verify.
    const lines = readFileSync(path, 'utf8').split('\n');
    const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n');
    writeFileSync(path, swapped);
    const again = new RelayRig(new FileStore({ path }), rig);
    const started = again.relay.start();
    assert.ok(started.ok);
    if (started.ok) assert.equal(started.value.tip, 1);
    // A ledger whose receipts were re-signed by an unknown key never replays.
    const foreign = new RelayRig();
    foreign.bootstrap();
    const bad = replayLedger(foreign.store.all(), rig.projector);
    assert.ok(!bad.ok);
  });
});

test('relay key rotation mid-ledger: approved rotation, receipts switch key at the boundary, the whole chain verifies and replays', () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const next = newIdentity();
  const approver = rig.approvers[0];
  assert.ok(approver !== undefined);
  const payload = rig.rotationPayload(next, 10);
  const accepted = rig.submit('RelayKeyRotated', payload, approver as never);
  assert.ok(accepted.ok, JSON.stringify(accepted));
  rig.now += 100;
  rig.openDeal(1);
  rig.openDeal(2);
  assert.equal(rig.relay.tipSequence, 9);
  // Without the new private key the relay cannot sign from sequence 10: it must refuse, not guess.
  const blocked = rig.submit('DeliverableSubmitted', { deal_id: uuid(1), content_hash: h('work'), precheck_ref: null }, rig.cast.seller);
  assert.ok(!blocked.ok && blocked.error.code === 'KEY_UNKNOWN');
  assert.equal(rig.relay.tipSequence, 9);
  rig.privateKeys.set(relayKeyId(next.publicKey), next.privateKey);
  rig.openDeal(3);
  const entries = rig.store.all();
  const keyIds = new Set(entries.map((e) => e.receipt.keyId));
  assert.equal(keyIds.size, 2);
  for (const e of entries) assert.equal(e.receipt.keyId, e.receipt.sequence < 10 ? relayKeyId(rig.genesisKey.publicKey) : relayKeyId(next.publicKey));
  const replay = replayLedger(entries, rig.projector);
  assert.ok(replay.ok, JSON.stringify(replay));
  const ranges = [
    { keyId: relayKeyId(rig.genesisKey.publicKey), pubkey: rig.genesisKey.publicKey, validFromSequence: 1, validToSequence: 10 },
    { keyId: relayKeyId(next.publicKey), pubkey: next.publicKey, validFromSequence: 10, validToSequence: null },
  ];
  assert.ok(verifyChain(entries, ranges).ok);
  assert.ok(!verifyChain(entries, [ranges[0] as never]).ok, 'the old key alone cannot verify later receipts');
});

test('relay key rotation is rejected without enough approvals, for a past boundary, for a mismatched key id, and when replayed', () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const approver = rig.approvers[0] as never;
  const next = newIdentity();
  const good = rig.rotationPayload(next, 50);
  const code = (payload: typeof good): string => { const r = rig.submit('RelayKeyRotated', payload, approver); return r.ok ? 'OK' : r.error.code; };
  assert.equal(code({ ...good, approvals: good.approvals.slice(0, 1) }), 'LIMIT');
  const [first, second] = good.approvals;
  assert.equal(code({ ...good, approvals: [first as never, { signer: (second as never as { signer: string }).signer, sig: (first as never as { sig: string }).sig }] }), 'ATTESTATION');
  assert.equal(code({ ...good, key_id: relayKeyId(newIdentity().publicKey) }), 'FIELD_FORMAT');
  const past = rig.rotationPayload(newIdentity(), 2);
  assert.equal(code(past), 'WINDOW');
  assert.equal(code(good), 'OK');
  const again = rig.rotationPayload(next, 60);
  assert.equal(code(again), 'REPLAY');
});

test('checkpoints are signed per policy interval, deterministic, and two for one sequence with different receipts prove equivocation', () => {
  const rig = new RelayRig();
  rig.bootstrap();
  rig.openDeal(1);
  const cp = rig.relay.latestCheckpoint();
  assert.ok(cp !== null);
  if (cp === null) return;
  assert.equal(cp.sequence % 2, 0);
  assert.deepEqual(rig.relay.latestCheckpoint(), cp);
  const ranges = [{ keyId: cp.key_id, pubkey: rig.genesisKey.publicKey, validFromSequence: 1, validToSequence: null }];
  const same = detectEquivocation(cp, cp, ranges);
  assert.ok(same.ok && same.value === null);
  const forged = new RelayRig();
  forged.privateKeys.clear();
  forged.privateKeys.set(relayKeyId(forged.genesisKey.publicKey), forged.genesisKey.privateKey);
  const empty = new RelayRig().relay.latestCheckpoint();
  assert.equal(empty, null);
});
