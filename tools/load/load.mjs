#!/usr/bin/env node
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import process from 'node:process';
import { L, workdir } from '../smoke/paths.mjs';

const BASE = 'http://127.0.0.1:3055';
const RELAY_MAIN = join(L, 'dist/apps/relay/main.js');
const ADMIN_CLI = join(L, 'dist/apps/relay/admin-cli.js');

let C = null;
let relayProcess = null;
let tempDir = null;
let keepTemp = false;

class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

process.on('exit', () => {
  if (relayProcess) {
    try { relayProcess.kill('SIGKILL'); } catch { /* ignore */ }
  }
  if (tempDir && keepTemp) {
    process.stdout.write(`kept working folder: ${tempDir}\n`);
  } else if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
let signalExitCode = null;
const handleSignal = (code) => {
  signalExitCode = code;
  if (relayProcess && !hasExited(relayProcess)) {
    try { relayProcess.kill('SIGKILL'); } catch { /* ignore */ }
  }
};
process.on('SIGINT', () => handleSignal(130));
process.on('SIGTERM', () => handleSignal(143));

function usage() {
  process.stderr.write(
    'Usage: node tools/load/load.mjs [--mode memory|postgres] [--accounts 200] [--deals 200] [--concurrency 8]\n' +
    '                         [--checkpoint-every 100] [--crash-test] [--reset-db] [--keep] [--json <file>]\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const cfg = {
    mode: 'memory', accounts: 200, deals: 200, concurrency: 8,
    checkpointEvery: 100, crashTest: false, resetDb: false, keep: false,
    json: 'load-report.json',
  };
  let i = 0;
  const take = () => {
    i += 1;
    if (i >= argv.length) usage();
    return argv[i];
  };
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--mode') cfg.mode = take();
    else if (a === '--accounts') cfg.accounts = Number(take());
    else if (a === '--deals') cfg.deals = Number(take());
    else if (a === '--concurrency') cfg.concurrency = Number(take());
    else if (a === '--checkpoint-every') cfg.checkpointEvery = Number(take());
    else if (a === '--crash-test') cfg.crashTest = true;
    else if (a === '--reset-db') cfg.resetDb = true;
    else if (a === '--keep') cfg.keep = true;
    else if (a === '--json') cfg.json = take();
    else usage();
    i += 1;
  }
  return cfg;
}

function validate(cfg) {
  if (cfg.mode !== 'memory' && cfg.mode !== 'postgres') usage();
  if (!Number.isInteger(cfg.accounts) || cfg.accounts < 4) usage();
  if (!Number.isInteger(cfg.deals) || cfg.deals < 0 || cfg.deals > cfg.accounts * 100) usage();
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1) usage();
  if (!Number.isInteger(cfg.checkpointEvery) || cfg.checkpointEvery < 1) usage();
  if (cfg.crashTest && cfg.mode !== 'postgres') usage();
  if (cfg.resetDb && cfg.mode !== 'postgres') usage();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uuidv4() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function randomHex(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function fmt(v) {
  return v === null || v === undefined ? 'n/a' : Number(v).toFixed(1);
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function httpJson(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  if (text.length > 0) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { status: res.status, json };
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

async function waitForHealth(timeoutMs, child = relayProcess) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (signalExitCode !== null) throw new Error('interrupted');
    if (hasExited(child)) {
      throw new Error(`relay exited before becoming healthy (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    try {
      const res = await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(5000) });
      await res.text();
      if (res.status === 200) {
        if (hasExited(child)) throw new Error('relay exited while health was being checked');
        return performance.now() - start;
      }
    } catch (err) {
      if (hasExited(child)) throw err;
    }
    await sleep(100);
  }
  throw new Error('relay did not become healthy in time');
}

function startRelay(env) {
  const child = spawn(process.execPath, [RELAY_MAIN], {
    cwd: tempDir,
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', () => { /* drain */ });
  child.on('error', (err) => process.stderr.write(`relay spawn error: ${err.message}\n`));
  return child;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    child.once('exit', onExit);
    if (hasExited(child)) finish(true);
  });
}

async function stopRelay(child, timeoutMs) {
  if (hasExited(child)) return { graceful: true, exited: true };
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  if (await waitForExit(child, timeoutMs)) {
    return { graceful: true, exited: true };
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  const exited = await waitForExit(child, 5000);
  return { graceful: false, exited };
}

function readPeakRss(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  try {
    const m = /VmHWM:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function pgQuery(sql) {
  const req = createRequire(join(L, 'package.json'));
  const { Client } = req('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function resetDatabase() {
  await pgQuery('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

async function isDatabaseEmpty() {
  const res = await pgQuery("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
  return res.rows[0].n === 0;
}

function newStats() {
  return { sent: 0, ok201: 0, dup: 0, latencies: [], errors: {}, ackedMax: 0 };
}

function withLock(account, fn) {
  const run = account.lock.then(() => fn());
  account.lock = run.then(() => undefined, () => undefined);
  return run;
}

async function sendEvent(account, type, payload, stats) {
  return withLock(account, async () => {
    const core = {
      type,
      version: 1,
      payload,
      signer: account.publicKey,
      timestamp: new Date().toISOString(),
      prevHash: account.prevHash,
    };
    const signed = C.signEvent(core, account.privateKey);
    const hash = C.eventHash(signed);
    const t0 = performance.now();
    let status = 0;
    let json = null;
    let netErr = null;
    try {
      const res = await fetch(`${BASE}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
      });
      status = res.status;
      const text = await res.text();
      if (text.length > 0) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
    } catch (err) {
      netErr = String(err?.message ?? err);
    }
    const latency = performance.now() - t0;
    stats.sent += 1;
    stats.latencies.push(latency);
    const receiptSequence = json?.receipt?.sequence;
    const hasReceiptSequence = Number.isInteger(receiptSequence) && receiptSequence > 0;
    if ((status === 201 || status === 200) && hasReceiptSequence) {
      stats.ackedMax = Math.max(stats.ackedMax, receiptSequence);
    }
    if (status === 201) {
      stats.ok201 += 1;
      if (!hasReceiptSequence) {
        stats.errors.INVALID_RESPONSE = (stats.errors.INVALID_RESPONSE ?? 0) + 1;
        return { ok: false, status, code: 'INVALID_RESPONSE', hash };
      }
      account.prevHash = hash;
      return { ok: true, status, receipt: json.receipt, hash };
    }
    let code;
    if (status === 200) code = 'DUPLICATE';
    else if (json && typeof json.code === 'string') code = json.code;
    else if (netErr) code = 'NETWORK';
    else code = `HTTP_${status}`;
    stats.errors[code] = (stats.errors[code] ?? 0) + 1;
    if (status === 200) stats.dup += 1;
    return { ok: false, status, code, hash };
  });
}

async function runPool(count, concurrency, fn) {
  let next = 0;
  const workers = [];
  const worker = async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= count) return;
      await fn(i);
    }
  };
  const n = Math.min(concurrency, count);
  for (let w = 0; w < n; w += 1) workers.push(worker());
  await Promise.all(workers);
}

async function runDeal(i, stats, accounts) {
  const n = accounts.length;
  const buyer = accounts[i % n];
  const k = Math.floor(i / n) % (n - 1);
  const seller = accounts[(i + 1 + k) % n];
  const dealId = uuidv4();
  const body = {
    deal_id: dealId,
    buyer: buyer.publicKey,
    seller: seller.publicKey,
    amount: 2,
    criteria_hash: randomHex(32),
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  const steps = [
    () => sendEvent(buyer, 'DealCreated', body, stats),
    () => sendEvent(seller, 'DealConsented', {
      deal_id: dealId,
      seller: seller.publicKey,
      consent_sig: C.signAttestation('deal-consent', body, seller.privateKey),
    }, stats),
    () => sendEvent(buyer, 'EscrowFunded', { deal_id: dealId, from: buyer.publicKey, amount: 2 }, stats),
    () => sendEvent(seller, 'DeliverableSubmitted', { deal_id: dealId, content_hash: randomHex(32), precheck_ref: null }, stats),
    () => sendEvent(buyer, 'DealAccepted', { deal_id: dealId, by: buyer.publicKey }, stats),
  ];
  for (const step of steps) {
    const r = await step();
    if (!r.ok) return false;
  }
  return true;
}

function percentiles(values) {
  if (values.length === 0) return { p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
  return { p50: pick(50), p95: pick(95), p99: pick(99), max: sorted[sorted.length - 1] };
}

function phaseSummary(stats, wallMs) {
  return {
    sent: stats.sent,
    ok201: stats.ok201,
    errors: { ...stats.errors },
    errorCount: Object.values(stats.errors).reduce((a, b) => a + b, 0),
    wallMs,
    eventsPerSecond: wallMs > 0 ? (stats.ok201 / wallMs) * 1000 : 0,
    latency: percentiles(stats.latencies),
  };
}

async function measureTipLatency(n) {
  const lat = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}/v1/tip`);
    await res.text();
    lat.push(performance.now() - t0);
  }
  lat.sort((a, b) => a - b);
  const middle = Math.floor(lat.length / 2);
  return lat.length % 2 === 0
    ? (lat[middle - 1] + lat[middle]) / 2
    : lat[middle];
}

async function getLatestCheckpoint() {
  const r = await httpJson('GET', '/v1/checkpoints/latest');
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`GET /v1/checkpoints/latest failed: ${r.status}`);
  return r.json;
}

async function downloadChain(tip) {
  const entries = [];
  let from = 1;
  while (from <= tip) {
    const to = Math.min(from + 499, tip);
    const res = await httpJson('GET', `/v1/entries?from=${from}&to=${to}`);
    if (res.status !== 200 || !res.json) throw new Error(`GET /v1/entries failed: ${res.status}`);
    const list = res.json.entries ?? [];
    for (const e of list) entries.push(e);
    if (list.length === 0) break;
    from += list.length;
  }
  return entries;
}

async function runIntegrity(relayPublicKey, expected, label) {
  const tip = (await httpJson('GET', '/v1/tip')).json.tipSequence;
  const t0 = performance.now();
  const entries = await downloadChain(tip);
  const downloadMs = performance.now() - t0;
  const checks = [];
  const add = (name, violations) => checks.push({ name, violations, ok: violations === 0 });

  let v = 0;
  for (const e of entries) if (!C.verifyEvent(e.event)) v += 1;
  add('event-signatures', v);

  v = 0;
  for (const e of entries) if (!C.verifyReceipt(e.receipt, relayPublicKey)) v += 1;
  add('receipt-signatures', v);

  v = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].receipt.sequence !== i + 1) v += 1;
  }
  if (entries.length !== tip) v += Math.abs(tip - entries.length);
  add('sequence-continuity', v);

  v = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const prev = i === 0 ? null : C.receiptHash(entries[i - 1].receipt);
    if (entries[i].receipt.previousReceiptHash !== prev) v += 1;
  }
  add('receipt-chain', v);

  v = 0;
  for (const e of entries) if (e.receipt.eventHash !== C.eventHash(e.event)) v += 1;
  add('receipt-event-hash', v);

  v = 0;
  const last = new Map();
  for (const e of entries) {
    const s = e.event.signer;
    const want = last.has(s) ? last.get(s) : null;
    if (e.event.prevHash !== want) v += 1;
    last.set(s, C.eventHash(e.event));
  }
  add('signer-prev-hash', v);

  v = 0;
  if (tip >= expected.checkpointEvery) {
    const cp = await getLatestCheckpoint();
    if (!cp) {
      v += 1;
    } else {
      const ok = C.verifyCheckpoint(
        { sequence: cp.sequence, receipt_hash: cp.receipt_hash, key_id: cp.key_id },
        cp.signature,
        relayPublicKey,
      );
      if (!ok) v += 1;
      const entry = entries[cp.sequence - 1];
      if (!entry || cp.receipt_hash !== C.receiptHash(entry.receipt)) v += 1;
    }
  }
  add('checkpoint', v);

  v = 0;
  const accountCreated = entries.filter((e) => e.event.type === 'AccountCreated').length;
  const dealAccepted = entries.filter((e) => e.event.type === 'DealAccepted').length;
  if (accountCreated !== expected.account201) v += 1;
  if (dealAccepted !== expected.completeDeals) v += 1;
  add('entry-counts', v);

  return { label, tip, entries: entries.length, downloadMs, checks, ok: checks.every((c) => c.ok) };
}

async function doRestart(ctx) {
  const { relayEnv, accounts, relayPublicKey, expected } = ctx;
  const before = await httpJson('GET', '/v1/tip');
  const cpBefore = await getLatestCheckpoint();
  const stopped = await stopRelay(relayProcess, 20000);
  if (stopped.exited) relayProcess = null;
  if (!stopped.graceful || !stopped.exited) {
    return { ok: false, stopOk: false, tipSame: false, stateSame: false, cpSame: false, extraOk: false, startupMs: 0, integrity: null };
  }

  relayProcess = startRelay(relayEnv);
  const startupMs = await waitForHealth(120000);
  const after = await httpJson('GET', '/v1/tip');
  const cpAfter = await getLatestCheckpoint();

  const tipSame = after.json.tipSequence === before.json.tipSequence;
  const stateSame = after.json.stateHash === before.json.stateHash;
  const cpSame = JSON.stringify(cpAfter) === JSON.stringify(cpBefore);

  const buyer = accounts[0];
  const seller = accounts[1];
  const body = {
    deal_id: uuidv4(),
    buyer: buyer.publicKey,
    seller: seller.publicKey,
    amount: 2,
    criteria_hash: randomHex(32),
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  const extra = await sendEvent(buyer, 'DealCreated', body, newStats());
  const tipFinal = (await httpJson('GET', '/v1/tip')).json.tipSequence;
  const extraOk = extra.ok && tipFinal === before.json.tipSequence + 1;
  const integrity = await runIntegrity(relayPublicKey, expected, 'after-restart');

  return {
    ok: stopped.graceful && stopped.exited && tipSame && stateSame && cpSame && extraOk && integrity.ok,
    stopOk: stopped.graceful && stopped.exited,
    startupMs,
    tipSame,
    stateSame,
    cpSame,
    extraOk,
    integrity,
    tip: tipFinal,
  };
}

async function doCrashTest(ctx) {
  const { relayEnv, accounts, relayPublicKey, cfg, expected } = ctx;
  const burstStats = newStats();
  let burstComplete = 0;
  const burstChild = relayProcess;
  const killPromise = (async () => {
    await sleep(1500);
    if (hasExited(burstChild)) return false;
    try {
      return burstChild.kill('SIGKILL');
    } catch {
      return false;
    }
  })();
  const burstStart = performance.now();
  const burstPromise = runPool(50, cfg.concurrency, async (i) => {
    if (await runDeal(i, burstStats, accounts)) burstComplete += 1;
  });
  const [burstResult, killResult] = await Promise.allSettled([burstPromise, killPromise]);
  const burstWall = performance.now() - burstStart;
  const didSendKill = killResult.status === 'fulfilled' && killResult.value;
  const exited = await waitForExit(burstChild, 5000);
  if (exited) relayProcess = null;
  if (!didSendKill || !exited) {
    throw new Error('crash test could not confirm SIGKILL and relay process exit');
  }
  if (burstResult.status === 'rejected') throw burstResult.reason;

  relayProcess = startRelay(relayEnv);
  const startupMs = await waitForHealth(120000, relayProcess);
  const tipResponse = await httpJson('GET', '/v1/tip');
  if (tipResponse.status !== 200 || !Number.isInteger(tipResponse.json?.tipSequence)) {
    throw new Error(`GET /v1/tip failed after crash: ${tipResponse.status}`);
  }
  const tip = tipResponse.json.tipSequence;
  const tipOk = tip >= burstStats.ackedMax;
  expected.completeDeals += burstComplete;
  const integrity = await runIntegrity(relayPublicKey, expected, 'after-crash');
  return {
    ok: tipOk && integrity.ok,
    maxAcked: burstStats.ackedMax,
    tip,
    tipOk,
    startupMs,
    burstComplete,
    burst: phaseSummary(burstStats, burstWall),
    integrity,
  };
}

function printReport(report) {
  const lines = [];
  const row = (key, value) => lines.push(`${key.padEnd(30)} ${value}`);
  const phase = (name, p) => {
    const codes = Object.entries(p.errors).map(([k, v]) => `${k}:${v}`).join(',') || 'none';
    const l = p.latency;
    row(name, `sent=${p.sent} ok=${p.ok201} errors=${p.errorCount} codes=${codes} wallMs=${p.wallMs.toFixed(0)} eps=${p.eventsPerSecond.toFixed(1)} p50=${fmt(l.p50)} p95=${fmt(l.p95)} p99=${fmt(l.p99)} max=${fmt(l.max)}`);
  };
  row('mode', report.config.mode);
  phase('accounts', report.accounts);
  phase('deals', report.deals);
  row('tip', report.tip);
  row('peak-rss-kb', report.peakRssKb === null ? 'n/a' : report.peakRssKb);
  row('chain-download-ms', `${report.chainDownloadMs.toFixed(0)} (entries=${report.integrity.entries})`);
  row('tip-latency-p50-ms', fmt(report.tipLatencyP50Ms));
  for (const c of report.integrity.checks) {
    row(`integrity.${c.name}`, `${c.ok ? 'OK' : 'FAIL'} (${c.violations})`);
  }
  if (report.restart) {
    row('restart.stop', report.restart.stopOk ? 'OK' : 'FAIL');
    row('restart.startupMs', report.restart.startupMs.toFixed(0));
    row('restart.tip', report.restart.tipSame ? 'OK' : 'FAIL');
    row('restart.stateHash', report.restart.stateSame ? 'OK' : 'FAIL');
    row('restart.checkpoint', report.restart.cpSame ? 'OK' : 'FAIL');
    row('restart.extraEvent', report.restart.extraOk ? 'OK' : 'FAIL');
    if (report.restart.integrity) {
      for (const c of report.restart.integrity.checks) {
        row(`restart.integrity.${c.name}`, `${c.ok ? 'OK' : 'FAIL'} (${c.violations})`);
      }
    }
  }
  if (report.crash) {
    row('crash.burst', `sent=${report.crash.burst.sent} ok=${report.crash.burst.ok201} errors=${report.crash.burst.errorCount}`);
    row('crash.maxAcked', report.crash.maxAcked);
    row('crash.tip', `${report.crash.tip} ${report.crash.tipOk ? 'OK' : 'FAIL'}`);
    row('crash.startupMs', report.crash.startupMs.toFixed(0));
    for (const c of report.crash.integrity.checks) {
      row(`crash.integrity.${c.name}`, `${c.ok ? 'OK' : 'FAIL'} (${c.violations})`);
    }
  }
  row('result', report.ok ? 'OK' : 'FAIL');
  process.stdout.write(lines.join('\n') + '\n');
}

async function main() {
  try {
    const cfg = parseArgs(process.argv.slice(2));
    validate(cfg);
    if (signalExitCode !== null) return signalExitCode;

    if (!existsSync(RELAY_MAIN)) {
      throw new SetupError('Build the ledger first: npm run build in skill-exchange-ledger');
    }
    if (cfg.mode === 'postgres') {
      if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('postgres://')) {
        throw new SetupError('DATABASE_URL must be a postgres:// URL in postgres mode');
      }
      try {
        new URL(process.env.DATABASE_URL);
      } catch {
        throw new SetupError('DATABASE_URL must be a valid postgres:// URL');
      }
    }

    C = await import(pathToFileURL(join(L, 'dist', 'packages', 'crypto', 'src', 'index.js')).href);
    keepTemp = cfg.keep;
    tempDir = workdir('load');

    const accounts = [];
    for (let i = 0; i < cfg.accounts; i += 1) {
      const id = C.createIdentity();
      accounts.push({ index: i, privateKey: id.privateKey, publicKey: id.publicKey, prevHash: null, lock: Promise.resolve() });
    }
    const multisig = [C.createIdentity(), C.createIdentity(), C.createIdentity()];

    const cfgPath = join(tempDir, 'genesis-config.json');
    const genesisPath = join(tempDir, 'genesis.json');
    const keyPath = join(tempDir, 'relay-key.json');
    const genesisConfig = {
      policyId: 'load-test',
      multisigMembers: multisig.map((m) => m.publicKey),
      inviters: [accounts[0].publicKey],
      genesisAccounts: accounts.map((a) => a.publicKey),
      checkers: [accounts[0].publicKey],
      issuancePolicyIds: ['beta'],
      jurorPayoutPerCase: 10,
      limits: { maxIssuancePerEvent: 1000, maxTreasurySpendPerEvent: 1000, maxDealAmount: 500 },
      treasury: 100000,
      grants: accounts.map((a, i) => ({ recipient: a.publicKey, amount: 1000, nonce: `grant-${i}` })),
    };
    writeFileSync(cfgPath, JSON.stringify(genesisConfig, null, 2));

    const kg = await runNode([ADMIN_CLI, 'keygen', '--out', keyPath]);
    const keyMatch = /public_key=(\S+)/.exec(kg.stdout);
    if (kg.code !== 0 || !keyMatch) {
      throw new SetupError(`relay keygen failed: ${kg.stderr}`);
    }
    const relayPublicKey = keyMatch[1];

    const gen = await runNode([ADMIN_CLI, 'genesis', 'build', '--config', cfgPath, '--relay-public-key', relayPublicKey, '--out', genesisPath]);
    if (gen.code !== 0) {
      throw new SetupError(`genesis build failed: ${gen.stderr}`);
    }
    const genesisSha = createHash('sha256').update(readFileSync(genesisPath)).digest('hex');

    const relayEnv = {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      RELAY_MODE: cfg.mode,
      GENESIS_FILE: genesisPath,
      GENESIS_SHA256: genesisSha,
      RELAY_KEY_FILE: keyPath,
      PORT: '3055',
      RATE_PER_IP: '1000000',
      RATE_PER_KEY: '1000000',
      CHECKPOINT_EVERY: String(cfg.checkpointEvery),
    };
    if (cfg.mode === 'postgres') relayEnv.DATABASE_URL = process.env.DATABASE_URL;

    if (cfg.mode === 'postgres') {
      if (cfg.resetDb) {
        await resetDatabase();
      } else if (!(await isDatabaseEmpty())) {
        throw new SetupError('Database is not empty; use --reset-db on a throwaway database');
      }
    }

    if (signalExitCode !== null) return signalExitCode;
    try {
      relayProcess = startRelay(relayEnv);
      await waitForHealth(120000, relayProcess);
    } catch (err) {
      throw new SetupError(`Failed to start relay: ${err.message}`);
    }

    const accountStats = newStats();
    let t0 = performance.now();
    await runPool(accounts.length, cfg.concurrency, async (i) => {
      await sendEvent(accounts[i], 'AccountCreated', {
        pubkey: accounts[i].publicKey,
        recovery_commitment: C.recoveryCommitment(accounts[i].publicKey),
        invite_ref: null,
      }, accountStats);
    });
    const accountWall = performance.now() - t0;

    const dealStats = newStats();
    let completeDeals = 0;
    t0 = performance.now();
    await runPool(cfg.deals, cfg.concurrency, async (i) => {
      if (await runDeal(i, dealStats, accounts)) completeDeals += 1;
    });
    const dealWall = performance.now() - t0;

    const peakRssKb = readPeakRss(relayProcess.pid);
    const expected = { account201: accountStats.ok201, completeDeals, checkpointEvery: cfg.checkpointEvery };
    const integrity = await runIntegrity(relayPublicKey, expected, 'initial');

    let restart = null;
    let crash = null;
    const ctx = { relayEnv, accounts, relayPublicKey, cfg, expected };
    if (cfg.mode === 'postgres') {
      restart = await doRestart(ctx);
      if (cfg.crashTest) crash = await doCrashTest(ctx);
    }

    const finalTipResponse = await httpJson('GET', '/v1/tip');
    if (finalTipResponse.status !== 200 || !Number.isInteger(finalTipResponse.json?.tipSequence)) {
      throw new Error(`GET /v1/tip failed while reading final tip: ${finalTipResponse.status}`);
    }
    const tip = finalTipResponse.json.tipSequence;
    const tipLatencyP50 = await measureTipLatency(50);

    const accountSummary = phaseSummary(accountStats, accountWall);
    const dealSummary = phaseSummary(dealStats, dealWall);
    const loadOk = accountSummary.ok201 === accountSummary.sent && dealSummary.ok201 === dealSummary.sent && accountSummary.errorCount === 0 && dealSummary.errorCount === 0;
    const overallOk = integrity.ok && loadOk && (restart === null || restart.ok) && (crash === null || crash.ok);

    const report = {
      config: cfg,
      accounts: accountSummary,
      deals: dealSummary,
      tip,
      peakRssKb,
      tipLatencyP50Ms: tipLatencyP50,
      chainDownloadMs: integrity.downloadMs,
      integrity,
      restart,
      crash,
      ok: overallOk,
    };
    writeFileSync(cfg.json, JSON.stringify(report, null, 2));
    printReport(report);
    return signalExitCode ?? (overallOk ? 0 : 1);
  } finally {
    if (relayProcess) {
      const child = relayProcess;
      const stopped = await stopRelay(child, 5000);
      if (stopped.exited) relayProcess = null;
    }
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`${err instanceof SetupError ? err.message : (err?.stack ?? String(err))}\n`);
  process.exit(signalExitCode ?? (err instanceof SetupError ? 2 : 1));
});
