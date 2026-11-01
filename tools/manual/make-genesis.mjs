import { generateKeyPairSync } from 'node:crypto';
// Run in the skill-exchange-ledger folder. Writes b-key.json (private test key, do not commit).
import { writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [a, relayPub] = process.argv.slice(2);
if (!a || !relayPub) { console.error('Usage: node ../tools/manual/make-genesis.mjs <A> <relay-public-key>'); process.exit(1); }
const pair = () => {
  const p = generateKeyPairSync('ed25519');
  return { publicKey: p.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: p.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
};
const bPair = pair();
const b = bPair.publicKey, m = [pair().publicKey, pair().publicKey, pair().publicKey];
// Account B is for the smoke test only (deal-test.mjs). Do not commit this file.
writeFileSync('b-key.json', JSON.stringify(bPair));
const cfg = { policyId: 'beta-policy-1', multisigMembers: m, inviters: [a], genesisAccounts: [a, b], checkers: [a], issuancePolicyIds: ['beta-policy-1'], jurorPayoutPerCase: 10, limits: { maxIssuancePerEvent: 1000, maxTreasurySpendPerEvent: 1000, maxDealAmount: 500 }, treasury: 10000, grants: [{ recipient: a, amount: 1000, nonce: 'grant-a' }, { recipient: b, amount: 1000, nonce: 'grant-b' }] };
writeFileSync('genesis-config.json', JSON.stringify(cfg, null, 2));
rmSync('genesis.json', { force: true });
const r = spawnSync('node', ['dist/apps/relay/admin-cli.js', 'genesis', 'build', '--config', 'genesis-config.json', '--relay-public-key', relayPub, '--out', 'genesis.json'], { encoding: 'utf8' });
console.log(r.stdout, r.stderr);
console.log('Konto A (UI):', a); console.log('Konto B:', b);
