import test from 'node:test';
import assert from 'node:assert/strict';

import { consentDeal, castVote } from '../actions.js';
import { RelayClient } from '../relay-client.js';
import {
  generateKeyPair,
  importNonExtractablePrivate,
  verifyEvent,
  verifyAttestation,
  eventHash,
  signReceipt,
  relayKeyId,
} from '../crypto.js';

import type { ActionContext } from '../actions.js';
import type { ChainVerifier } from '../verify.js';
import type { CryptoPort, FetchPort } from '../ports.js';
import type {
  LedgerEntry,
  SignedEvent,
  Pubkey,
  Hash,
  EventType,
  ErrorCode,
} from '../types.js';

type ActionResult = Awaited<ReturnType<typeof consentDeal>>;

interface KeyPair {
  publicKey: Pubkey;
  privateKeyPkcs8: string;
}

interface Setup {
  relayKp: KeyPair;
  ownKp: KeyPair;
  otherKp: KeyPair;
  foreignKp: KeyPair;
  signingKey: CryptoKey;
}

const port: CryptoPort = { subtle: globalThis.crypto.subtle };

const setupPromise: Promise<Setup> = (async () => {
  const relayKp = await generateKeyPair(port);
  const ownKp = await generateKeyPair(port);
  const otherKp = await generateKeyPair(port);
  const foreignKp = await generateKeyPair(port);
  const signingKey = await importNonExtractablePrivate(port, ownKp.privateKeyPkcs8);
  return { relayKp, ownKp, otherKp, foreignKp, signingKey };
})();

interface FakeRelayOptions {
  tip?: Hash | null;
  throwOnTip?: boolean;
  wrongEventHash?: boolean;
  foreignKey?: KeyPair;
  postStatus?: number;
  postBody?: unknown;
}

class FakeRelay {
  postCount = 0;
  lastPosted: SignedEvent | null = null;
  readonly fetch: FetchPort;
  private readonly opts: FakeRelayOptions;

  constructor(
    private readonly port: CryptoPort,
    private readonly ownPubkey: Pubkey,
    private readonly relayPrivateKeyPkcs8: string,
    private readonly relayPublicKey: Pubkey,
    opts: FakeRelayOptions = {},
  ) {
    this.opts = opts;
    this.fetch = async (url, init) => {
      if (url === `https://relay.test/v1/signers/${encodeURIComponent(this.ownPubkey)}/tip`) {
        if (this.opts.throwOnTip) {
          throw new Error('offline');
        }
        return {
          status: 200,
          json: async () => ({ signer: this.ownPubkey, tip: this.opts.tip ?? null }),
        };
      }

      if (url === 'https://relay.test/v1/events') {
        this.postCount += 1;

        const status = this.opts.postStatus;
        if (status !== undefined && status >= 400) {
          const body = this.opts.postBody ?? {
            code: 'RATE_LIMITED',
            message: 'slow',
            path: '$.rate',
          };
          return { status, json: async () => body };
        }

        const body = init?.body;
        if (body === undefined) {
          throw new Error('missing body');
        }

        const posted = JSON.parse(body) as unknown as SignedEvent;
        this.lastPosted = posted;

        const eventHashValue = this.opts.wrongEventHash
          ? '0'.repeat(64)
          : await eventHash(this.port, posted);

        const foreignKey = this.opts.foreignKey;
        const pkcs8 = foreignKey ? foreignKey.privateKeyPkcs8 : this.relayPrivateKeyPkcs8;
        const publicKey = foreignKey ? foreignKey.publicKey : this.relayPublicKey;

        const receipt = await signReceipt(this.port, pkcs8, {
          sequence: 1,
          eventHash: eventHashValue,
          previousReceiptHash: null,
          acceptedAt: '2026-01-01T00:00:00.000Z',
          keyId: await relayKeyId(this.port, publicKey),
        });

        return { status: 201, json: async () => ({ receipt, duplicate: false }) };
      }

      throw new Error(`unexpected url: ${url}`);
    };
  }
}

function makeRelay(s: Setup, opts: FakeRelayOptions = {}): FakeRelay {
  return new FakeRelay(
    port,
    s.ownKp.publicKey,
    s.relayKp.privateKeyPkcs8,
    s.relayKp.publicKey,
    opts,
  );
}

interface CtxOptions {
  entries: readonly LedgerEntry[];
  ownPubkey: Pubkey;
  signingKey: CryptoKey | null;
  relayPubkey: Pubkey;
  relay: FakeRelay;
  readOnly?: boolean;
  transportError?: boolean;
  isBroken?: boolean;
}

function makeCtx(o: CtxOptions): ActionContext {
  const verifier = {
    get isBroken() {
      return o.isBroken ?? false;
    },
    getEntries: () => o.entries,
  } as unknown as ChainVerifier;

  const client = new RelayClient('https://relay.test', o.relay.fetch);

  return {
    crypto: port,
    clock: {
      nowMs: () => 0,
      nowIso: () => '2026-01-01T00:00:00.000Z',
    },
    client,
    verifier,
    relayPubkey: o.relayPubkey,
    ownPubkey: o.ownPubkey,
    signingKey: o.signingKey,
    readOnly: o.readOnly ?? false,
    transportError: o.transportError ?? false,
  };
}

function makeEntry(
  signer: Pubkey,
  seq: number,
  type: EventType,
  payload: Record<string, unknown>,
): LedgerEntry {
  return {
    event: {
      type,
      version: 1,
      payload,
      signer,
      timestamp: '2026-01-01T00:00:00.000Z',
      prevHash: null,
      signature: 'x',
    },
    receipt: {
      sequence: seq,
      eventHash: '0'.repeat(64),
      previousReceiptHash: null,
      acceptedAt: '2026-01-01T00:00:00.000Z',
      keyId: '0'.repeat(64),
      signature: 'x',
    },
  };
}

function dealCreatedPayload(seller: Pubkey, buyer: Pubkey): Record<string, unknown> {
  return {
    deal_id: 'deal-1',
    buyer,
    seller,
    amount: 100,
    criteria_hash: '1'.repeat(64),
    deadline: '2026-02-01T00:00:00.000Z',
  };
}

function baseEntries(s: Setup): LedgerEntry[] {
  return [
    makeEntry(
      s.ownKp.publicKey,
      1,
      'DealCreated',
      dealCreatedPayload(s.ownKp.publicKey, s.otherKp.publicKey),
    ),
  ];
}

function juryAssignedEntry(
  s: Setup,
  seq: number,
  round: number,
  jurors: readonly Pubkey[],
): LedgerEntry {
  return makeEntry(s.ownKp.publicKey, seq, 'JuryAssigned', {
    deal_id: 'deal-1',
    appeal_round: round,
    jurors: [...jurors],
  });
}

function expectError(r: ActionResult, code: ErrorCode): void {
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.code, code);
}

test('consentDeal: deal not found -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const ctx = makeCtx({
    entries: [],
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await consentDeal(ctx, 'deal-x');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('consentDeal: own pubkey is not seller -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const entries = [
    makeEntry(
      s.ownKp.publicKey,
      1,
      'DealCreated',
      dealCreatedPayload(s.otherKp.publicKey, s.ownKp.publicKey),
    ),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await consentDeal(ctx, 'deal-1');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('consentDeal: deal is not in state angelegt -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const entries = [
    ...baseEntries(s),
    makeEntry(s.ownKp.publicKey, 2, 'DealConsented', { deal_id: 'deal-1' }),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await consentDeal(ctx, 'deal-1');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('consentDeal: missing signingKey -> SIGNING', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: null,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await consentDeal(ctx, 'deal-1');
  expectError(r, 'SIGNING');
  assert.equal(relay.postCount, 0);
});

test('consentDeal: readOnly -> READ_ONLY', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
    readOnly: true,
  });

  const r = await consentDeal(ctx, 'deal-1');
  expectError(r, 'READ_ONLY');
  assert.equal(relay.postCount, 0);
});

test('consentDeal: transportError -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
    transportError: true,
  });

  const r = await consentDeal(ctx, 'deal-1');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('consentDeal: broken verifier -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
    isBroken: true,
  });

  const r = await consentDeal(ctx, 'deal-1');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('consentDeal: success with null tip', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, { tip: null });
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await consentDeal(ctx, 'deal-1');
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const ev = r.value;
  assert.equal(ev.type, 'DealConsented');
  assert.equal(ev.version, 1);
  assert.equal(ev.signer, s.ownKp.publicKey);
  assert.equal(ev.timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(ev.prevHash, null);
  assert.deepEqual(Object.keys(ev.payload).sort(), ['consent_sig', 'deal_id', 'seller']);
  assert.equal(ev.payload['deal_id'], 'deal-1');
  assert.equal(ev.payload['seller'], s.ownKp.publicKey);

  const sig = ev.payload['consent_sig'];
  assert.equal(typeof sig, 'string');
  if (typeof sig !== 'string') return;

  const body = {
    deal_id: 'deal-1',
    buyer: s.otherKp.publicKey,
    seller: s.ownKp.publicKey,
    amount: 100,
    criteria_hash: '1'.repeat(64),
    deadline: '2026-02-01T00:00:00.000Z',
  };
  assert.equal(
    await verifyAttestation(port, s.ownKp.publicKey, 'deal-consent', body, sig),
    true,
  );
  assert.equal(await verifyEvent(port, ev), true);
  assert.equal(relay.postCount, 1);

  assert.ok(relay.lastPosted);
  if (!relay.lastPosted) return;
  assert.deepEqual(relay.lastPosted, ev);
});

test('consentDeal: success uses relay tip as prevHash', async () => {
  const s = await setupPromise;
  const tip = '2'.repeat(64);
  const relay = makeRelay(s, { tip });
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await consentDeal(ctx, 'deal-1');
  assert.equal(r.ok, true);
  if (!r.ok) return;

  assert.equal(r.value.type, 'DealConsented');
  assert.equal(r.value.prevHash, tip);
});

test('consentDeal: receipt with wrong eventHash -> DIVERGENCE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, { wrongEventHash: true });
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await consentDeal(ctx, 'deal-1');
  expectError(r, 'DIVERGENCE');
  assert.equal(relay.postCount, 1);
});

test('consentDeal: receipt signed by foreign relay key -> DIVERGENCE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, { foreignKey: s.foreignKp });
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await consentDeal(ctx, 'deal-1');
  expectError(r, 'DIVERGENCE');
  assert.equal(relay.postCount, 1);
});

test('consentDeal: relay 429 -> RATE_LIMITED passthrough', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, {
    postStatus: 429,
    postBody: { code: 'RATE_LIMITED', message: 'slow', path: '$.rate' },
  });
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await consentDeal(ctx, 'deal-1');
  expectError(r, 'RATE_LIMITED');
  assert.equal(relay.postCount, 1);
});

test('consentDeal: tip fetch throws -> TRANSPORT', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, { throwOnTip: true });
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await consentDeal(ctx, 'deal-1');
  expectError(r, 'TRANSPORT');
  assert.equal(relay.postCount, 0);
});

test('castVote: no JuryAssigned for own pubkey -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const ctx = makeCtx({
    entries: baseEntries(s),
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('castVote: already voted -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
    makeEntry(s.ownKp.publicKey, 3, 'JuryVoted', {
      deal_id: 'deal-1',
      juror: s.ownKp.publicKey,
      vote: 'buyer',
      appeal_round: 0,
    }),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('castVote: case closed by DisputeResolved -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
    makeEntry(s.ownKp.publicKey, 3, 'DisputeResolved', {
      deal_id: 'deal-1',
      appeal_round: 0,
    }),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('castVote: wrong dealId -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-2', 'buyer');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('castVote: own pubkey not in jurors -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('castVote: missing signingKey -> SIGNING', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: null,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'SIGNING');
  assert.equal(relay.postCount, 0);
});

test('castVote: readOnly -> READ_ONLY', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
    readOnly: true,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'READ_ONLY');
  assert.equal(relay.postCount, 0);
});

test('castVote: transportError -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
    transportError: true,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('castVote: broken verifier -> STATE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s);
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
    isBroken: true,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'STATE');
  assert.equal(relay.postCount, 0);
});

test('castVote: success vote buyer in round 0', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, { tip: null });
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const ev = r.value;
  assert.equal(ev.type, 'JuryVoted');
  assert.equal(ev.version, 1);
  assert.equal(ev.signer, s.ownKp.publicKey);
  assert.equal(ev.timestamp, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(
    Object.keys(ev.payload).sort(),
    ['appeal_round', 'deal_id', 'juror', 'sig', 'vote'],
  );
  assert.equal(ev.payload['deal_id'], 'deal-1');
  assert.equal(ev.payload['juror'], s.ownKp.publicKey);
  assert.equal(ev.payload['vote'], 'buyer');
  assert.equal(ev.payload['appeal_round'], 0);

  const sig = ev.payload['sig'];
  assert.equal(typeof sig, 'string');
  if (typeof sig !== 'string') return;

  const body = {
    deal_id: 'deal-1',
    juror: s.ownKp.publicKey,
    vote: 'buyer',
    appeal_round: 0,
  };
  assert.equal(
    await verifyAttestation(port, s.ownKp.publicKey, 'jury-vote', body, sig),
    true,
  );
  assert.equal(
    await verifyAttestation(
      port,
      s.ownKp.publicKey,
      'jury-vote',
      { ...body, vote: 'seller' },
      sig,
    ),
    false,
  );
  assert.equal(await verifyEvent(port, ev), true);
  assert.equal(relay.postCount, 1);

  assert.ok(relay.lastPosted);
  if (!relay.lastPosted) return;
  assert.deepEqual(relay.lastPosted, ev);
});

test('castVote: success vote seller in round 0', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, { tip: null });
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'seller');
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const ev = r.value;
  assert.equal(ev.type, 'JuryVoted');
  assert.equal(ev.payload['vote'], 'seller');
  assert.equal(ev.payload['appeal_round'], 0);

  const sig = ev.payload['sig'];
  assert.equal(typeof sig, 'string');
  if (typeof sig !== 'string') return;

  const body = {
    deal_id: 'deal-1',
    juror: s.ownKp.publicKey,
    vote: 'seller',
    appeal_round: 0,
  };
  assert.equal(
    await verifyAttestation(port, s.ownKp.publicKey, 'jury-vote', body, sig),
    true,
  );
  assert.equal(
    await verifyAttestation(
      port,
      s.ownKp.publicKey,
      'jury-vote',
      { ...body, vote: 'buyer' },
      sig,
    ),
    false,
  );
  assert.equal(await verifyEvent(port, ev), true);
  assert.equal(relay.postCount, 1);
});

test('castVote: appeal round 1 is used when open', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, { tip: null });
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 1, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  assert.equal(r.ok, true);
  if (!r.ok) return;

  assert.equal(r.value.type, 'JuryVoted');
  assert.equal(r.value.payload['appeal_round'], 1);
});

test('castVote: two open cases, round 1 is chosen', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, { tip: null });
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
    makeEntry(s.ownKp.publicKey, 3, 'JuryVoted', {
      deal_id: 'deal-1',
      juror: s.ownKp.publicKey,
      vote: 'buyer',
      appeal_round: 0,
    }),
    juryAssignedEntry(s, 4, 1, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  assert.equal(r.ok, true);
  if (!r.ok) return;

  assert.equal(r.value.type, 'JuryVoted');
  assert.equal(r.value.payload['appeal_round'], 1);
});

test('castVote: receipt with wrong eventHash -> DIVERGENCE', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, { wrongEventHash: true });
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'DIVERGENCE');
  assert.equal(relay.postCount, 1);
});

test('castVote: relay 429 -> RATE_LIMITED passthrough', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, {
    postStatus: 429,
    postBody: { code: 'RATE_LIMITED', message: 'slow', path: '$.rate' },
  });
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'RATE_LIMITED');
  assert.equal(relay.postCount, 1);
});

test('castVote: tip fetch throws -> TRANSPORT', async () => {
  const s = await setupPromise;
  const relay = makeRelay(s, { throwOnTip: true });
  const entries = [
    ...baseEntries(s),
    juryAssignedEntry(s, 2, 0, [s.ownKp.publicKey, s.otherKp.publicKey]),
  ];
  const ctx = makeCtx({
    entries,
    ownPubkey: s.ownKp.publicKey,
    signingKey: s.signingKey,
    relayPubkey: s.relayKp.publicKey,
    relay,
  });

  const r = await castVote(ctx, 'deal-1', 'buyer');
  expectError(r, 'TRANSPORT');
  assert.equal(relay.postCount, 0);
});