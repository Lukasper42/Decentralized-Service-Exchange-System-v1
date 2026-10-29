import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import { h, iso } from '../../testing/src/fixtures.js';
import { createRelayServer } from './http.js';
import type { HttpPolicy, RelayHttpServer } from './http.js';
import { NdjsonReportOutbox, ReportReceiver } from './report-receiver.js';
import type { ListenerKeyAllowlistEntry } from './report-receiver.js';
import { circularTradingReport } from '../../listener/src/circular-trading-report.js';

const POLICY: HttpPolicy = { maxBodyBytes: 8192, perIpLimit: 1000, perKeyLimit: 5, windowMs: 60_000, maxPage: 3, allowedOrigin: null };

test('POST /v1/reports accepts a signed report once, treats the resend as a duplicate, and writes the NDJSON outbox', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const dir = await mkdtemp(join(tmpdir(), 'skillx-reports-'));
  const outboxPath = join(dir, 'reports.ndjson');
  const listener = rig.cast.checker;
  const pair = [rig.cast.buyer, rig.cast.seller].sort((x, y) => Buffer.compare(Buffer.from(x.publicKey), Buffer.from(y.publicKey)));
  const a = pair[0] as { publicKey: string; privateKey: string };
  const b = pair[1] as { publicKey: string; privateKey: string };
  const allowlist: ListenerKeyAllowlistEntry[] = [{ pubkey: listener.publicKey, valid_from_sequence: 1, valid_to_sequence: 1000 }];
  const outbox = new NdjsonReportOutbox({ path: outboxPath, deliver: async () => 'delivered', clock: { nowMs: () => rig.now } });
  const server: RelayHttpServer = createRelayServer(rig.relay, { nowMs: () => rig.now }, POLICY, new ReportReceiver({ allowlist, outbox }));
  const port = await server.listen(0, '127.0.0.1');
  try {
    const finding = {
      ruleId: 'circular-trading-pair' as const,
      accountA: a.publicKey,
      accountB: b.publicKey,
      forward: { dealId: 'deal-1', from: a.publicKey, to: b.publicKey, amount: 500, acceptedAt: iso(rig.now), sequence: 1, releaseEventHash: h('forward') },
      reverse: { dealId: 'deal-2', from: b.publicKey, to: a.publicKey, amount: 500, acceptedAt: iso(rig.now), sequence: 2, releaseEventHash: h('reverse') },
    };
    const report = circularTradingReport(finding, 3, h('receipt'), listener.publicKey, iso(rig.now), listener.privateKey);
    const post = async (): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    const first = await post();
    const firstText = await first.text();
    const firstBody = JSON.parse(firstText) as { finding_id: string; duplicate: boolean };
    assert.equal(first.status, 201);
    assert.equal(firstBody.duplicate, false);
    assert.equal(firstBody.finding_id, report.finding_id);
    const second = await post();
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { duplicate: boolean }).duplicate, true);
    const lines = (await readFile(outboxPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] as string), report);
  } finally {
    await server.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

function buildReport(rig: RelayRig): { report: ReturnType<typeof circularTradingReport>; listener: { publicKey: string; privateKey: string } } {
  const listener = rig.cast.checker;
  const pair = [rig.cast.buyer, rig.cast.seller].sort((x, y) => Buffer.compare(Buffer.from(x.publicKey), Buffer.from(y.publicKey)));
  const a = pair[0] as { publicKey: string; privateKey: string };
  const b = pair[1] as { publicKey: string; privateKey: string };
  const finding = {
    ruleId: 'circular-trading-pair' as const,
    accountA: a.publicKey,
    accountB: b.publicKey,
    forward: { dealId: 'deal-1', from: a.publicKey, to: b.publicKey, amount: 500, acceptedAt: iso(rig.now), sequence: 1, releaseEventHash: h('forward') },
    reverse: { dealId: 'deal-2', from: b.publicKey, to: a.publicKey, amount: 500, acceptedAt: iso(rig.now), sequence: 2, releaseEventHash: h('reverse') },
  };
  return { report: circularTradingReport(finding, 3, h('receipt'), listener.publicKey, iso(rig.now), listener.privateKey), listener };
}

test('NdjsonReportOutbox retries retryable deliveries with exponential backoff and writes the report exactly once', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  let calls = 0;
  const delays: number[] = [];
  const outbox = new NdjsonReportOutbox({
    path: 'unused.ndjson',
    deliver: async () => {
      calls += 1;
      return calls < 3 ? 'retryable' : 'delivered';
    },
    clock: { nowMs: () => rig.now },
    baseBackoffMs: 100,
    delay: async (ms) => {
      delays.push(ms);
    },
    appendLine: async () => {},
  });
  const { report } = buildReport(rig);
  await outbox.append(report);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('NdjsonReportOutbox never retries a permanent failure', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  let calls = 0;
  const delays: number[] = [];
  const outbox = new NdjsonReportOutbox({
    path: 'unused.ndjson',
    deliver: async () => {
      calls += 1;
      return 'permanent';
    },
    clock: { nowMs: () => rig.now },
    baseBackoffMs: 100,
    delay: async (ms) => {
      delays.push(ms);
    },
    appendLine: async () => {},
  });
  const { report } = buildReport(rig);
  await outbox.append(report);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('report processing does not change ledger events, sequence, state hash, or receipt chain', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const dir = await mkdtemp(join(tmpdir(), 'skillx-reports-ledger-'));
  const outboxPath = join(dir, 'reports.ndjson');
  const listener = rig.cast.checker;
  const allowlist: ListenerKeyAllowlistEntry[] = [{ pubkey: listener.publicKey, valid_from_sequence: 1, valid_to_sequence: 1000 }];
  const outbox = new NdjsonReportOutbox({ path: outboxPath, deliver: async () => 'delivered', clock: { nowMs: () => rig.now } });
  const server: RelayHttpServer = createRelayServer(rig.relay, { nowMs: () => rig.now }, POLICY, new ReportReceiver({ allowlist, outbox }));
  const port = await server.listen(0, '127.0.0.1');
  try {
    const tipBefore = await (await fetch(`http://127.0.0.1:${port}/v1/tip`)).json();
    const entriesBefore = await (await fetch(`http://127.0.0.1:${port}/v1/entries`)).json();
    const { report } = buildReport(rig);
    const response = await fetch(`http://127.0.0.1:${port}/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    assert.equal(response.status, 201);
    const tipAfter = await (await fetch(`http://127.0.0.1:${port}/v1/tip`)).json();
    const entriesAfter = await (await fetch(`http://127.0.0.1:${port}/v1/entries`)).json();
    assert.deepEqual(tipAfter, tipBefore);
    assert.deepEqual(entriesAfter, entriesBefore);
    assert.equal(rig.relay.stateHash, (tipBefore as { stateHash: string }).stateHash);
  } finally {
    await server.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
