import { L, workdir } from './paths.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const T = workdir('reports');
const { createIdentity } = await import(`${L}/dist/packages/crypto/src/index.js`);
const { circularTradingReport } = await import(`${L}/dist/packages/listener/src/circular-trading-report.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = (n, ok, i = '') => { if (!ok) process.exitCode = 1; console.log(ok ? 'OK  ' : 'FAIL', n, i); };
rmSync(T, { recursive: true, force: true }); mkdirSync(T, { recursive: true });
const run = (a) => spawnSync('node', [`${L}/dist/apps/relay/admin-cli.js`, ...a], { encoding: 'utf8', cwd: T });
const relayPub = /public_key=(\S+)/.exec(run(['keygen', '--out', `${T}/relay.key`]).stdout)[1];
const ids = Array.from({ length: 7 }, createIdentity);
writeFileSync(`${T}/cfg.json`, JSON.stringify({ policyId: 'rep', multisigMembers: ids.slice(0, 3).map((x) => x.publicKey), inviters: [ids[3].publicKey], genesisAccounts: [ids[4].publicKey, ids[5].publicKey], checkers: [ids[6].publicKey], issuancePolicyIds: ['beta'], jurorPayoutPerCase: 10, limits: { maxIssuancePerEvent: 1000, maxTreasurySpendPerEvent: 1000, maxDealAmount: 1000 }, treasury: 1000, grants: [] }));
const sha = /GENESIS_SHA256=(\S+)/.exec(run(['genesis', 'build', '--config', `${T}/cfg.json`, '--relay-public-key', relayPub, '--out', `${T}/genesis.json`]).stdout)[1];
const listener = createIdentity();
writeFileSync(`${T}/allow.json`, JSON.stringify([{ pubkey: listener.publicKey, valid_from_sequence: 1, valid_to_sequence: 1000 }]));
const [a, b] = [ids[4], ids[5]].sort((x, y) => Buffer.compare(Buffer.from(x.publicKey), Buffer.from(y.publicKey)));
const h = (c) => createHash('sha256').update(c).digest('hex');
const mkReport = (n) => circularTradingReport({ ruleId: 'circular-trading-pair', accountA: a.publicKey, accountB: b.publicKey, forward: { dealId: `d${n}a`, from: a.publicKey, to: b.publicKey, amount: 5, acceptedAt: '2026-10-30T10:00:00.000Z', sequence: 1, releaseEventHash: h(`f${n}`) }, reverse: { dealId: `d${n}b`, from: b.publicKey, to: a.publicKey, amount: 5, acceptedAt: '2026-10-30T10:01:00.000Z', sequence: 2, releaseEventHash: h(`r${n}`) } }, 3, h('receipt'), listener.publicKey, '2026-10-30T10:02:00.000Z', listener.privateKey);
// Sink: first 503, then 200
let sinkMode = 503; const got = [];
const sink = createServer((req, res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { got.push(JSON.parse(d).finding_id + ':' + sinkMode); res.statusCode = sinkMode; res.end('{}'); }); });
await new Promise((r) => sink.listen(9911, '127.0.0.1', r));
const start = (extra) => { const p = spawn('node', [`${L}/dist/apps/relay/main.js`], { cwd: T, env: { ...process.env, RELAY_MODE: 'memory', GENESIS_FILE: `${T}/genesis.json`, GENESIS_SHA256: sha, RELAY_KEY_FILE: `${T}/relay.key`, PORT: '3000', ...extra }, stdio: ['ignore', 'pipe', 'inherit'] }); p.stdout.on('data', (d) => process.stdout.write('  [relay] ' + d)); return p; };
const wait = async () => { for (let i = 0; i < 30; i++) { await sleep(300); try { if ((await fetch('http://127.0.0.1:3000/v1/health')).ok) return; } catch {} } };
const post = async (r) => { const x = await fetch('http://127.0.0.1:3000/v1/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) }); return [x.status, await x.json()]; };
// 1 disabled
let p = start({}); await wait();
rec('without configuration: POST /v1/reports = 404', (await post(mkReport(1)))[0] === 404); p.kill(); await sleep(500);
// 2 enabled with delivery
const env = { LISTENER_ALLOWLIST_FILE: `${T}/allow.json`, REPORT_OUTBOX_FILE: `${T}/reports.ndjson`, REPORT_DELIVERY_URL: 'http://127.0.0.1:9911/in' };
p = start(env); await wait();
const r1 = mkReport(1);
let [s1] = await post(r1); rec('enabled: new report = 201', s1 === 201);
let [s2, j2] = await post(r1); rec('duplicate = 200 duplicate=true', s2 === 200 && j2.duplicate === true);
const par = await Promise.all(Array.from({ length: 6 }, () => post(mkReport(2)))); rec('6 parallel identical reports: exactly one 201', par.filter((x) => x[0] === 201).length === 1 && par.filter((x) => x[0] === 200).length === 5, par.map((x) => x[0]).join(','));
const forged = { ...mkReport(3), finding_id: h('x') }; rec('forged finding_id = 400', (await post(forged))[0] === 400);
await sleep(1500); // sink answers 503 -> delivery stays open (retryable, 5 attempts with backoff still running)
p.kill(); await sleep(800);
// 3 corrupt file (truncated line), sink healthy, restart
appendFileSync(`${T}/reports.ndjson`, '{"finding_id":"cc'); sinkMode = 200; got.length = 0;
p = start(env); await wait(); await sleep(1500);
const lines = readFileSync(`${T}/reports.ndjson`, 'utf8').split('\n').filter(Boolean);
rec('after restart: known reports stay duplicates despite truncated line', (await post(r1))[0] === 200 && (await post(mkReport(2)))[0] === 200);
rec('after restart: open reports were delivered again', got.some((g) => g.startsWith(r1.finding_id)), got.map((g) => g.slice(0, 8) + g.slice(64)).join(' '));
const r4 = mkReport(4); rec('new report after corrupted line = 201', (await post(r4))[0] === 201);
await sleep(800);
const ids2 = readFileSync(`${T}/reports.ndjson`, 'utf8').split('\n').filter((l) => l.startsWith('{"report_version"')).map((l) => JSON.parse(l).finding_id);
rec('new report is readable in the file', ids2.includes(r4.finding_id), `${ids2.length} valid lines`);
const done = readFileSync(`${T}/reports.ndjson.done`, 'utf8').split('\n').filter(Boolean);
rec('.done contains delivered reports', done.length >= 3, `${done.length} entries`);
p.kill(); sink.close(); process.exit(process.exitCode ?? 0);
