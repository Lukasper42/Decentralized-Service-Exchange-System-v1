// Manual smoke test C8 (castVote in the UI). Needs a relay started with a genesis built by
//   node ../tools/manual/make-tester-genesis.mjs --open-jury --extra-keys 4 --inviter "<UI pubkey>" --relay-public-key "<relay public_key>"
// (jury thresholds 0: for this test only; extra-keys.json holds buyer, seller, juror 2, juror 3).
// Run in the skill-exchange-ledger folder.
//   Phase "setup":  node ../tools/manual/jury-test.mjs setup  <UI-pubkey> <vault-file> <vault-password> [relay-url]
//     creates the accounts, a disputed deal and a jury of three (the UI key is juror 1). Then vote in the UI (Jury view).
//   Phase "finish": node ../tools/manual/jury-test.mjs finish <UI-pubkey> <vault-file> <vault-password> [relay-url]
//     jurors 2 and 3 vote (buyer / seller), the dispute is resolved. Run only after the UI vote.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const [phase, a, vaultPath, password, relayUrl = 'http://127.0.0.1:3000'] = process.argv.slice(2);
if (!['setup', 'finish'].includes(phase) || !a || !vaultPath || !password) {
  console.error('Usage: node ../tools/manual/jury-test.mjs <setup|finish> <UI-pubkey> <vault-file> <vault-password> [relay-url]');
  process.exit(1);
}
const imp = (p) => import(pathToFileURL(resolve(p)).href);
const { recoveryCommitment, signAttestation } = await imp('dist/packages/crypto/src/index.js');
const { HttpTransport, LedgerClient, keyPairSigner } = await imp('dist/packages/client/src/index.js');
const { Projector } = await imp('dist/packages/relay/src/index.js');
const { loadGenesis } = await imp('dist/apps/relay/genesis.js');
const vaultMod = await imp('../skillx-web/dist/vault.js');
const unlocked = await vaultMod.unlock(globalThis.crypto, { publicKey: a, file: JSON.parse(readFileSync(vaultPath, 'utf8')) }, password);
if (!unlocked.ok) { console.error('Could not unlock the vault:', unlocked.error?.message ?? 'wrong password?'); process.exit(1); }
const j1 = { publicKey: a, privateKey: unlocked.value };
let extra;
try { extra = JSON.parse(readFileSync('extra-keys.json', 'utf8')); } catch { extra = null; }
if (!Array.isArray(extra) || extra.length < 4) { console.error('extra-keys.json missing or has fewer than 4 keys: build the genesis with --extra-keys 4.'); process.exit(1); }
const [buyer, seller, j2, j3] = extra;
const sha = createHash('sha256').update(readFileSync('genesis.json', 'utf8')).digest('hex');
const cfg = loadGenesis({ path: 'genesis.json', expectedSha256: sha, files: { readText: (p) => readFileSync(p, 'utf8') }, policyDirectory: null });
const mk = (who) => new LedgerClient({ transport: new HttpTransport({ baseUrl: relayUrl }), projector: new Projector(cfg), clock: { nowMs: () => Date.now() }, signer: keyPairSigner(who) });
const cl = { buyer: mk(buyer), seller: mk(seller), j1: mk(j1), j2: mk(j2), j3: mk(j3) };
let failed = false;
const show = (name, res) => { console.log(res.ok ? 'OK  ' : 'FAIL', name, res.ok ? '' : JSON.stringify(res.error)); if (!res.ok) failed = true; return res; };
const D = '00000000-0000-4000-8000-0000000000aa';
const h = (c) => c.repeat(64);
const step = async (name, who, type, payload) => { await cl[who].sync(); return show(name, await cl[who].submit(type, payload)); };

if (phase === 'setup') {
  for (const [n, w] of [['buyer', buyer], ['seller', seller], ['j1 (UI)', j1], ['j2', j2], ['j3', j3]]) {
    const c = cl[n.startsWith('j1') ? 'j1' : n]; await c.sync();
    show(`AccountCreated ${n}`, await c.submit('AccountCreated', { pubkey: w.publicKey, recovery_commitment: recoveryCommitment(w.publicKey), invite_ref: null }));
  }
  const deadline = new Date(Date.now() + 30 * 864e5).toISOString();
  await step('DealCreated', 'buyer', 'DealCreated', { deal_id: D, buyer: buyer.publicKey, seller: seller.publicKey, amount: 100, criteria_hash: h('c'), deadline });
  await cl.seller.sync();
  show('DealConsented', await cl.seller.consentDeal(D));
  await step('EscrowFunded', 'buyer', 'EscrowFunded', { deal_id: D, from: buyer.publicKey, amount: 100 });
  await step('DeliverableSubmitted', 'seller', 'DeliverableSubmitted', { deal_id: D, content_hash: h('d'), precheck_ref: null });
  await step('DealRejected', 'buyer', 'DealRejected', { deal_id: D, by: buyer.publicKey, reason_hash: h('e') });
  await step('DisputeOpened', 'buyer', 'DisputeOpened', { deal_id: D, by: buyer.publicKey });
  // The jury draw needs a receipt a few entries after the dispute ("beacon"): padding entries advance the sequence.
  for (let i = 0; i < 12; i++) {
    await cl.buyer.sync();
    await cl.buyer.submit('DealCreated', { deal_id: `00000000-0000-4000-8000-00000000${(i + 1).toString(16).padStart(4, '0')}`, buyer: buyer.publicKey, seller: seller.publicKey, amount: 2, criteria_hash: h('f'), deadline });
  }
  const perms = (x) => x.length <= 1 ? [x] : x.flatMap((e, i) => perms([...x.slice(0, i), ...x.slice(i + 1)]).map((p) => [e, ...p]));
  let assigned = false, lastErr = '';
  for (const p of perms([j1.publicKey, j2.publicKey, j3.publicKey])) {
    await cl.j2.sync();
    const x = await cl.j2.submit('JuryAssigned', { deal_id: D, jurors: p, appeal_round: 0 });
    if (x.ok) { assigned = true; break; }
    lastErr = JSON.stringify(x.error);
  }
  show('JuryAssigned (3 jurors, order found by trial)', assigned ? { ok: true } : { ok: false, error: lastErr });
  console.log(failed ? '\nSetup failed. Send the output to Claude.' : '\nNext: in the UI unlock the key, open the Jury view and vote "Buyer". Then run the finish phase.');
} else {
  await step('j2 JuryVoted (buyer)', 'j2', 'JuryVoted', { deal_id: D, juror: j2.publicKey, vote: 'buyer', appeal_round: 0, sig: signAttestation('jury-vote', { deal_id: D, juror: j2.publicKey, vote: 'buyer', appeal_round: 0 }, j2.privateKey) });
  await cl.j3.sync();
  show('j3 castVote (seller)', await cl.j3.castVote(D, 'seller'));
  await step('DisputeResolved (2:1 buyer)', 'j2', 'DisputeResolved', { deal_id: D, outcome: 'buyer', appeal_round: 0 });
  console.log(failed ? '\nFinish failed (was the UI vote cast?). Send the output to Claude.' : '\nNext: in the UI open Deals and the Account view: the deal is resolved in favour of the buyer.');
}
process.exit(failed ? 1 : 0);
