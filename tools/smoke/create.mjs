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
await sc.sync();
const cr = await sc.consentDeal(dealEntry.event.payload.deal_id);
rec('Seller can consent to the UI-created deal (client)', cr.ok, cr.ok ? '' : JSON.stringify(cr.error));

// --- buyer funds escrow via the UI ---
const dealId = dealEntry.event.payload.deal_id;
await page.goto('http://127.0.0.1:8080/#/deals'); await sleep(1500);
await page.click('button:has-text("Fund escrow")'); await sleep(2500);
const escrowEntry = (await entries()).find((e) => e.event.type === 'EscrowFunded' && e.event.payload.deal_id === dealId);
rec('EscrowFunded on the relay (from = UI key, amount 50)', escrowEntry !== undefined && escrowEntry.event.payload.from === aPk && escrowEntry.event.payload.amount === 50, JSON.stringify(escrowEntry?.event.payload));

// seller submits the deliverable (script)
const contentHash = createHash('sha256').update('deliverable-1').digest('hex');
await sc.sync();
const dr = await sc.submit('DeliverableSubmitted', { deal_id: dealId, content_hash: contentHash, precheck_ref: null });
rec('Seller can submit the deliverable (client)', dr.ok, dr.ok ? '' : JSON.stringify(dr.error));

// --- buyer accepts via the UI ---
await page.goto('http://127.0.0.1:8080/#/deals'); await sleep(1500);
await page.click('button:has-text("Accept")'); await sleep(2500);
const acceptEntry = (await entries()).find((e) => e.event.type === 'DealAccepted' && e.event.payload.deal_id === dealId);
rec('DealAccepted on the relay (by = UI key)', acceptEntry !== undefined && acceptEntry.event.payload.by === aPk, JSON.stringify(acceptEntry?.event.payload));

// --- a second deal to exercise reject + dispute through the UI ---
await page.goto('http://127.0.0.1:8080/#/deals'); await sleep(1500);
await page.fill('#deal-seller', seller.publicKey); await page.fill('#deal-amount', '60'); await page.fill('#deal-days', '7');
await page.fill('#deal-criteria', 'Deliver a one-page landing page');
await page.click('#deal-create'); await sleep(3500);
const dealEntries = (await entries()).filter((e) => e.event.type === 'DealCreated');
const deal2 = dealEntries.find((e) => e.event.payload.deal_id !== dealId);
rec('Second DealCreated on the relay', deal2 !== undefined, JSON.stringify(deal2?.event.payload));
const dealId2 = deal2.event.payload.deal_id;
await sc.sync();
const cr2 = await sc.consentDeal(dealId2);
rec('Seller consents to the second deal (client)', cr2.ok, cr2.ok ? '' : JSON.stringify(cr2.error));
await page.goto('http://127.0.0.1:8080/#/deals'); await sleep(1500);
const row2 = page.locator('main table tbody tr', { hasText: dealId2 });
await row2.locator('button:has-text("Fund escrow")').click(); await sleep(2500);
const escrow2 = (await entries()).find((e) => e.event.type === 'EscrowFunded' && e.event.payload.deal_id === dealId2);
rec('EscrowFunded for the second deal', escrow2 !== undefined, JSON.stringify(escrow2?.event.payload));
await sc.sync();
const dr2 = await sc.submit('DeliverableSubmitted', { deal_id: dealId2, content_hash: createHash('sha256').update('deliverable-2').digest('hex'), precheck_ref: null });
rec('Seller submits deliverable for the second deal (client)', dr2.ok, dr2.ok ? '' : JSON.stringify(dr2.error));
await page.goto('http://127.0.0.1:8080/#/deals'); await sleep(1500);
const row2b = page.locator('main table tbody tr', { hasText: dealId2 });
await row2b.locator('input').fill('Does not match the criteria');
await row2b.locator('button:has-text("Reject")').click(); await sleep(2500);
const rejectEntry = (await entries()).find((e) => e.event.type === 'DealRejected' && e.event.payload.deal_id === dealId2);
rec('DealRejected on the relay with a reason_hash', rejectEntry !== undefined && /^[a-f0-9]{64}$/.test(rejectEntry.event.payload.reason_hash ?? ''), JSON.stringify(rejectEntry?.event.payload));
const reasonSecrets = JSON.parse((await page.evaluate(() => localStorage.getItem('skillx.reason-secrets.v1'))) ?? '[]');
rec('Rejection reason and salt stored in the browser', reasonSecrets.length === 1 && reasonSecrets[0].deal_id === dealId2 && reasonSecrets[0].reason_text === 'Does not match the criteria');
await page.goto('http://127.0.0.1:8080/#/deals'); await sleep(1500);
const row2c = page.locator('main table tbody tr', { hasText: dealId2 });
await row2c.locator('button:has-text("Open dispute")').click(); await sleep(2500);
const disputeEntry = (await entries()).find((e) => e.event.type === 'DisputeOpened' && e.event.payload.deal_id === dealId2);
rec('DisputeOpened on the relay (by = UI key)', disputeEntry !== undefined && disputeEntry.event.payload.by === aPk, JSON.stringify(disputeEntry?.event.payload));

console.log('consoleErrors', errs);
await browser.close(); process.exit(process.exitCode ?? 0);
