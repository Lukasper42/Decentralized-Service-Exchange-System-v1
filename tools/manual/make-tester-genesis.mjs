// Builds a tester genesis (own policy id, lower jury thresholds). Run in the skill-exchange-ledger folder after `npm run build`.
// Writes genesis-config.json and genesis.json, prints GENESIS_SHA256. Refuses to overwrite an existing genesis.json (use --force only for throwaway relays).
// Throwaway keys (multisig members, extra accounts) are written to multisig-keys.json / extra-keys.json: test secrets, never commit.
//
// Usage:
//   node ../tools/manual/make-tester-genesis.mjs --relay-public-key <b64> --inviter <b64> [--accounts <b64,b64,...>] [--members <b64,b64,b64>]
//        [--tier-deals 3] [--tier-counterparties 2] [--tier-age-days 7] [--open-jury] [--extra-keys 4] [--force]
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flags = new Set(['--open-jury', '--force']);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const k = args[i];
  if (!k.startsWith('--')) { console.error(`Unexpected argument: ${k}`); process.exit(1); }
  if (flags.has(k)) { opt[k] = true; continue; }
  const v = args[++i];
  if (v === undefined || v.startsWith('--')) { console.error(`Missing value for ${k}`); process.exit(1); }
  opt[k] = v;
}
const relayPub = opt['--relay-public-key'];
const inviter = opt['--inviter'];
if (!relayPub || !inviter) {
  console.error('Usage: node ../tools/manual/make-tester-genesis.mjs --relay-public-key <b64> --inviter <b64> [--accounts a,b,..] [--members a,b,c] [--tier-deals N] [--tier-counterparties N] [--tier-age-days N] [--open-jury] [--extra-keys N] [--force]');
  process.exit(1);
}
const int = (name, dflt) => {
  const raw = opt[name]; if (raw === undefined) return dflt;
  if (!/^\d+$/.test(raw)) { console.error(`${name} must be a non-negative integer`); process.exit(1); }
  return Number(raw);
};
const list = (name) => (opt[name] ? opt[name].split(',').map((s) => s.trim()).filter(Boolean) : []);
const isPubkey = (s) => { const b = Buffer.from(s, 'base64'); return b.length === 44 && b.toString('base64') === s; };
const pair = () => {
  const p = generateKeyPairSync('ed25519');
  return { publicKey: p.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: p.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
};

if (existsSync('genesis.json') && !opt['--force']) {
  console.error('genesis.json already exists. A genesis is immutable once a relay has used it: move it away or pass --force (throwaway relays only).');
  process.exit(1);
}

const open = Boolean(opt['--open-jury']);
const tier = open
  ? { minDeals: 0, minCounterparties: 0, minAccountAgeDays: 0, requirePositiveBalance: false }
  : { minDeals: int('--tier-deals', 3), minCounterparties: int('--tier-counterparties', 2), minAccountAgeDays: int('--tier-age-days', 7), requirePositiveBalance: true };

const extraCount = int('--extra-keys', 0);
const extra = Array.from({ length: extraCount }, pair);
if (extraCount > 0) writeFileSync('extra-keys.json', JSON.stringify(extra, null, 2));

let members = list('--members');
if (members.length === 0) {
  const gen = [pair(), pair(), pair()];
  writeFileSync('multisig-keys.json', JSON.stringify(gen, null, 2));
  members = gen.map((k) => k.publicKey);
  console.log('WARNING: multisig keys generated for testing only (multisig-keys.json). For real use pass --members with three real public keys.');
}
const accounts = [...new Set([inviter, ...list('--accounts'), ...extra.map((k) => k.publicKey)])];
for (const k of [relayPub, inviter, ...members, ...accounts]) {
  if (!isPubkey(k)) { console.error(`Not a valid Ed25519 SPKI Base64 public key (44 bytes): ${k}`); process.exit(1); }
}
if (members.length !== 3 || new Set(members).size !== 3) { console.error('--members needs exactly three distinct public keys'); process.exit(1); }

const cfg = {
  policyId: 'tester-beta-1',
  multisigMembers: members,
  inviters: [inviter],
  genesisAccounts: accounts,
  checkers: [inviter],
  issuancePolicyIds: ['tester-beta-1'],
  jurorPayoutPerCase: 10,
  limits: { maxIssuancePerEvent: 1000, maxTreasurySpendPerEvent: 1000, maxDealAmount: 500 },
  treasury: 100000,
  grants: accounts.map((a, i) => ({ recipient: a, amount: 1000, nonce: `tester-grant-${i}` })),
};
writeFileSync('genesis-config.json', JSON.stringify(cfg, null, 2));

const imp = (p) => import(pathToFileURL(resolve(p)).href);
const { buildGenesis } = await imp('dist/apps/relay/admin.js');
const { loadGenesis } = await imp('dist/apps/relay/genesis.js');
const built = buildGenesis({ config: cfg, relayPublicKey: relayPub });
const doc = JSON.parse(built.text);
doc.policy.jury.tiers = [tier];
const text = JSON.stringify(doc, null, 2) + '\n';
const sha = createHash('sha256').update(text).digest('hex');
// Same validation the relay runs at startup.
loadGenesis({ path: 'genesis.json', expectedSha256: sha, files: { readText: () => text }, policyDirectory: null });
rmSync('genesis.json', { force: true });
writeFileSync('genesis.json', text);
console.log(`policy_id=${cfg.policyId}`);
console.log(`jury_tier=${JSON.stringify(tier)}`);
console.log(`genesis_accounts=${accounts.length}`);
console.log(`GENESIS_SHA256=${sha}`);
