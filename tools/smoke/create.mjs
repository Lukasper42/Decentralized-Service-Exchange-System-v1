import { L, W, workdir, loadChromium } from './paths.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
const T = workdir('create');
const chromium = await loadChromium();
const { createIdentity, recoveryCommitment } = await import(`${L}/dist/packages/crypto/src/index.js`);
const { HttpTransport, LedgerClient, keyPairSigner } = await import(`${L}/dist/packages/client/src/index.js`);
const { loadGenesis } = await import(`${L}/dist/apps/relay/genesis.js`);
const { Projector } = await import(`${L}/dist/packages/relay/src/index.js`);
const rec = (n, ok, i = '') => { if (!ok) process.exitCode = 1; console.log(ok ? 'OK  ' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = []; process.on('exit', () => procs.forEach((p) => p.kill()));
const web = spawn('node', ['serve.mjs', '8080'], { cwd: W, stdio: 'ignore' }); procs.push(web);
await sleep(800);
const browser = await chromium.launch(); const page = await (await browser.newContext()).newPage();
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://127.0.0.1:8080/#/identity');
const PW = 'correct-horse-battery-staple';
await page.fill('#pw1', PW); await page.fill('#pw2', PW);
await page.click('button:has-text("Create key")');
await page.waitForFunction(() => document.querySelector('code')?.textContent?.length > 20, null, { timeout: 30000 });
const aPk = (await page.textContent('code')).trim();
const seller = createIdentity();
rmSync(T, { recursive: true, force: true }); mkdirSync(T, { recursive: true });
const run = (a) => spawnSync('node', [`${L}/dist/apps/relay/admin-cli.js`, ...a], { encoding: 'utf8', cwd: T });
const relayPub = /public_key=(\S+)/.exec(run(['keygen', '--out', `${T}/relay.key`]).stdout)[1];
const m = [createIdentity(), createIdentity(), createIdentity()];
writeFileSync(`${T}/cfg.json`, JSON.stringify({ policyId: 'create-smoke', multisigMembers: m.map((x) => x.publicKey), inviters: [aPk], genesisAccounts: [aPk, seller.publicKey], checkers: [aPk], issuancePolicyIds: ['beta'], jurorPayoutPerCase: 10, limits: { maxIssuancePerEvent: 1000, maxTreasurySpendPerEvent: 1000, maxDealAmount: 500 }, treasury: 10000, grants: [{ recipient: aPk, amount: 1000, nonce: 'grant-a' }] }));
run(['genesis', 'build', '--config', `${T}/cfg.json`, '--relay-public-key', relayPub, '--out', `${T}/genesis.json`]);
const gtext = readFileSync(`${T}/genesis.json`, 'utf8'); const sha = createHash('sha256').update(gtext).digest('hex');
const relay = spawn('node', [`${L}/dist/apps/relay/main.js`], { cwd: T, env: { ...process.env, RELAY_MODE: 'memory', GENESIS_FILE: `${T}/genesis.json`, GENESIS_SHA256: sha, RELAY_KEY_FILE: `${T}/relay.key`, ALLOWED_ORIGIN: 'http://127.0.0.1:8080', PORT: '3000', RATE_PER_IP: '1000', RATE_PER_KEY: '1000' }, stdio: ['ignore', 'ignore', 'inherit'] }); procs.push(relay);
let ok = false; for (let i = 0; i < 30 && !ok; i++) { await sleep(300); try { ok = (await fetch('http://127.0.0.1:3000/v1/health')).ok; } catch {} }
rec('Genesis (UI key and seller are genesis accounts) + relay', ok);
if (!ok) process.exit(1);
const entries = async () => (await (await fetch('http://127.0.0.1:3000/v1/entries?from=1&to=200')).json()).entries;
const countType = async (t) => (await entries()).filter((e) => e.event.type === t).length;
// seller registers by script (before the UI connects: the UI only knows what it has synced)
const projCfg = loadGenesis({ path: `${T}/genesis.json`, expectedSha256: sha, files: { readText: (p) => readFileSync(p, 'utf8') }, policyDirectory: null });
const sc = new LedgerClient({ transport: new HttpTransport({ baseUrl: 'http://127.0.0.1:3000' }), projector: new Projector(projCfg), clock: { nowMs: () => Date.now() }, signer: keyPairSigner(seller) });
await sc.sync();
const sr = await sc.submit('AccountCreated', { pubkey: seller.publicKey, recovery_commitment: recoveryCommitment(seller.publicKey), invite_ref: null });
rec('AccountCreated seller (script)', sr.ok, sr.ok ? '' : JSON.stringify(sr.error));
// connect and unlock
await page.goto('http://127.0.0.1:8080/#/status');
await page.fill('#relay-url', 'http://127.0.0.1:3000'); await page.fill('#relay-pubkey', relayPub);
await page.click('button:has-text("Save and connect")'); await sleep(2500);
await page.goto('http://127.0.0.1:8080/#/identity'); await page.fill('#unlock-pw', PW); await page.click('button:has-text("Unlock")');
await page.waitForFunction(() => /unlocked: yes/.test(document.querySelector('main').innerText), null, { timeout: 30000 });
// deals form hidden before registration
await page.goto('http://127.0.0.1:8080/#/deals'); await sleep(800);
rec('Deal form hidden while the key is not registered', !(await page.locator('#deal-create').isVisible()));
// register
await page.goto('http://127.0.0.1:8080/#/account'); await sleep(800);
rec('Register button visible for an unregistered key', await page.locator('#register-key').isVisible());
await page.click('#register-key'); await sleep(3000);
rec('AccountCreated for the UI key on the relay', (await entries()).some((e) => e.event.type === 'AccountCreated' && e.event.payload.pubkey === aPk && e.event.payload.invite_ref === null));
rec('Register section hidden after registration', !(await page.locator('#register-key').isVisible()));
// deals
await page.goto('http://127.0.0.1:8080/#/deals'); await sleep(1500);
rec('Deal form visible for a registered key', await page.locator('#deal-create').isVisible());
// invalid amount: no event, readable error
await page.fill('#deal-seller', seller.publicKey); await page.fill('#deal-amount', '1'); await page.fill('#deal-criteria', 'Deliver a logo as SVG');
await page.click('#deal-create'); await sleep(800);
const errText = await page.locator('main').innerText();
rec('Amount 1 is rejected in the UI with an AMOUNT error', /\[AMOUNT\]/.test(errText), errText.replace(/\n+/g, ' ').slice(0, 200));
rec('No DealCreated after the rejected input', (await countType('DealCreated')) === 0);
rec('Typed text survives the error', (await page.inputValue('#deal-criteria')) === 'Deliver a logo as SVG');
// valid deal
await page.fill('#deal-amount', '50'); await page.fill('#deal-days', '7');
await page.click('#deal-create'); await sleep(3500);
const dealEntry = (await entries()).find((e) => e.event.type === 'DealCreated');
rec('DealCreated on the relay (buyer = UI key, seller, amount 50)', dealEntry !== undefined && dealEntry.event.payload.buyer === aPk && dealEntry.event.payload.seller === seller.publicKey && dealEntry.event.payload.amount === 50, JSON.stringify(dealEntry?.event.payload));
const secrets = JSON.parse((await page.evaluate(() => localStorage.getItem('skillx.deal-secrets.v1'))) ?? '[]');
rec('Salt and criteria stored in the browser for this deal', secrets.length === 1 && secrets[0].deal_id === dealEntry?.event.payload.deal_id && secrets[0].criteria_text === 'Deliver a logo as SVG' && /^[a-f0-9]{64}$/.test(secrets[0].salt));
if (dealEntry && secrets[0]) {
  const { commitment } = await import(`${L}/dist/packages/crypto/src/index.js`);
  const h = commitment('criteria', Buffer.from(secrets[0].salt, 'hex'), Buffer.from(secrets[0].criteria_text, 'utf8'));
  rec('criteria_hash equals the reference commitment of salt + text', h === dealEntry.event.payload.criteria_hash);
}
const rows = await page.locator('main table tbody tr').allInnerTexts();
rec('Deal listed in the deals view', rows.some((r) => r.includes(String(dealEntry?.event.payload.deal_id ?? 'x'))), rows.join(' | ').slice(0, 200));
// seller consents (script) to show the deal is a real, usable deal
const cr = await sc.sync() && await sc.consentDeal(dealEntry.event.payload.deal_id);
rec('Seller can consent to the UI-created deal (client)', cr.ok, cr.ok ? '' : JSON.stringify(cr.error));
console.log('consoleErrors', errs);
await browser.close(); process.exit(process.exitCode ?? 0);
