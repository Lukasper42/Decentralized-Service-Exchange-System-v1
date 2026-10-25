import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import { eventHash } from '../../crypto/src/index.js';
import { DAY, eventOf, h, iso, uuid } from '../../testing/src/fixtures.js';
import { clientIpOf, createRelayServer } from './http.js';
import type { HttpPolicy } from './http.js';
import type { RelayHttpServer } from './http.js';

const POLICY: HttpPolicy = { maxBodyBytes: 8192, perIpLimit: 1000, perKeyLimit: 5, windowMs: 60_000, maxPage: 3, allowedOrigin: null };

async function withServer(run: (base: string, rig: RelayRig, server: RelayHttpServer) => Promise<void>, policy: HttpPolicy = POLICY): Promise<void> {
  const rig = new RelayRig();
  rig.bootstrap();
  const server = createRelayServer(rig.relay, { nowMs: () => rig.now }, policy);
  const port = await server.listen(0, '127.0.0.1');
  try { await run(`http://127.0.0.1:${port}`, rig, server); } finally { await server.shutdown(); }
}
const post = (base: string, body: unknown, raw = false): Promise<Response> => fetch(`${base}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? String(body) : JSON.stringify(body) });

test('submit returns 201 with a receipt, 200 for the duplicate, and the read endpoints expose entries, tip, receipt and checkpoint', async () => {
  await withServer(async (base, rig) => {
    const { buyer, seller } = rig.cast;
    const event = rig.build('DealCreated', { deal_id: uuid(1), buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h('c'), deadline: iso(rig.now + DAY) }, buyer);
    const created = await post(base, event);
    assert.equal(created.status, 201);
    const body = await created.json() as { receipt: { sequence: number }; duplicate: boolean };
    assert.deepEqual([body.receipt.sequence, body.duplicate], [3, false]);
    const dup = await post(base, event);
    assert.equal(dup.status, 200);
    assert.equal(((await dup.json()) as { duplicate: boolean }).duplicate, true);
    const tip = await (await fetch(`${base}/v1/tip`)).json() as { tipSequence: number; stateHash: string };
    assert.equal(tip.tipSequence, 3);
    assert.equal(tip.stateHash, rig.relay.stateHash);
    const page = await (await fetch(`${base}/v1/entries?from=1&to=3`)).json() as { entries: unknown[]; next: number | null };
    assert.equal(page.entries.length, 3);
    const clipped = await (await fetch(`${base}/v1/entries?from=1&to=10`)).json() as { entries: unknown[]; next: number | null };
    assert.deepEqual([clipped.entries.length, clipped.next], [3, 4]);
    const found = await fetch(`${base}/v1/receipts/${eventHash(event)}`);
    assert.equal(found.status, 200);
    const signerTip = await (await fetch(`${base}/v1/signers/${encodeURIComponent(buyer.publicKey)}/tip`)).json() as { tip: string };
    assert.equal(signerTip.tip, eventHash(event));
    assert.equal((await fetch(`${base}/v1/health`)).status, 200);
    const cp = await fetch(`${base}/v1/checkpoints/latest`);
    assert.equal(cp.status, 200);
  });
});

test('errors always have the shape {code,message,path} with the right status and never leak stack traces', async () => {
  await withServer(async (base, rig) => {
    const { buyer, seller } = rig.cast;
    const check = async (response: Response, status: number, code: string): Promise<void> => {
      assert.equal(response.status, status);
      const text = await response.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), ['code', 'message', 'path']);
      assert.equal(parsed.code, code);
      assert.ok(!/\bat \w+.*\.(js|ts):\d+/.test(text));
    };
    await check(await post(base, '{not json', true), 400, 'BAD_REQUEST');
    await check(await post(base, { hello: 'world' }), 400, 'VERSION');
    await check(await fetch(`${base}/v1/receipts/zzz`), 400, 'BAD_REQUEST');
    await check(await fetch(`${base}/v1/receipts/${'0'.repeat(64)}`), 404, 'NOT_FOUND');
    await check(await fetch(`${base}/v1/nope`), 404, 'NOT_FOUND');
    await check(await fetch(`${base}/v1/entries?from=abc`), 400, 'BAD_REQUEST');
    await check(await fetch(`${base}/v1/entries`, { method: 'DELETE' }), 404, 'NOT_FOUND');
    await check(await post(base, JSON.stringify({ pad: 'x'.repeat(9000) }), true), 413, 'TOO_LARGE');
    const stale = eventOf('DealCreated', { deal_id: uuid(9), buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h('c'), deadline: iso(rig.now + DAY) }, buyer, rig.now, h('stale'));
    await check(await post(base, stale), 409, 'CHAIN_LINK');
    rig.relay.setReadOnly(true);
    await check(await post(base, stale), 503, 'READ_ONLY');
    rig.relay.setReadOnly(false);
    assert.equal(rig.relay.readOnly, false);
  });
});

test('per-key rate limit rejects the request after the limit; the CORS header is absent unless an exact origin is configured', async () => {
  await withServer(async (base, rig) => {
    const { buyer, seller } = rig.cast;
    const event = rig.build('DealCreated', { deal_id: uuid(1), buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h('c'), deadline: iso(rig.now + DAY) }, buyer);
    const statuses: number[] = [];
    let origin: string | null = 'unset';
    for (let i = 0; i < 7; i += 1) {
      const response = await post(base, event);
      statuses.push(response.status);
      if (i === 0) origin = response.headers.get('access-control-allow-origin');
    }
    assert.deepEqual(statuses, [201, 200, 200, 200, 200, 429, 429]);
    assert.equal(origin, null);
  });
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/health`);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example');
  }, { ...POLICY, allowedOrigin: 'https://app.example' });
});

test('per-IP rate limit and graceful shutdown: in-flight work completes and the port is released', async () => {
  await withServer(async (base, _rig, server) => {
    const first = await post(base, { x: 1 });
    const second = await post(base, { x: 1 });
    assert.equal(first.status, 400);
    assert.equal(second.status, 429);
    await server.shutdown();
    await assert.rejects(fetch(`${base}/v1/health`));
  }, { ...POLICY, perIpLimit: 1 });
});

test('clientIpOf: the forwarded header counts only behind a trusted proxy, and only its rightmost untrusted entry', () => {
  const proxies = ['10.0.0.1', '10.0.0.2'];
  assert.equal(clientIpOf('203.0.113.9', '198.51.100.1', proxies), '203.0.113.9', 'untrusted peer: header ignored');
  assert.equal(clientIpOf('10.0.0.1', undefined, proxies), '10.0.0.1');
  assert.equal(clientIpOf('10.0.0.1', '198.51.100.1', proxies), '198.51.100.1');
  assert.equal(clientIpOf('::ffff:10.0.0.1', '198.51.100.1', proxies), '198.51.100.1', 'IPv4-mapped peer is normalized');
  assert.equal(clientIpOf('10.0.0.1', '6.6.6.6, 198.51.100.1', proxies), '198.51.100.1', 'spoofed prefix is never reached');
  assert.equal(clientIpOf('10.0.0.1', '198.51.100.1, 10.0.0.2', proxies), '198.51.100.1', 'a second trusted proxy is skipped');
  assert.equal(clientIpOf('10.0.0.1', ['6.6.6.6', '198.51.100.1'], proxies), '198.51.100.1', 'repeated headers are joined');
  assert.equal(clientIpOf('10.0.0.1', 'not an address', proxies), '10.0.0.1', 'garbage falls back to the proxy address');
  assert.equal(clientIpOf('10.0.0.1', '10.0.0.2', proxies), '10.0.0.1', 'only proxies in the chain');
  assert.equal(clientIpOf(undefined, '1.2.3.4', proxies), 'unknown');
  assert.equal(clientIpOf('10.0.0.1', '1.2.3.4', []), '10.0.0.1', 'no trusted proxies configured');
});

test('rate limit by forwarded client: distinct clients behind a trusted proxy are limited separately, a spoofing client is not', async () => {
  const forwarded = (base: string, clientIp: string): Promise<Response> => fetch(`${base}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp }, body: '{"x":1}' });
  await withServer(async (base) => {
    assert.equal((await forwarded(base, '198.51.100.1')).status, 400);
    assert.equal((await forwarded(base, '198.51.100.2')).status, 400, 'a different client has its own budget');
    assert.equal((await forwarded(base, '198.51.100.1')).status, 429);
    assert.equal((await forwarded(base, '6.6.6.6, 198.51.100.1')).status, 429, 'prepending a fake address does not help');
  }, { ...POLICY, perIpLimit: 1, trustedProxies: ['127.0.0.1'] });
  await withServer(async (base) => {
    assert.equal((await forwarded(base, '198.51.100.1')).status, 400);
    assert.equal((await forwarded(base, '198.51.100.2')).status, 429, 'untrusted peer: the header is ignored');
  }, { ...POLICY, perIpLimit: 1 });
});
