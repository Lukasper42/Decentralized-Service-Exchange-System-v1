// Creates AccountCreated (A, B) and a deal (buyer B, seller A) on the running relay. For the manual smoke test only.
// Usage (in the skill-exchange-ledger folder): node ../tools/manual/deal-test.mjs <A-pubkey> <vault-file> <vault-password> [relay-url]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const [a, vaultPath, password, relayUrl = 'http://127.0.0.1:3000'] = process.argv.slice(2);
if (!a || !vaultPath || !password) { console.error('Usage: node ../tools/manual/deal-test.mjs <A-pubkey> <vault-file> <vault-password> [relay-url]'); process.exit(1); }
const imp = (p) => import(pathToFileURL(resolve(p)).href);
const { recoveryCommitment } = await imp('dist/packages/crypto/src/index.js');
const { HttpTransport, LedgerClient, keyPairSigner } = await imp('dist/packages/client/src/index.js');
const { Projector } = await imp('dist/packages/relay/src/index.js');
const { loadGenesis } = await imp('dist/apps/relay/genesis.js');
const vaultMod = await imp('../skillx-web/dist/vault.js');
const vault = { publicKey: a, file: JSON.parse(readFileSync(vaultPath, 'utf8')) };
const unlocked = await vaultMod.unlock(globalThis.crypto, vault, password);
if (!unlocked.ok) { console.error('Could not unlock the vault:', unlocked.error?.message ?? 'wrong password?'); process.exit(1); }
const seller = { publicKey: a, privateKey: unlocked.value };
const buyer = JSON.parse(readFileSync('b-key.json', 'utf8'));
const sha = createHash('sha256').update(readFileSync('genesis.json', 'utf8')).digest('hex');
const cfg = loadGenesis({ path: 'genesis.json', expectedSha256: sha, files: { readText: (p) => readFileSync(p, 'utf8') }, policyDirectory: null });
const mk = (who) => new LedgerClient({ transport: new HttpTransport({ baseUrl: relayUrl }), projector: new Projector(cfg), clock: { nowMs: () => Date.now() }, signer: keyPairSigner(who) });
let failed = false;
const show = (name, res) => { console.log(res.ok ? 'OK  ' : 'FAIL', name, res.ok ? '' : JSON.stringify(res.error)); if (!res.ok) failed = true; };
for (const [n, who] of [['A (seller)', seller], ['B (buyer)', buyer]]) {
  const c = mk(who); await c.sync();
  show(`AccountCreated ${n}`, await c.submit('AccountCreated', { pubkey: who.publicKey, recovery_commitment: recoveryCommitment(who.publicKey), invite_ref: null }));
}
const bc = mk(buyer); await bc.sync();
show('DealCreated (Betrag 100)', await bc.submit('DealCreated', { deal_id: '00000000-0000-4000-8000-000000000001', buyer: buyer.publicKey, seller: seller.publicKey, amount: 100, criteria_hash: 'c'.repeat(64), deadline: new Date(Date.now() + 30 * 864e5).toISOString() }));
process.exit(failed ? 1 : 0);
