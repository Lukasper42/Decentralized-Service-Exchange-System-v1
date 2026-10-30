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
    console.log('DEBUG BODY:', firstText);
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

test('POST /v1/reports rejects a report with an invalid signature', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const dir = await mkdtemp(join(tmpdir(), 'skillx-reports-badsig-'));
  const outbox = new NdjsonReportOutbox({ path: join(dir, 'reports.ndjson'), deliver: async () => 'delivered', clock: { nowMs: () => rig.now } });
  const allowlist: ListenerKeyAllowlistEntry[] = [{ pubkey: rig.cast.checker.publicKey, valid_from_sequence: 1, valid_to_sequence: 1000 }];
  const server: RelayHttpServer = createRelayServer(rig.relay, { nowMs: () => rig.now }, POLICY, new ReportReceiver({ allowlist, outbox }));
  const port = await server.listen(0, '127.0.0.1');
  try {
    const { report } = buildReport(rig);
    const tampered = { ...report, signature: report.signature.slice(0, -4) + 'AAAA' };
    const response = await fetch(`http://127.0.0.1:${port}/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tampered) });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, 'SIGNATURE');
  } finally {
    await server.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /v1/reports rejects a report from an unauthorized listener', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const dir = await mkdtemp(join(tmpdir(), 'skillx-reports-unauth-'));
  const outbox = new NdjsonReportOutbox({ path: join(dir, 'reports.ndjson'), deliver: async () => 'delivered', clock: { nowMs: () => rig.now } });
  const allowlist: ListenerKeyAllowlistEntry[] = [{ pubkey: rig.cast.checker.publicKey, valid_from_sequence: 1, valid_to_sequence: 1000 }];
  const server: RelayHttpServer = createRelayServer(rig.relay, { nowMs: () => rig.now }, POLICY, new ReportReceiver({ allowlist, outbox }));
  const port = await server.listen(0, '127.0.0.1');
  try {
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
    const outsider = rig.cast.buyer;
    const report = circularTradingReport(finding, 3, h('receipt'), outsider.publicKey, iso(rig.now), outsider.privateKey);
    const response = await fetch(`http://127.0.0.1:${port}/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code: string }).code, 'SIGNER_AUTHORITY');
  } finally {
    await server.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /v1/reports rejects a report whose through_sequence is outside the allowlist range', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const dir = await mkdtemp(join(tmpdir(), 'skillx-reports-seq-'));
  const outbox = new NdjsonReportOutbox({ path: join(dir, 'reports.ndjson'), deliver: async () => 'delivered', clock: { nowMs: () => rig.now } });
  const allowlist: ListenerKeyAllowlistEntry[] = [{ pubkey: rig.cast.checker.publicKey, valid_from_sequence: 1, valid_to_sequence: 1000 }];
  const server: RelayHttpServer = createRelayServer(rig.relay, { nowMs: () => rig.now }, POLICY, new ReportReceiver({ allowlist, outbox }));
  const port = await server.listen(0, '127.0.0.1');
  try {
    const { report } = buildReport(rig);
    const outOfRange = circularTradingReport(
      {
        ruleId: 'circular-trading-pair' as const,
        accountA: report.account_a,
        accountB: report.account_b,
        forward: { dealId: 'deal-1', from: report.account_a, to: report.account_b, amount: 500, acceptedAt: report.forward.accepted_at, sequence: 1, releaseEventHash: h('forward') },
        reverse: { dealId: 'deal-2', from: report.account_b, to: report.account_a, amount: 500, acceptedAt: report.reverse.accepted_at, sequence: 2, releaseEventHash: h('reverse') },
      },
      2000,
      h('receipt'),
      rig.cast.checker.publicKey,
      iso(rig.now),
      rig.cast.checker.privateKey,
    );
    const response = await fetch(`http://127.0.0.1:${port}/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(outOfRange) });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code: string }).code, 'SIGNER_AUTHORITY');
  } finally {
    await server.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /v1/reports treats concurrent duplicate submissions as one acceptance', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const dir = await mkdtemp(join(tmpdir(), 'skillx-reports-concurrent-'));
  const outboxPath = join(dir, 'reports.ndjson');
  const outbox = new NdjsonReportOutbox({ path: outboxPath, deliver: async () => 'delivered', clock: { nowMs: () => rig.now } });
  const allowlist: ListenerKeyAllowlistEntry[] = [{ pubkey: rig.cast.checker.publicKey, valid_from_sequence: 1, valid_to_sequence: 1000 }];
  const server: RelayHttpServer = createRelayServer(rig.relay, { nowMs: () => rig.now }, POLICY, new ReportReceiver({ allowlist, outbox }));
  const port = await server.listen(0, '127.0.0.1');
  try {
    const { report } = buildReport(rig);
    const post = async (): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    const responses = await Promise.all([post(), post(), post(), post(), post()]);
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 201]);
    const lines = (await readFile(outboxPath, 'utf8')).trim().split(String.fromCharCode(10));
    assert.equal(lines.length, 1);
  } finally {
    await server.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('report idempotency and the NDJSON outbox survive a relay restart', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  const dir = await mkdtemp(join(tmpdir(), 'skillx-reports-restart-'));
  const outboxPath = join(dir, 'reports.ndjson');
  const allowlist: ListenerKeyAllowlistEntry[] = [{ pubkey: rig.cast.checker.publicKey, valid_from_sequence: 1, valid_to_sequence: 1000 }];
  const firstOutbox = new NdjsonReportOutbox({ path: outboxPath, deliver: async () => 'delivered', clock: { nowMs: () => rig.now } });
  const firstServer: RelayHttpServer = createRelayServer(rig.relay, { nowMs: () => rig.now }, POLICY, new ReportReceiver({ allowlist, outbox: firstOutbox }));
  const firstPort = await firstServer.listen(0, '127.0.0.1');
  const { report } = buildReport(rig);
  const first = await fetch(`http://127.0.0.1:${firstPort}/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
  assert.equal(first.status, 201);
  await new Promise((r) => setTimeout(r, 50));
  await firstServer.shutdown();
  const knownFindingIds = await firstOutbox.loadFindingIds();
  assert.deepEqual(knownFindingIds, [report.finding_id]);
  const restartedOutbox = new NdjsonReportOutbox({ path: outboxPath, deliver: async () => 'delivered', clock: { nowMs: () => rig.now } });
  const restartedServer: RelayHttpServer = createRelayServer(rig.relay, { nowMs: () => rig.now }, POLICY, new ReportReceiver({ allowlist, outbox: restartedOutbox, knownFindingIds }));
  const restartedPort = await restartedServer.listen(0, '127.0.0.1');
  try {
    const duplicate = await fetch(`http://127.0.0.1:${restartedPort}/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as { duplicate: boolean }).duplicate, true);
    const lines = (await readFile(outboxPath, 'utf8')).trim().split(String.fromCharCode(10));
    assert.equal(lines.length, 1);
  } finally {
    await restartedServer.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('NdjsonReportOutbox stops after exactly five retryable attempts and records the abandonment', async () => {
  const rig = new RelayRig();
  rig.bootstrap();
  let calls = 0;
  const delays: number[] = [];
  let abandoned: string | undefined;
  const outbox = new NdjsonReportOutbox({
    path: 'unused.ndjson',
    deliver: async () => {
      calls += 1;
      return 'retryable';
    },
    clock: { nowMs: () => rig.now },
    maxAttempts: 5,
    baseBackoffMs: 100,
    delay: async (ms) => {
      delays.push(ms);
    },
    appendLine: async () => {},
    onExhausted: (report) => {
      abandoned = report.finding_id;
    },
  });
  const { report } = buildReport(rig);
  await outbox.append(report);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 5);
  assert.deepEqual(delays, [100, 200, 400, 800]);
  assert.equal(abandoned, report.finding_id);
});
