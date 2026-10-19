import { test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok } from '../../domain/src/protocol.js';
import type { Receipt, SignedEvent } from '../../domain/src/protocol.js';
import { eventHash, receiptHash, relayKeyId, signCheckpoint, signReceipt } from '../../crypto/src/index.js';
import { DAY, T0, TestLedger, eventOf, h, iso, newCast, newIdentity, validPayload } from '../../testing/src/fixtures.js';
import type { Identity } from '../../testing/src/fixtures.js';
import { detectEquivocation, verifyChain } from './index.js';
import type { LedgerEntry, RelayKeyRange } from './index.js';

const cast = newCast();
const MIN = 60000;

/** A valid 5-entry chain over two signers with strictly increasing receipt times. */
function sampleLedger(): TestLedger {
  const ledger = new TestLedger();
  const a = cast.buyer; const b = cast.seller;
  ledger.append('AccountCreated', validPayload('AccountCreated', cast, a, T0) as never, a, T0);
  ledger.append('AccountCreated', validPayload('AccountCreated', cast, b, T0) as never, b, T0 + MIN);
  ledger.append('AccountInvited', validPayload('AccountInvited', cast, a, T0) as never, a, T0 + 2 * MIN);
  ledger.append('AccountInvited', validPayload('AccountInvited', cast, b, T0) as never, b, T0 + 3 * MIN);
  ledger.append('AccountInvited', validPayload('AccountInvited', cast, a, T0) as never, a, T0 + 4 * MIN);
  return ledger;
}
function code(result: ReturnType<typeof verifyChain>): string { return result.ok ? 'OK' : result.error.code; }
/** Re-sign receipt links after a structural edit so the edit itself is what gets judged. */
function push(ledger: TestLedger, event: SignedEvent, acceptedAtMs: number): void {
  ledger.entries.push({ event, receipt: ledger.receiptFor(event, acceptedAtMs) });
}

test('E1: per-signer chains verify despite interleaving; tips are returned; account checks reported as skipped', () => {
  const ledger = sampleLedger();
  const result = verifyChain(ledger.entries, ledger.keyRanges);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.tipSequence, 5);
  assert.equal(result.value.accountChecks, 'skipped');
  assert.equal(result.value.signerTips.size, 2);
  const last = ledger.entries[4]; assert.ok(last);
  assert.equal(result.value.signerTips.get(cast.buyer.publicKey), eventHash(last.event));
  assert.equal(result.value.tipReceiptHash, receiptHash(last.receipt));
  assert.equal(verifyChain([], ledger.keyRanges).ok, true);
});

test('B5: a SignerResolver is consulted per entry, marks accountChecks applied and its error is returned', () => {
  const ledger = sampleLedger();
  const seen: Array<[string, number]> = [];
  const applied = verifyChain(ledger.entries, ledger.keyRanges, { resolve: (pubkey, sequence) => { seen.push([pubkey, sequence]); return ok(true); } });
  assert.equal(applied.ok && applied.value.accountChecks, 'applied');
  assert.equal(seen.length, 5);
  assert.deepEqual(seen[2], [cast.buyer.publicKey, 3]);
  const rejected = verifyChain(ledger.entries, ledger.keyRanges, { resolve: (_p, sequence) => (sequence === 4 ? err('SIGNER_AUTHORITY', 'unknown account', 'signer') : ok(true)) });
  assert.equal(code(rejected), 'SIGNER_AUTHORITY');
});

test('E1: stale or unknown signer tip is CHAIN_LINK', () => {
  const ledger = new TestLedger();
  ledger.append('AccountCreated', validPayload('AccountCreated', cast, cast.buyer, T0) as never, cast.buyer, T0);
  const stale = eventOf('AccountInvited', validPayload('AccountInvited', cast, cast.buyer, T0) as never, cast.buyer, T0 + MIN, h('unknown-tip'));
  push(ledger, stale, T0 + MIN);
  const result = verifyChain(ledger.entries, ledger.keyRanges);
  assert.equal(code(result), 'CHAIN_LINK');
  // first event with a non-null prevHash
  const single = new TestLedger();
  push(single, eventOf('AccountCreated', validPayload('AccountCreated', cast, cast.buyer, T0) as never, cast.buyer, T0, h('x')), T0);
  assert.equal(code(verifyChain(single.entries, single.keyRanges)), 'CHAIN_LINK');
  // another signer's event hash is not this signer's tip
  const cross = new TestLedger();
  const first = cross.append('AccountCreated', validPayload('AccountCreated', cast, cast.buyer, T0) as never, cast.buyer, T0);
  push(cross, eventOf('AccountCreated', validPayload('AccountCreated', cast, cast.seller, T0) as never, cast.seller, T0, eventHash(first.event)), T0 + MIN);
  assert.equal(code(verifyChain(cross.entries, cross.keyRanges)), 'CHAIN_LINK');
});

test('E1: two entries extending the same signer tip are a FORK', () => {
  const ledger = new TestLedger();
  const first = ledger.append('AccountCreated', validPayload('AccountCreated', cast, cast.buyer, T0) as never, cast.buyer, T0);
  ledger.append('AccountInvited', validPayload('AccountInvited', cast, cast.buyer, T0) as never, cast.buyer, T0 + MIN);
  const competing = eventOf('AccountInvited', { invitee: cast.extra[3]?.publicKey ?? '', expires: iso(T0 + DAY) }, cast.buyer, T0 + 2 * MIN, eventHash(first.event));
  push(ledger, competing, T0 + 2 * MIN);
  assert.equal(code(verifyChain(ledger.entries, ledger.keyRanges)), 'FORK');
  // a second null-prevHash entry for the same signer is also a fork
  const second = new TestLedger();
  second.append('AccountCreated', validPayload('AccountCreated', cast, cast.buyer, T0) as never, cast.buyer, T0);
  push(second, eventOf('AccountInvited', validPayload('AccountInvited', cast, cast.buyer, T0) as never, cast.buyer, T0 + MIN, null), T0 + MIN);
  assert.equal(code(verifyChain(second.entries, second.keyRanges)), 'FORK');
});

test('A10/E2: acceptedAt must be non-decreasing; event skew is judged against the receipt', () => {
  const ledger = new TestLedger();
  ledger.append('AccountCreated', validPayload('AccountCreated', cast, cast.buyer, T0) as never, cast.buyer, T0 + 10 * MIN);
  const early = eventOf('AccountCreated', validPayload('AccountCreated', cast, cast.seller, T0) as never, cast.seller, T0 + 9 * MIN);
  push(ledger, early, T0 + 9 * MIN);
  const result = verifyChain(ledger.entries, ledger.keyRanges);
  assert.equal(code(result), 'TIMESTAMP');
  if (!result.ok) assert.match(result.error.path, /receipt\.acceptedAt/);
  const equalTimes = new TestLedger();
  equalTimes.append('AccountCreated', validPayload('AccountCreated', cast, cast.buyer, T0) as never, cast.buyer, T0);
  equalTimes.append('AccountCreated', validPayload('AccountCreated', cast, cast.seller, T0) as never, cast.seller, T0);
  assert.equal(verifyChain(equalTimes.entries, equalTimes.keyRanges).ok, true);
  const skewed = new TestLedger();
  push(skewed, eventOf('AccountCreated', validPayload('AccountCreated', cast, cast.buyer, T0) as never, cast.buyer, T0), T0 + 6 * MIN);
  const skewResult = verifyChain(skewed.entries, skewed.keyRanges);
  assert.equal(code(skewResult), 'TIMESTAMP');
  if (!skewResult.ok) assert.match(skewResult.error.path, /event\.timestamp/);
});

test('A9: a chain whose events are years old verifies — no wall clock is involved', () => {
  const old = Date.parse('2019-03-01T00:00:00.000Z');
  const ledger = new TestLedger();
  ledger.append('AccountCreated', validPayload('AccountCreated', cast, cast.buyer, old) as never, cast.buyer, old);
  assert.equal(verifyChain(ledger.entries, ledger.keyRanges).ok, true);
});

test('E3: receipt sequence, event binding, links and key id are checked with receipt-specific codes', () => {
  const sequence = (e: LedgerEntry[]) => e.map((x) => ({ ...x }));
  const ledger = sampleLedger();
  const gap = sequence(ledger.entries); gap.splice(2, 1);
  assert.equal(code(verifyChain(gap, ledger.keyRanges)), 'RECEIPT_SEQUENCE');
  const wrongHash = sequence(ledger.entries); wrongHash[1] = { event: wrongHash[1]!.event, receipt: { ...wrongHash[1]!.receipt, eventHash: h('other') } };
  assert.equal(code(verifyChain(wrongHash, ledger.keyRanges)), 'RECEIPT_EVENT_HASH');
  const wrongLink = sequence(ledger.entries); wrongLink[2] = { event: wrongLink[2]!.event, receipt: { ...wrongLink[2]!.receipt, previousReceiptHash: h('other') } };
  assert.equal(code(verifyChain(wrongLink, ledger.keyRanges)), 'RECEIPT_LINK');
  const firstLink = sequence(ledger.entries); firstLink[0] = { event: firstLink[0]!.event, receipt: { ...firstLink[0]!.receipt, previousReceiptHash: h('x') } };
  assert.equal(code(verifyChain(firstLink, ledger.keyRanges)), 'RECEIPT_LINK');
  const wrongKeyId = sequence(ledger.entries); wrongKeyId[0] = { event: wrongKeyId[0]!.event, receipt: { ...wrongKeyId[0]!.receipt, keyId: h('unknown-key') } };
  assert.equal(code(verifyChain(wrongKeyId, ledger.keyRanges)), 'KEY_UNKNOWN');
  assert.equal(code(verifyChain(ledger.entries, [])), 'KEY_UNKNOWN');
  const impostor = newIdentity();
  const forged = sequence(ledger.entries);
  const first = forged[0]!;
  forged[0] = { event: first.event, receipt: signReceipt({ sequence: 1, eventHash: first.receipt.eventHash, previousReceiptHash: null, acceptedAt: first.receipt.acceptedAt, keyId: first.receipt.keyId }, impostor.privateKey) };
  assert.equal(code(verifyChain(forged, ledger.keyRanges)), 'RECEIPT_SIGNATURE');
  const legacy = sequence(ledger.entries); const { keyId: _drop, ...noKey } = legacy[0]!.receipt;
  legacy[0] = { event: legacy[0]!.event, receipt: noKey as unknown as Receipt };
  assert.equal(code(verifyChain(legacy, ledger.keyRanges)), 'KEY_UNKNOWN');
});

test('E14: relay key ranges are half-open, rotated keys sign only their range, malformed or overlapping ranges are rejected', () => {
  const relay2 = newIdentity();
  const ledger = new TestLedger();
  const ranges: RelayKeyRange[] = [
    { keyId: relayKeyId(ledger.relay.publicKey), pubkey: ledger.relay.publicKey, validFromSequence: 1, validToSequence: 3 },
    { keyId: relayKeyId(relay2.publicKey), pubkey: relay2.publicKey, validFromSequence: 3, validToSequence: null },
  ];
  const signers: Identity[] = [cast.buyer, cast.seller, cast.outsider, cast.checker];
  const relayFor = (sequence: number): Identity => (sequence < 3 ? ledger.relay : relay2);
  signers.forEach((signer, i) => {
    const event = eventOf('AccountCreated', validPayload('AccountCreated', cast, signer, T0) as never, signer, T0 + i * MIN);
    ledger.entries.push({ event, receipt: ledger.receiptFor(event, T0 + i * MIN, relayFor(ledger.entries.length + 1)) });
  });
  assert.equal(verifyChain(ledger.entries, ranges).ok, true);
  // the old key signing at sequence 3 is outside its range
  const late = ledger.entries.map((e) => ({ ...e }));
  const third = late[2]!;
  late[2] = { event: third.event, receipt: signReceipt({ sequence: 3, eventHash: third.receipt.eventHash, previousReceiptHash: third.receipt.previousReceiptHash, acceptedAt: third.receipt.acceptedAt, keyId: relayKeyId(ledger.relay.publicKey) }, ledger.relay.privateKey) };
  assert.equal(code(verifyChain(late, ranges)), 'KEY_UNKNOWN');
  const overlap: RelayKeyRange[] = [{ ...ranges[0]!, validToSequence: 4 }, ranges[1]!];
  assert.equal(code(verifyChain(ledger.entries, overlap)), 'KEY_UNKNOWN');
  const openFirst: RelayKeyRange[] = [{ ...ranges[0]!, validToSequence: null }, ranges[1]!];
  assert.equal(code(verifyChain(ledger.entries, openFirst)), 'KEY_UNKNOWN');
  assert.equal(code(verifyChain(ledger.entries, [{ ...ranges[0]!, validToSequence: 1 }, ranges[1]!])), 'KEY_UNKNOWN');
  assert.equal(code(verifyChain(ledger.entries, [{ ...ranges[0]!, validFromSequence: 0 }, ranges[1]!])), 'KEY_UNKNOWN');
  assert.equal(code(verifyChain(ledger.entries, [{ ...ranges[0]!, keyId: h('bad') }, ranges[1]!])), 'KEY_UNKNOWN');
});

test('A10 mutation: delete, duplicate, reorder and tamper each yield the specific stable code', () => {
  const base = sampleLedger();
  const keys = base.keyRanges;
  const copy = (): LedgerEntry[] => base.entries.map((e) => ({ event: e.event, receipt: { ...e.receipt } }));
  for (let i = 0; i < 4; i += 1) {
    const deleted = copy(); deleted.splice(i, 1);
    assert.equal(code(verifyChain(deleted, keys)), 'RECEIPT_SEQUENCE', `delete ${i}`);
  }
  for (let i = 0; i < 5; i += 1) {
    const duplicated = copy(); duplicated.splice(i, 0, duplicated[i]!);
    assert.equal(code(verifyChain(duplicated, keys)), 'RECEIPT_SEQUENCE', `duplicate ${i}`);
  }
  for (let i = 0; i < 4; i += 1) {
    const swapped = copy(); [swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
    assert.equal(code(verifyChain(swapped, keys)), 'RECEIPT_SEQUENCE', `swap ${i}`);
  }
  for (let i = 0; i < 5; i += 1) {
    const tamperedPayload = copy(); const target = tamperedPayload[i]!;
    tamperedPayload[i] = { event: { ...target.event, payload: { ...target.event.payload, tampered: true } } as unknown as SignedEvent, receipt: target.receipt };
    assert.equal(code(verifyChain(tamperedPayload, keys)), 'UNKNOWN_FIELD', `payload ${i}`);
    const tamperedSig = copy();
    tamperedSig[i] = { event: { ...target.event, signature: `${target.event.signature.slice(0, 10)}${target.event.signature[10] === 'A' ? 'B' : 'A'}${target.event.signature.slice(11)}` }, receipt: target.receipt };
    assert.equal(code(verifyChain(tamperedSig, keys)), 'SIGNATURE', `event signature ${i}`);
    const tamperedTime = copy(); tamperedTime[i] = { event: target.event, receipt: { ...target.receipt, acceptedAt: iso(Date.parse(target.receipt.acceptedAt) + 1) } };
    assert.equal(code(verifyChain(tamperedTime, keys)), 'RECEIPT_SIGNATURE', `acceptedAt ${i}`);
    const tamperedReceiptSig = copy();
    tamperedReceiptSig[i] = { event: target.event, receipt: { ...target.receipt, signature: `${target.receipt.signature.slice(0, 10)}${target.receipt.signature[10] === 'A' ? 'B' : 'A'}${target.receipt.signature.slice(11)}` } };
    assert.equal(code(verifyChain(tamperedReceiptSig, keys)), 'RECEIPT_SIGNATURE', `receipt signature ${i}`);
    const tamperedSequence = copy(); tamperedSequence[i] = { event: target.event, receipt: { ...target.receipt, sequence: target.receipt.sequence + 1 } };
    assert.equal(code(verifyChain(tamperedSequence, keys)), 'RECEIPT_SEQUENCE', `sequence ${i}`);
  }
  assert.equal(code(verifyChain([{ event: undefined } as unknown as LedgerEntry], keys)), 'ENVELOPE');
});

test('E14: two validly signed checkpoints for one sequence with different receipt hashes prove equivocation', () => {
  const ledger = new TestLedger();
  const keys = ledger.keyRanges;
  const keyId = relayKeyId(ledger.relay.publicKey);
  const checkpoint = (sequence: number, receiptHashHex: string, signer: Identity = ledger.relay) => {
    const body = { sequence, receipt_hash: receiptHashHex, key_id: keyId };
    return { ...body, signature: signCheckpoint(body, signer.privateKey) };
  };
  const a = checkpoint(7, h('root-a')); const b = checkpoint(7, h('root-b'));
  const proof = detectEquivocation(a, b, keys);
  assert.deepEqual(proof, ok({ first: a, second: b }));
  assert.deepEqual(detectEquivocation(a, checkpoint(7, h('root-a')), keys), ok(null));
  assert.deepEqual(detectEquivocation(a, checkpoint(8, h('root-b')), keys), ok(null));
  const forged = checkpoint(7, h('root-b'), newIdentity());
  const bad = detectEquivocation(a, forged, keys);
  assert.equal(!bad.ok && bad.error.code, 'ATTESTATION');
  const unknownKey = detectEquivocation(a, { ...b, key_id: h('nokey') }, keys);
  assert.equal(!unknownKey.ok && unknownKey.error.code, 'KEY_UNKNOWN');
  const noKeys = detectEquivocation(a, b, []);
  assert.equal(!noKeys.ok && noKeys.error.code, 'KEY_UNKNOWN');
  const malformed = detectEquivocation({ ...a, receipt_hash: 'zz' }, b, keys);
  assert.equal(!malformed.ok && malformed.error.code, 'ATTESTATION');
});
