import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryCommitment, signAttestation, signCheckpoint, relayKeyId } from '../../crypto/src/index.js';
import { createRelayServer } from '../../relay/src/http.js';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import type { PayloadMap } from '../../domain/src/protocol.js';
import { DAY, h, iso, newIdentity, uuid } from '../../testing/src/fixtures.js';
import type { Identity } from '../../testing/src/fixtures.js';
import { HttpTransport } from './http-transport.js';
import { LedgerClient } from './ledger-client.js';
import type { ClientResult, LedgerTransport } from './ports.js';
import { RelayTransport } from './relay-transport.js';
import { keyPairSigner, keystoreSigner } from './signers.js';
import type { KeystoreLike } from './signers.js';

function code(result: ClientResult<unknown>): string {
  return result.ok ? 'OK' : result.error.code;
}

function clientFor(rig: RelayRig, who: Identity | null, transport: LedgerTransport = new RelayTransport(rig.relay)): LedgerClient {
  return new LedgerClient({
    transport,
    projector: rig.projector,
    clock: { nowMs: () => rig.now },
    ...(who === null ? {} : { signer: keyPairSigner(who) }),
  });
}

/** A transport that forwards to another one and lets a test tamper with single answers. */
class Tamper implements LedgerTransport {
  entriesHook: ((entries: readonly unknown[]) => readonly unknown[]) | null = null;
  tipHook: ((tip: { tipSequence: number; stateHash: string }) => { tipSequence: number; stateHash: string }) | null = null;
  signerTipStale = 0;
  checkpointHook: (() => Awaited<ReturnType<LedgerTransport['latestCheckpoint']>>) | null = null;
  constructor(private readonly inner: LedgerTransport) {}
  submit: LedgerTransport['submit'] = (event) => this.inner.submit(event);
  async tip(): ReturnType<LedgerTransport['tip']> {
    const tip = await this.inner.tip();
    return tip.ok && this.tipHook !== null ? { ok: true, value: this.tipHook(tip.value) } : tip;
  }
  async entries(from: number, to: number): ReturnType<LedgerTransport['entries']> {
    const page = await this.inner.entries(from, to);
    if (!page.ok || this.entriesHook === null) return page;
    return { ok: true, value: { ...page.value, entries: this.entriesHook(page.value.entries) as never } };
  }
  async signerTip(signer: string): ReturnType<LedgerTransport['signerTip']> {
    if (this.signerTipStale > 0) { this.signerTipStale -= 1; return { ok: true, value: null }; }
    return this.inner.signerTip(signer);
  }
  latestCheckpoint(): ReturnType<LedgerTransport['latestCheckpoint']> {
    return this.checkpointHook === null ? this.inner.latestCheckpoint() : Promise.resolve(this.checkpointHook());
  }
}

function dealPayload(rig: RelayRig, n: number): Parameters<LedgerClient['submit']>[1] {
  return { deal_id: uuid(n), buyer: rig.cast.buyer.publicKey, seller: rig.cast.seller.publicKey, amount: 1000, criteria_hash: h(`c${n}`), deadline: iso(rig.now + 30 * DAY) } as never;
}

test('sync verifies the whole ledger and reproduces the relay state', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const dealId = rig.openDeal(1, 1000);
  const client = clientFor(rig, null);
  const report = await client.sync();
  assert.ok(report.ok);
  assert.equal(client.tipSequence, rig.relay.tipSequence);
  assert.equal(report.ok && report.value.stateHash, rig.relay.stateHash);
  assert.equal(client.deal(dealId)?.status, 'escrowed');
  assert.equal(client.balanceOf(rig.cast.buyer.publicKey), 1_000_000 - 1000);
  const again = await client.sync();
  assert.ok(again.ok && again.value.fetched === 0);
});

test('a signing client runs a deal end to end and reads the result from its own verified state', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const buyer = clientFor(rig, rig.cast.buyer);
  const seller = clientFor(rig, rig.cast.seller);
  await buyer.sync();
  await seller.sync();

  rig.now += 1000;
  const created = await buyer.submit('DealCreated', dealPayload(rig, 1) as never);
  assert.ok(created.ok);
  await seller.sync();
  rig.now += 1000;
  assert.ok((await seller.consentDeal(uuid(1))).ok);
  rig.now += 1000;
  assert.ok((await buyer.submit('EscrowFunded', { deal_id: uuid(1), from: rig.cast.buyer.publicKey, amount: 1000 })).ok);
  await seller.sync();
  rig.now += 1000;
  assert.ok((await seller.submit('DeliverableSubmitted', { deal_id: uuid(1), content_hash: h('content'), precheck_ref: null })).ok);
  await buyer.sync();
  rig.now += 1000;
  assert.ok((await buyer.submit('DealAccepted', { deal_id: uuid(1), by: rig.cast.buyer.publicKey })).ok);
  rig.now += 1000;
  assert.ok((await buyer.submit('EscrowReleased', { deal_id: uuid(1), to: rig.cast.seller.publicKey, amount: 990 })).ok);
  rig.now += 1000;
  assert.ok((await buyer.submit('FeeBurned', { deal_id: uuid(1), amount: 10 })).ok);

  await seller.sync();
  assert.equal(seller.deal(uuid(1))?.status, 'completed');
  assert.equal(seller.balanceOf(rig.cast.seller.publicKey), 1_000_000 + 990);
  assert.equal(seller.state.accounting.burned, 10);
  const rank = seller.rankOf(rig.cast.seller.publicKey);
  assert.ok(rank.ok && rank.value === 1);
  assert.equal(code(seller.rankOf(newIdentity().publicKey)), 'STATE');
  assert.equal(seller.state && (await seller.sync()).ok, true);
});

test('submit retries once when its view of the own chain is stale, and reports real rejections as they are', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const tamper = new Tamper(new RelayTransport(rig.relay));
  const buyer = clientFor(rig, rig.cast.buyer, tamper);
  rig.now += 1000;
  assert.ok((await buyer.submit('DealCreated', dealPayload(rig, 1) as never)).ok);
  tamper.signerTipStale = 1;
  rig.now += 1000;
  assert.ok((await buyer.submit('DealCreated', dealPayload(rig, 2) as never)).ok);
  rig.now += 1000;
  const rejected = await buyer.submit('DealAccepted', { deal_id: uuid(99), by: rig.cast.buyer.publicKey });
  assert.equal(code(rejected), 'STATE');
  assert.equal(buyer.divergence, null);
});

test('a client without a signer cannot write, and a failing signer is reported as SIGNING', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const reader = clientFor(rig, null);
  assert.equal(code(await reader.submit('DealAccepted', { deal_id: uuid(1), by: rig.cast.buyer.publicKey })), 'SIGNING');
  const refusing: KeystoreLike = {
    identity: { accountPublicKey: rig.cast.buyer.publicKey },
    signEvent: () => Promise.resolve({ ok: false, code: 'E_POLICY_DENIED', message: 'declined' }),
    signAttestation: () => Promise.resolve({ ok: false, code: 'E_POLICY_DENIED', message: 'declined' }),
  };
  const client = new LedgerClient({ transport: new RelayTransport(rig.relay), projector: rig.projector, clock: { nowMs: () => rig.now }, signer: keystoreSigner(refusing) });
  assert.equal(code(await client.submit('DealAccepted', { deal_id: uuid(1), by: rig.cast.buyer.publicKey })), 'SIGNING');
});

test('a relay that alters an entry is caught by verification and the client keeps its last good prefix', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  rig.openDeal(1, 1000);
  const tamper = new Tamper(new RelayTransport(rig.relay));
  tamper.entriesHook = (entries) => entries.map((entry, index) => {
    if (index !== 2) return entry;
    const original = entry as { event: { payload: { amount: number } }; receipt: unknown };
    return { ...original, event: { ...original.event, payload: { ...original.event.payload, amount: 1 } } };
  });
  const client = clientFor(rig, null, tamper);
  const synced = await client.sync();
  assert.equal(synced.ok, false);
  assert.ok(!synced.ok && ['SIGNATURE', 'RECEIPT_EVENT_HASH', 'AMOUNT', 'PAYLOAD'].includes(synced.error.code));
  assert.equal(client.tipSequence, 2);
});

test('a relay that lies about its state hash or rolls back is a DIVERGENCE and the client stops', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const tamper = new Tamper(new RelayTransport(rig.relay));
  tamper.tipHook = (tip) => ({ ...tip, stateHash: h('forged') });
  const client = clientFor(rig, null, tamper);
  const lied = await client.sync();
  assert.equal(code(lied), 'DIVERGENCE');
  tamper.tipHook = null;
  assert.equal(code(await client.sync()), 'DIVERGENCE');
  assert.equal(client.divergence?.code, 'DIVERGENCE');

  const honest = clientFor(rig, null);
  assert.ok((await honest.sync()).ok);
  rig.openDeal(1, 1000);
  await honest.sync();
  const behind = new Tamper(new RelayTransport(rig.relay));
  const watcher = clientFor(rig, null, behind);
  await watcher.sync();
  behind.tipHook = (tip) => ({ ...tip, tipSequence: tip.tipSequence - 1 });
  assert.equal(code(await watcher.sync()), 'DIVERGENCE');
});

test('verifyCheckpoint accepts the relay checkpoint and flags a signed contradiction as DIVERGENCE', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  rig.openDeal(1, 1000);
  const tamper = new Tamper(new RelayTransport(rig.relay));
  const client = clientFor(rig, null, tamper);
  await client.sync();
  const ok = await client.verifyCheckpoint();
  assert.ok(ok.ok && ok.value);

  const keyId = relayKeyId(rig.genesisKey.publicKey);
  const body = { sequence: 2, receipt_hash: h('another history'), key_id: keyId };
  tamper.checkpointHook = () => ({ ok: true, value: { ...body, signature: signCheckpoint(body, rig.genesisKey.privateKey) } });
  assert.equal(code(await client.verifyCheckpoint()), 'DIVERGENCE');
  assert.equal(code(await client.sync()), 'DIVERGENCE');
});

test('HTTP transport: a client syncs, submits and sees relay errors with their protocol codes', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const server = createRelayServer(rig.relay, { nowMs: () => rig.now }, { maxBodyBytes: 8192, perIpLimit: 1000, perKeyLimit: 100, windowMs: 60_000, maxPage: 2, allowedOrigin: null });
  const port = await server.listen(0, '127.0.0.1');
  try {
    const transport = new HttpTransport({ baseUrl: `http://127.0.0.1:${port}` });
    const client = clientFor(rig, rig.cast.buyer, transport);
    rig.now += 1000;
    const created = await client.submit('DealCreated', dealPayload(rig, 1) as never);
    assert.ok(created.ok);
    assert.equal(client.tipSequence, rig.relay.tipSequence);
    assert.equal(client.deal(uuid(1))?.status, 'created');
    rig.now += 1000;
    assert.equal(code(await client.submit('DealAccepted', { deal_id: uuid(99), by: rig.cast.buyer.publicKey })), 'STATE');
    const checkpoint = await client.verifyCheckpoint();
    assert.ok(checkpoint.ok);
  } finally {
    await server.shutdown();
  }
  const dead = new HttpTransport({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 500 });
  assert.equal(code(await dead.tip()), 'TRANSPORT');
});

test('a deal with a counterparty whose key is rotating or replaced is refused locally and names the new key', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const { buyer, seller } = rig.cast;
  const recovery = rig.cast.extra[0];
  assert.ok(recovery !== undefined);
  const next = newIdentity();
  const body = { old_pubkey: seller.publicKey, new_pubkey: next.publicKey, new_recovery_commitment: recoveryCommitment(next.publicKey) };
  const buyerClient = clientFor(rig, buyer);
  const deal = (n: number, sellerKey: string = seller.publicKey): PayloadMap['DealCreated'] => ({ deal_id: uuid(n), buyer: buyer.publicKey, seller: sellerKey, amount: 1000, criteria_hash: h(`c${n}`), deadline: iso(rig.now + 30 * DAY) });

  // Active counterparty: the deal goes through.
  assert.equal(code(await buyerClient.submit('DealCreated', deal(1))), 'OK');
  assert.deepEqual(buyerClient.keyStatus(seller.publicKey), { kind: 'active' });

  // Rotation pending: the old key is frozen, the client refuses and names the replacement.
  rig.now += 1000;
  rig.must('KeyRotated', { ...body, recovery_pubkey: recovery.publicKey, sig: signAttestation('key-rotation', body, recovery.privateKey) }, next);
  rig.now += 1000;
  const sizeBefore = rig.store.all().length;
  const frozen = await buyerClient.submit('DealCreated', deal(2));
  assert.equal(code(frozen), 'STATE');
  assert.ok(!frozen.ok && frozen.error.message.includes(next.publicKey) && frozen.error.path === 'payload.seller');
  assert.equal(buyerClient.keyStatus(seller.publicKey).kind, 'frozen');
  assert.equal(rig.store.all().length, sizeBefore, 'nothing was submitted');

  // After the delay and one more event the old key is retired; the client follows the chain to the current key.
  rig.now += 3 * 86_400_000 + 1000;
  assert.ok(rig.createAccount(rig.cast.extra[3] ?? newIdentity()).ok);
  const retired = await buyerClient.submit('DealCreated', deal(3));
  assert.equal(code(retired), 'STATE');
  assert.ok(!retired.ok && retired.error.message.includes(next.publicKey));
  assert.deepEqual(buyerClient.keyStatus(seller.publicKey), { kind: 'retired', replacedBy: next.publicKey });
  assert.deepEqual(buyerClient.keyStatus(next.publicKey), { kind: 'active' });
  assert.deepEqual(buyerClient.keyStatus(newIdentity().publicKey), { kind: 'unknown' });

  // With the new key the deal works.
  const fixed = deal(4, next.publicKey);
  assert.equal(code(await buyerClient.submit('DealCreated', fixed)), 'OK');
});
