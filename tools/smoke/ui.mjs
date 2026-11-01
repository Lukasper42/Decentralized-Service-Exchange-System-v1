import { L, W, workdir, loadChromium } from './paths.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
const T = workdir('ui');
const chromium = await loadChromium();
const { createIdentity, recoveryCommitment } = await import(`${L}/dist/packages/crypto/src/index.js`);
const { HttpTransport, LedgerClient, keyPairSigner } = await import(`${L}/dist/packages/client/src/index.js`);
const { loadGenesis } = await import(`${L}/dist/apps/relay/genesis.js`);
const { Projector } = await import(`${L}/dist/packages/relay/src/index.js`).catch(() => ({}));
const vaultMod = await import(`${W}/dist/vault.js`);
const results = [];
const rec = (name, ok, info = '') => { results.push({ name, ok, info }); if (!ok) process.exitCode = 1; console.log(ok ? 'OK  ' : 'FAIL', name, info); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const cleanup = () => procs.forEach((p) => p.kill());
process.on('exit', cleanup);

// 1 web server
const web = spawn('node', ['serve.mjs', '8080'], { cwd: W, stdio: 'inherit' }); procs.push(web);
await sleep(800);
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
await page.goto('http://127.0.0.1:8080/#/identity');
const PW = 'correct-horse-battery-staple';
await page.fill('#pw1', PW); await page.fill('#pw2', PW);
await page.click('button:has-text("Create key")');
await page.waitForFunction(() => document.querySelector('code')?.textContent?.length > 20, null, { timeout: 30000 });
const sellerPk = (await page.textContent('code')).trim();
rec('UI: create key', sellerPk.length > 20, sellerPk.slice(0, 12));
const stored = await page.evaluate(() => localStorage.getItem('skillx.vault.v1'));
const vaultJson = JSON.parse(stored);
const vault = vaultJson.file ? vaultJson : { publicKey: sellerPk, file: vaultJson };
const unl = await vaultMod.unlock(globalThis.crypto, vault, PW);
const sellerSk = unl.ok ? unl.value : null;
rec('Vault decrypted (test access)', sellerSk !== null);
const seller = { publicKey: sellerPk, privateKey: sellerSk };

// 2 genesis
const buyer = createIdentity(), m = [createIdentity(), createIdentity(), createIdentity()], inviter = createIdentity(), checker = createIdentity();
rmSync(`${T}/relay`, { recursive: true, force: true }); mkdirSync(`${T}/relay`, { recursive: true });
const run = (args) => spawnSync('node', [`${L}/dist/apps/relay/admin-cli.js`, ...args], { encoding: 'utf8', cwd: `${T}/relay` });
let r = run(['keygen', '--out', `${T}/relay/relay.key`]); console.log(r.stdout, r.stderr);
const relayPub = /public_key=(\S+)/.exec(r.stdout)[1];
writeFileSync(`${T}/relay/cfg.json`, JSON.stringify({
  policyId: 'smoke-1', multisigMembers: m.map((x) => x.publicKey), inviters: [inviter.publicKey],
  genesisAccounts: [buyer.publicKey, seller.publicKey], checkers: [checker.publicKey], issuancePolicyIds: ['beta'],
  jurorPayoutPerCase: 10, limits: { maxIssuancePerEvent: 100000, maxTreasurySpendPerEvent: 100000, maxDealAmount: 100000 },
  treasury: 1000000, grants: [{ recipient: buyer.publicKey, amount: 10000, nonce: 'a'.repeat(64) }, { recipient: seller.publicKey, amount: 10000, nonce: 'b'.repeat(64) }],
}, null, 2));
r = run(['genesis', 'build', '--config', `${T}/relay/cfg.json`, '--relay-public-key', relayPub, '--out', `${T}/relay/genesis.json`]);
console.log(r.stdout, r.stderr);
const sha = /GENESIS_SHA256=(\S+)/.exec(r.stdout)?.[1];
rec('Genesis built', !!sha, sha?.slice(0, 12));
if (!sha) { await browser.close(); process.exit(1); }

// 3 relay
const startRelay = () => { const p = spawn('node', [`${L}/dist/apps/relay/main.js`], { cwd: `${T}/relay`, env: { ...process.env, RELAY_MODE: 'memory', GENESIS_FILE: `${T}/relay/genesis.json`, GENESIS_SHA256: sha, RELAY_KEY_FILE: `${T}/relay/relay.key`, ALLOWED_ORIGIN: 'http://127.0.0.1:8080', PORT: '3000' }, stdio: ['ignore', 'ignore', 'inherit'] }); procs.push(p); return p; };
let relay = startRelay();
let healthy = false;
for (let i = 0; i < 30 && !healthy; i++) { await sleep(300); try { healthy = (await fetch('http://127.0.0.1:3000/v1/health')).ok; } catch {} }
rec('Relay health', healthy);
if (!healthy) { await browser.close(); process.exit(1); }

// 4 script clients
const projCfg = loadGenesis({ path: `${T}/relay/genesis.json`, expectedSha256: sha, files: { readText: (p) => readFileSync(p, 'utf8') }, policyDirectory: null });
const mk = (who) => new LedgerClient({ transport: new HttpTransport({ baseUrl: 'http://127.0.0.1:3000' }), projector: new Projector(projCfg), clock: { nowMs: () => Date.now() }, signer: keyPairSigner(who) });
for (const [n, who] of [['buyer', buyer], ['seller', seller]]) {
  const c = mk(who); await c.sync();
  const res = await c.submit('AccountCreated', { pubkey: who.publicKey, recovery_commitment: recoveryCommitment(who.publicKey), invite_ref: null });
  rec(`AccountCreated ${n}`, res.ok, res.ok ? '' : JSON.stringify(res.error));
}
const bc = mk(buyer); await bc.sync();
const dealId = '00000000-0000-4000-8000-000000000001';
const h64 = 'c'.repeat(64);
const dc = await bc.submit('DealCreated', { deal_id: dealId, buyer: buyer.publicKey, seller: seller.publicKey, amount: 1000, criteria_hash: h64, deadline: new Date(Date.now() + 30 * 864e5).toISOString() });
rec('DealCreated (script)', dc.ok, dc.ok ? '' : JSON.stringify(dc.error));

// 5 UI
await page.goto('http://127.0.0.1:8080/#/status');
await page.fill('#relay-url', 'http://127.0.0.1:3000');
await page.screenshot({ path: `${T}/s1.png` });
console.log((await page.locator('button').allTextContents()).join(' | '));
writeFileSync(`${T}/state.json`, JSON.stringify({ sellerPk, dealId }));
globalThis.__ctx = { startRelay, getRelay: () => relay, setRelay: (p) => { relay = p; }, relayPub, genesisSha: sha, page, browser, PW, rec, results, consoleErrors, T, dealId, sellerPk, buyer, seller, mk, bc };
const sub = await import('./ui-steps.mjs').catch((e) => { console.log('no ui-steps', e.message); return null; });
if (sub) await sub.default(globalThis.__ctx);
await browser.close(); cleanup();
console.log(JSON.stringify(results, null, 1)); console.log('consoleErrors', consoleErrors);
