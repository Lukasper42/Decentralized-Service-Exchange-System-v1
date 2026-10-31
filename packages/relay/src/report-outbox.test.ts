import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NdjsonReportOutbox, parseListenerAllowlist } from './report-receiver.js';
import type { ReportDeliveryOutcome } from './report-receiver.js';
import { httpReportDelivery } from './report-delivery.js';
import type { CircularTradingReport } from '../../listener/src/circular-trading-report.js';

const NL = String.fromCharCode(10);
const clock = { nowMs: () => 0 };
const fake = (c: string): CircularTradingReport => ({ finding_id: c.repeat(64) } as unknown as CircularTradingReport);

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'skillx-outbox-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

test('loadFindingIds skips a torn last line and corrupt lines instead of losing every id', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'r.ndjson');
    await writeFile(path, `junk${NL}${JSON.stringify(fake('a'))}${NL}${JSON.stringify(fake('b'))}${NL}{"finding_id":"cc`);
    const ids = await new NdjsonReportOutbox({ path, clock }).loadFindingIds();
    assert.deepEqual(ids, ['a'.repeat(64), 'b'.repeat(64)]);
  });
});

test('loadFindingIds returns an empty list for a missing file but reports real read errors', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await new NdjsonReportOutbox({ path: join(dir, 'none.ndjson'), clock }).loadFindingIds(), []);
    await assert.rejects(new NdjsonReportOutbox({ path: dir, clock }).loadFindingIds());
  });
});

test('append after a torn last line starts a new line so the new report stays readable', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'r.ndjson');
    await writeFile(path, `${JSON.stringify(fake('a'))}${NL}{"finding_id":"cc`);
    const outbox = new NdjsonReportOutbox({ path, clock });
    await outbox.append(fake('d'));
    assert.deepEqual(await outbox.loadFindingIds(), ['a'.repeat(64), 'd'.repeat(64)]);
    const text = await readFile(path, 'utf8');
    assert.ok(text.endsWith(NL));
  });
});

test('a report that could not be delivered stays pending and is redelivered after a restart', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'r.ndjson');
    const failing = new NdjsonReportOutbox({ path, clock, maxAttempts: 2, baseBackoffMs: 1, deliver: async () => 'retryable' });
    await failing.append(fake('a'));
    await settle();
    assert.deepEqual((await failing.loadPending()).map((r) => r.finding_id), ['a'.repeat(64)]);

    const delivered: string[] = [];
    const restarted = new NdjsonReportOutbox({ path, clock, deliver: async (r) => { delivered.push(r.finding_id); return 'delivered'; } });
    assert.equal(await restarted.replayPending(), 1);
    assert.deepEqual(delivered, ['a'.repeat(64)]);
    assert.deepEqual(await restarted.loadPending(), []);
    assert.equal(await restarted.replayPending(), 0);
    assert.equal(delivered.length, 1);
  });
});

test('a permanently refused report is marked done and never replayed', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'r.ndjson');
    const calls: string[] = [];
    const outbox = new NdjsonReportOutbox({ path, clock, deliver: async (r): Promise<ReportDeliveryOutcome> => { calls.push(r.finding_id); return 'permanent'; } });
    await outbox.append(fake('a'));
    await settle();
    assert.deepEqual(await outbox.loadPending(), []);
    assert.equal(await outbox.replayPending(), 0);
    assert.equal(calls.length, 1);
  });
});

test('store-only mode (no deliver function) keeps reports and replays nothing', async () => {
  await withDir(async (dir) => {
    const outbox = new NdjsonReportOutbox({ path: join(dir, 'r.ndjson'), clock });
    await outbox.append(fake('a'));
    assert.deepEqual(await outbox.loadFindingIds(), ['a'.repeat(64)]);
    assert.equal(await outbox.replayPending(), 0);
  });
});

test('parseListenerAllowlist accepts a valid file and rejects everything else', () => {
  const entry = { pubkey: 'K', valid_from_sequence: 1, valid_to_sequence: 10 };
  assert.deepEqual(parseListenerAllowlist(JSON.stringify([entry])), [entry]);
  assert.deepEqual(parseListenerAllowlist('[]'), []);
  const bad = ['{', '{}', '[1]', JSON.stringify([{ ...entry, extra: 1 }]), JSON.stringify([{ pubkey: 'K', valid_from_sequence: 1 }]), JSON.stringify([{ ...entry, pubkey: '' }]), JSON.stringify([{ ...entry, valid_from_sequence: 0 }]), JSON.stringify([{ ...entry, valid_from_sequence: 11 }]), JSON.stringify([{ ...entry, valid_to_sequence: 1.5 }])];
  for (const text of bad) assert.throws(() => parseListenerAllowlist(text), /invalid listener allowlist/, text);
});

test('httpReportDelivery maps statuses and network failures to delivery outcomes', async () => {
  const outcome = async (respond: () => Promise<Response>): Promise<ReportDeliveryOutcome> => httpReportDelivery('http://127.0.0.1:1/x', respond as unknown as typeof fetch)(fake('a'));
  assert.equal(await outcome(() => Promise.resolve(new Response(null, { status: 204 }))), 'delivered');
  for (const status of [408, 425, 429, 500, 503]) assert.equal(await outcome(() => Promise.resolve(new Response('', { status }))), 'retryable', String(status));
  for (const status of [400, 401, 403, 404, 422]) assert.equal(await outcome(() => Promise.resolve(new Response('', { status }))), 'permanent', String(status));
  assert.equal(await outcome(() => Promise.reject(new Error('down'))), 'retryable');
});
