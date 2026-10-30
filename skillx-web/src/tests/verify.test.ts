import test from 'node:test';
import assert from 'node:assert/strict';
import { ChainVerifier } from '../verify.js';
import {
  generateKeyPair,
  signEvent,
  signReceipt,
  signAttestation,
  eventHash,
  receiptHash,
  relayKeyId,
} from '../crypto.js';
import type { CryptoPort } from '../ports.js';
import type { LedgerEntry, SignedCheckpoint } from '../types.js';

const port: CryptoPort = { subtle: globalThis.crypto.subtle };

async function makeChain(count: number) {
  const relay = await generateKeyPair(port);
  const user = await generateKeyPair(port);
  const keyId = await relayKeyId(port, relay.publicKey);
  const verifier = new ChainVerifier(port, relay.publicKey);
  await verifier.init();
  const entries: LedgerEntry[] = [];
  let prevReceiptHash: string | null = null;
  for (let i = 1; i <= count; i++) {
    const event = await signEvent(port, user.privateKeyPkcs8, {
      type: 'FeeBurned',
      version: 1,
      payload: { deal_id: 'd', amount: i },
      signer: user.publicKey,
      timestamp: `2026-01-0${i}T00:00:00.000Z`,
      prevHash: entries[i - 2]?.receipt.eventHash ?? null,
    });
    const eh = await eventHash(port, event);
    const receipt = await signReceipt(port, relay.privateKeyPkcs8, {
      sequence: i,
      eventHash: eh,
      previousReceiptHash: prevReceiptHash,
      acceptedAt: `2026-01-0${i}T00:00:0${i}.000Z`,
      keyId,
    });
    prevReceiptHash = await receiptHash(port, receipt);
    entries.push({ event, receipt });
  }
  return { relay, user, verifier, entries };
}

async function appendGood(ctx: Awaited<ReturnType<typeof makeChain>>, n: number) {
  for (let i = 0; i < n; i++) {
    const entry = ctx.entries[i];
    assert.ok(entry);
    const r = await ctx.verifier.append(entry);
    assert.deepStrictEqual(r, { ok: true });
  }
}

async function expectCode(
  build: (ctx: Awaited<ReturnType<typeof makeChain>>) => Promise<LedgerEntry>,
  code: string,
): Promise<void> {
  const ctx = await makeChain(3);
  await appendGood(ctx, 2);
  const bad = await build(ctx);
  const r = await ctx.verifier.append(bad);
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.error.code, code);
    assert.equal(typeof r.error.message, 'string');
    assert.equal(typeof r.error.path, 'string');
  }
}

test('gültige Kette mit 3 selbst erzeugten Einträgen', async () => {
  const ctx = await makeChain(3);
  await appendGood(ctx, 3);
  assert.equal(ctx.verifier.length, 3);
  assert.ok(!ctx.verifier.isBroken);
});

test('RECEIPT_SEQUENCE: doppelte Sequenz', async () => {
  await expectCode(async (ctx) => {
    const e = ctx.entries[1];
    assert.ok(e);
    return structuredClone(e);
  }, 'RECEIPT_SEQUENCE');
});

test('SIGNATURE: ungültige Event-Signatur', async () => {
  await expectCode(async (ctx) => {
    const e = structuredClone(ctx.entries[2]);
    assert.ok(e);
    e.event.signature = e.receipt.signature;
    return e;
  }, 'SIGNATURE');
});

test('RECEIPT_EVENT_HASH: Hash stimmt nicht', async () => {
  await expectCode(async (ctx) => {
    const e = structuredClone(ctx.entries[2]);
    assert.ok(e);
    e.receipt.eventHash = '0'.repeat(64);
    return e;
  }, 'RECEIPT_EVENT_HASH');
});

test('RECEIPT_LINK: Verkettung gebrochen', async () => {
  await expectCode(async (ctx) => {
    const e = structuredClone(ctx.entries[2]);
    assert.ok(e);
    e.receipt.previousReceiptHash = '1'.repeat(64);
    return e;
  }, 'RECEIPT_LINK');
});

test('RECEIPT_SIGNATURE: Quittung von fremdem Schlüssel', async () => {
  await expectCode(async (ctx) => {
    const e = structuredClone(ctx.entries[2]);
    assert.ok(e);
    const other = await generateKeyPair(port);
    const forged = await signReceipt(port, other.privateKeyPkcs8, {
      sequence: e.receipt.sequence,
      eventHash: e.receipt.eventHash,
      previousReceiptHash: e.receipt.previousReceiptHash,
      acceptedAt: e.receipt.acceptedAt,
      keyId: e.receipt.keyId,
    });
    e.receipt.signature = forged.signature;
    return e;
  }, 'RECEIPT_SIGNATURE');
});

test('KEY_UNKNOWN: receipt.keyId passt nicht zum Relay', async () => {
  await expectCode(async (ctx) => {
    const e = structuredClone(ctx.entries[2]);
    assert.ok(e);
    const other = await generateKeyPair(port);
    e.receipt.keyId = await relayKeyId(port, other.publicKey);
    return e;
  }, 'KEY_UNKNOWN');
});

test('CHAIN_LINK: prevHash ignoriert letztes Event des Signers', async () => {
  const ctx = await makeChain(2);
  await appendGood(ctx, 2);
  const last = ctx.entries[1];
  assert.ok(last);
  const bad = await signEvent(port, ctx.user.privateKeyPkcs8, {
    type: 'FeeBurned',
    version: 1,
    payload: { deal_id: 'd', amount: 99 },
    signer: ctx.user.publicKey,
    timestamp: '2026-01-03T00:00:00.000Z',
    prevHash: null,
  });
  const keyId = await relayKeyId(port, ctx.relay.publicKey);
  const receipt = await signReceipt(port, ctx.relay.privateKeyPkcs8, {
    sequence: 3,
    eventHash: await eventHash(port, bad),
    previousReceiptHash: await receiptHash(port, last.receipt),
    acceptedAt: '2026-01-03T00:00:03.000Z',
    keyId,
  });
  const r = await ctx.verifier.append({ event: bad, receipt });
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.error.code, 'CHAIN_LINK');
  }
});

test('Verifier bleibt nach Fehler broken (gleicher Fehler erneut)', async () => {
  const ctx = await makeChain(2);
  await appendGood(ctx, 2);
  const dup = structuredClone(ctx.entries[1]);
  assert.ok(dup);
  const first = await ctx.verifier.append(dup);
  assert.ok(!first.ok);
  const again = await ctx.verifier.append(dup);
  assert.ok(!again.ok);
  if (!first.ok && !again.ok) {
    assert.deepEqual(again.error, first.error);
  }
  assert.ok(ctx.verifier.isBroken);
});

test('Checkpoint passend und abweichend', async () => {
  const ctx = await makeChain(2);
  await appendGood(ctx, 2);
  const second = ctx.entries[1];
  assert.ok(second);
  const keyId = await relayKeyId(port, ctx.relay.publicKey);
  const base = {
    sequence: 2,
    receipt_hash: await receiptHash(port, second.receipt),
    key_id: keyId,
  };
  const good: SignedCheckpoint = {
    ...base,
    signature: await signAttestation(port, ctx.relay.privateKeyPkcs8, 'checkpoint', base),
  };
  assert.ok((await ctx.verifier.verifyCheckpoint(good)).ok);
  const badBase = { ...base, receipt_hash: 'f'.repeat(64) };
  const bad: SignedCheckpoint = {
    ...badBase,
    signature: await signAttestation(port, ctx.relay.privateKeyPkcs8, 'checkpoint', badBase),
  };
  const r = await ctx.verifier.verifyCheckpoint(bad);
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.error.code, 'DIVERGENCE');
  }
  const other = await generateKeyPair(port);
  const unkBase = { ...base, key_id: await relayKeyId(port, other.publicKey) };
  const unk: SignedCheckpoint = {
    ...unkBase,
    signature: await signAttestation(port, ctx.relay.privateKeyPkcs8, 'checkpoint', unkBase),
  };
  const r2 = await ctx.verifier.verifyCheckpoint(unk);
  assert.ok(!r2.ok);
  if (!r2.ok) {
    assert.equal(r2.error.code, 'KEY_UNKNOWN');
  }
});

test('RelayKeyRotated erweitert Schlüsselbereiche', async () => {
  const ctx = await makeChain(1);
  await appendGood(ctx, 1);
  const first = ctx.entries[0];
  assert.ok(first);
  const newRelay = await generateKeyPair(port);
  const newKeyId = await relayKeyId(port, newRelay.publicKey);
  const rotEvent = await signEvent(port, ctx.relay.privateKeyPkcs8, {
    type: 'RelayKeyRotated',
    version: 1,
    payload: {
      key_id: newKeyId,
      pubkey: newRelay.publicKey,
      valid_from_sequence: 2,
      approvals: [],
    },
    signer: ctx.relay.publicKey,
    timestamp: '2026-01-02T00:00:00.000Z',
    prevHash: null,
  });
  const rotReceipt = await signReceipt(port, ctx.relay.privateKeyPkcs8, {
    sequence: 2,
    eventHash: await eventHash(port, rotEvent),
    previousReceiptHash: await receiptHash(port, first.receipt),
    acceptedAt: '2026-01-02T00:00:02.000Z',
    keyId: first.receipt.keyId,
  });
  const r = await ctx.verifier.append({ event: rotEvent, receipt: rotReceipt });
  assert.ok(r.ok);
  assert.equal(ctx.verifier.keyRanges.length, 2);
  assert.equal(ctx.verifier.keyRanges[0]?.validTo, 2);
  assert.equal(ctx.verifier.keyRanges[1]?.validFrom, 2);

  const ev = await signEvent(port, ctx.user.privateKeyPkcs8, {
    type: 'FeeBurned',
    version: 1,
    payload: { deal_id: 'd', amount: 7 },
    signer: ctx.user.publicKey,
    timestamp: '2026-01-03T00:00:00.000Z',
    prevHash: first.receipt.eventHash,
  });
  const rc = await signReceipt(port, newRelay.privateKeyPkcs8, {
    sequence: 3,
    eventHash: await eventHash(port, ev),
    previousReceiptHash: await receiptHash(port, rotReceipt),
    acceptedAt: '2026-01-03T00:00:03.000Z',
    keyId: newKeyId,
  });
  const r3 = await ctx.verifier.append({ event: ev, receipt: rc });
  assert.ok(r3.ok);
});

test('RelayKeyRotated mit unpassendem key_id -> KEY_UNKNOWN', async () => {
  const ctx = await makeChain(1);
  await appendGood(ctx, 1);
  const first = ctx.entries[0];
  assert.ok(first);
  const newRelay = await generateKeyPair(port);
  const rotEvent = await signEvent(port, ctx.relay.privateKeyPkcs8, {
    type: 'RelayKeyRotated',
    version: 1,
    payload: {
      key_id: '0'.repeat(64),
      pubkey: newRelay.publicKey,
      valid_from_sequence: 2,
      approvals: [],
    },
    signer: ctx.relay.publicKey,
    timestamp: '2026-01-02T00:00:00.000Z',
    prevHash: null,
  });
  const rotReceipt = await signReceipt(port, ctx.relay.privateKeyPkcs8, {
    sequence: 2,
    eventHash: await eventHash(port, rotEvent),
    previousReceiptHash: await receiptHash(port, first.receipt),
    acceptedAt: '2026-01-02T00:00:02.000Z',
    keyId: first.receipt.keyId,
  });
  const r = await ctx.verifier.append({ event: rotEvent, receipt: rotReceipt });
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.error.code, 'KEY_UNKNOWN');
  }
});

test('Zeitrücklauf des acceptedAt -> RECEIPT_SEQUENCE', async () => {
  const ctx = await makeChain(2);
  await appendGood(ctx, 1);
  const second = ctx.entries[1];
  assert.ok(second);
  const resigned = await signReceipt(port, ctx.relay.privateKeyPkcs8, {
    sequence: second.receipt.sequence,
    eventHash: second.receipt.eventHash,
    previousReceiptHash: second.receipt.previousReceiptHash,
    acceptedAt: '2000-01-01T00:00:00.000Z',
    keyId: second.receipt.keyId,
  });
  const r = await ctx.verifier.append({ event: second.event, receipt: resigned });
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.error.code, 'RECEIPT_SEQUENCE');
  }
});
