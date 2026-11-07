// Manual C8 jury test. Uses only the already-created tester genesis and extra keys.
// Never generate or replace genesis.json, extra-keys.json, multisig-keys.json, or any identity here.
// Run from skill-exchange-ledger. Vault password is prompted locally without echo.
//
// setup:  node ../tools/manual/jury-test.mjs setup <UI-pubkey> <vault-file> [relay-url]
// finish: node ../tools/manual/jury-test.mjs finish <UI-pubkey> <vault-file> [relay-url]
// Run finish only after Juror 1's Buyer vote is visible in the relay ledger.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

const EXPECTED_GENESIS_SHA256 = 'c1ff8c9c10efd7a7092626bf488f9c2f3b357f8a2cd16950ab16a3bfc4b9799e';
const EXPECTED_EXTRA_KEYS_SHA256 = '606a1e3c0de4e9415067d061a555e2b6c1d33446b99021e0528a10b00fe45771';
const DEAL_ID = '00000000-0000-4000-8000-0000000000aa';
const EXPECTED_SETUP_TIP = 24;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readHiddenPassword(promptText) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this script in an interactive terminal.'));
  }
  emitKeypressEvents(input);
  return new Promise((resolvePassword, reject) => {
    let value = '';
    let settled = false;
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = input.isPaused();
    const finish = () => {
      if (settled) return;
      settled = true;
      input.off('keypress', onKeypress);
      try { input.setRawMode(wasRaw); } catch {}
      if (wasPaused) input.pause();
      process.stdout.write('\n');
    };
    const onKeypress = (str, key = {}) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        finish();
        value = '';
        reject(new Error('Password entry cancelled.'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
        resolvePassword(value);
        return;
      }
      if (key.name === 'backspace') {
        value = Array.from(value).slice(0, -1).join('');
        return;
      }
      if (typeof str === 'string' && str.length > 0 && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/u.test(str)) {
        value += str;
      }
    };
    try {
      input.setRawMode(true);
      input.resume();
      input.on('keypress', onKeypress);
      process.stdout.write(promptText);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

async function main() {
  const [phase, uiPublicKey, vaultPath, relayUrl = 'http://127.0.0.1:3000'] = process.argv.slice(2);
  if (!['setup', 'finish'].includes(phase) || !uiPublicKey || !vaultPath) {
    throw new Error('Usage: node ../tools/manual/jury-test.mjs <setup|finish> <UI-pubkey> <vault-file> [relay-url]');
  }

  let writesStarted = false;
  const imp = (p) => import(pathToFileURL(resolve(p)).href);

  try {
    // Verify protected local inputs before asking for the password or contacting the relay.
    const genesisText = readFileSync('genesis.json', 'utf8');
    const genesisHash = sha256(genesisText);
    if (genesisHash !== EXPECTED_GENESIS_SHA256) {
      throw new Error(`Genesis SHA-256 mismatch. Expected ${EXPECTED_GENESIS_SHA256}, got ${genesisHash}. No ledger writes were attempted.`);
    }

    const extraText = readFileSync('extra-keys.json', 'utf8');
    const extraHash = sha256(extraText);
    if (extraHash !== EXPECTED_EXTRA_KEYS_SHA256) {
      throw new Error(`extra-keys.json SHA-256 mismatch. Expected ${EXPECTED_EXTRA_KEYS_SHA256}, got ${extraHash}. No ledger writes were attempted.`);
    }
    const extra = JSON.parse(extraText);
    if (!Array.isArray(extra) || extra.length !== 4 ||
        !extra.every((entry) => entry && typeof entry.publicKey === 'string' &&
          entry.publicKey.length > 0 && typeof entry.privateKey === 'string' &&
          entry.privateKey.length > 0)) {
      throw new Error('extra-keys.json must contain exactly four valid identities. Do not regenerate it here.');
    }
    const [buyer, seller, j2, j3] = extra;

    const { loadGenesis } = await imp('dist/apps/relay/genesis.js');
    const cfg = loadGenesis({
      path: 'genesis.json',
      expectedSha256: EXPECTED_GENESIS_SHA256,
      files: { readText: (p) => readFileSync(p, 'utf8') },
      policyDirectory: null,
    });

    const getJson = async (route) => {
      const response = await fetch(new URL(route, relayUrl), { headers: { accept: 'application/json' } });
      let body;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok || body === null) {
        const detail = body && typeof body.message === 'string' ? body.message : 'non-JSON response';
        throw new Error(`Relay ${route} returned HTTP ${response.status}: ${detail}`);
      }
      return body;
    };

    // A clean setup may run only against an empty, writable relay.
    const health = await getJson('/v1/health');
    const tipInfo = await getJson('/v1/tip');
    if (health.ok !== true || health.readOnly !== false ||
        !Number.isSafeInteger(health.tip) || health.tip !== tipInfo.tipSequence) {
      throw new Error('Relay health/tip is inconsistent or read-only. No ledger writes were attempted.');
    }

    if (phase === 'setup' && tipInfo.tipSequence !== 0) {
      throw new Error(`Setup refused: relay tip is ${tipInfo.tipSequence}, not 0. Do not rerun setup; inspect the existing ledger first.`);
    }

    if (phase === 'finish') {
      const page = await getJson('/v1/entries?from=1&to=500');
      if (!Array.isArray(page.entries)) throw new Error('Relay entries response is invalid.');
      const events = page.entries.map((entry) => entry && entry.event).filter(Boolean);
      const assigned = events.filter((event) =>
        event.type === 'JuryAssigned' && event.payload?.deal_id === DEAL_ID);
      const uiVotes = events.filter((event) =>
        event.type === 'JuryVoted' && event.payload?.deal_id === DEAL_ID &&
        event.payload?.juror === uiPublicKey && event.payload?.vote === 'buyer' &&
        event.signer === uiPublicKey);
      const alreadyFinished = events.some((event) =>
        (event.type === 'JuryVoted' &&
          event.payload?.deal_id === DEAL_ID &&
          (event.payload?.juror === j2.publicKey || event.payload?.juror === j3.publicKey)) ||
        (event.type === 'DisputeResolved' && event.payload?.deal_id === DEAL_ID));
      if (assigned.length !== 1 || uiVotes.length !== 1 || alreadyFinished) {
        throw new Error('Finish refused: exactly one JuryAssigned and one recorded Juror-1 Buyer vote are required, with no prior Juror-2/Juror-3 vote or resolution. Inspect the ledger before proceeding.');
      }
    }

    const vaultMod = await imp('../skillx-web/dist/vault.js');
    const { derivePublicKey } = await imp('../skillx-web/dist/crypto.js');
    const { recoveryCommitment, signAttestation } = await imp('dist/packages/crypto/src/index.js');
    const { HttpTransport, LedgerClient, keyPairSigner } = await imp('dist/packages/client/src/index.js');
    const { Projector } = await imp('dist/packages/relay/src/index.js');

    let password = '';
    let unlocked;
    let unlockStage = 'Passworteingabe';
    try {
      password = await readHiddenPassword('Vault password (hidden): ');
      unlockStage = 'Vault-Datei lesen und parsen';
      const vaultFile = JSON.parse(readFileSync(vaultPath, 'utf8'));
      unlockStage = 'Vault entsperren';
      unlocked = await vaultMod.unlock(globalThis.crypto, { publicKey: uiPublicKey, file: vaultFile }, password);
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`Fehler bei "${unlockStage}": ${detail}`);
    } finally {
      password = '';
    }

    if (!unlocked?.ok) {
      throw new Error(`Could not unlock the vault: ${unlocked?.error?.message ?? 'vault unlock failed'}`);
    }

    // keyPairSigner consumes the PKCS#8 string, so derive and compare the identity before constructing it.
    const derivedPublicKey = await derivePublicKey(globalThis.crypto, unlocked.value);
    if (derivedPublicKey !== uiPublicKey) {
      throw new Error('The public key derived from the vault does not match the supplied UI public key. No ledger writes were attempted.');
    }
    const j1 = { publicKey: uiPublicKey, privateKey: unlocked.value };

    const mk = (who) => new LedgerClient({
      transport: new HttpTransport({ baseUrl: relayUrl }),
      projector: new Projector(cfg),
      clock: { nowMs: () => Date.now() },
      signer: keyPairSigner(who),
    });
    const cl = {
      buyer: mk(buyer),
      seller: mk(seller),
      j1: mk(j1),
      j2: mk(j2),
      j3: mk(j3),
    };

    const requireOk = (name, result) => {
      if (!result || result.ok !== true) {
        console.error('FAIL', name, result?.error ? JSON.stringify(result.error) : 'unknown result');
        throw new Error(`Aborted after failed operation: ${name}`);
      }
      console.log('OK  ', name);
      return result.value;
    };
    const sync = async (who) => requireOk(`${who} sync`, await cl[who].sync());
    const step = async (name, who, type, payload) => {
      await sync(who);
      writesStarted = true;
      return requireOk(name, await cl[who].submit(type, payload));
    };
    const h = (char) => char.repeat(64);

    if (phase === 'setup') {
      for (const [name, identity, clientName] of [
        ['buyer', buyer, 'buyer'],
        ['seller', seller, 'seller'],
        ['j1 (UI)', j1, 'j1'],
        ['j2', j2, 'j2'],
        ['j3', j3, 'j3'],
      ]) {
        await sync(clientName);
        writesStarted = true;
        requireOk(`AccountCreated ${name}`, await cl[clientName].submit('AccountCreated', {
          pubkey: identity.publicKey,
          recovery_commitment: recoveryCommitment(identity.publicKey),
          invite_ref: null,
        }));
      }

      const deadline = new Date(Date.now() + 30 * 864e5).toISOString();
      await step('DealCreated', 'buyer', 'DealCreated', {
        deal_id: DEAL_ID, buyer: buyer.publicKey, seller: seller.publicKey,
        amount: 100, criteria_hash: h('c'), deadline,
      });
      await sync('seller');
      writesStarted = true;
      requireOk('DealConsented', await cl.seller.consentDeal(DEAL_ID));
      await step('EscrowFunded', 'buyer', 'EscrowFunded', {
        deal_id: DEAL_ID, from: buyer.publicKey, amount: 100,
      });
      await step('DeliverableSubmitted', 'seller', 'DeliverableSubmitted', {
        deal_id: DEAL_ID, content_hash: h('d'), precheck_ref: null,
      });
      await step('DealRejected', 'buyer', 'DealRejected', {
        deal_id: DEAL_ID, by: buyer.publicKey, reason_hash: h('e'),
      });
      await step('DisputeOpened', 'buyer', 'DisputeOpened', {
        deal_id: DEAL_ID, by: buyer.publicKey,
      });

      // Twelve padding deals advance the receipt sequence so the jury beacon is available.
      for (let i = 0; i < 12; i++) {
        const suffix = (i + 1).toString(16).padStart(4, '0');
        await step(`Padding DealCreated ${i + 1}/12`, 'buyer', 'DealCreated', {
          deal_id: `00000000-0000-4000-8000-00000000${suffix}`,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          amount: 2,
          criteria_hash: h('f'),
          deadline,
        });
      }

      const permutations = (items) => items.length <= 1
        ? [items]
        : items.flatMap((entry, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)])
            .map((rest) => [entry, ...rest]));
      let assigned = false;
      let lastError = '';
      for (const jurors of permutations([j1.publicKey, j2.publicKey, j3.publicKey])) {
        await sync('j2');
        writesStarted = true;
        const result = await cl.j2.submit('JuryAssigned', {
          deal_id: DEAL_ID, jurors, appeal_round: 0,
        });
        if (result?.ok === true) {
          console.log('OK  ', 'JuryAssigned (3 jurors, deterministic order found)');
          assigned = true;
          break;
        }
        if (result?.error?.code !== 'JURY_MISMATCH') {
          console.error('FAIL', 'JuryAssigned', result?.error ? JSON.stringify(result.error) : 'unknown result');
          throw new Error('Jury assignment stopped on an unexpected relay error.');
        }
        lastError = result.error.message ?? result.error.code;
      }
      if (!assigned) throw new Error(`No jury permutation was accepted: ${lastError}`);

      const finalHealth = await getJson('/v1/health');
      if (finalHealth.tip !== EXPECTED_SETUP_TIP || finalHealth.readOnly !== false) {
        throw new Error(`Setup submitted but final relay tip was ${finalHealth.tip}; expected ${EXPECTED_SETUP_TIP}. Inspect the ledger before continuing.`);
      }
      console.log('\nSetup successful. In the UI, unlock Juror 1, open Jury, and record the Buyer vote. Verify it appears in the relay before running finish.');
    } else {
      await step('j2 JuryVoted (buyer)', 'j2', 'JuryVoted', {
        deal_id: DEAL_ID,
        juror: j2.publicKey,
        vote: 'buyer',
        appeal_round: 0,
        sig: signAttestation('jury-vote', {
          deal_id: DEAL_ID, juror: j2.publicKey, vote: 'buyer', appeal_round: 0,
        }, j2.privateKey),
      });
      await step('j3 castVote (seller)', 'j3', 'JuryVoted', {
        deal_id: DEAL_ID,
        juror: j3.publicKey,
        vote: 'seller',
        appeal_round: 0,
        sig: signAttestation('jury-vote', {
          deal_id: DEAL_ID, juror: j3.publicKey, vote: 'seller', appeal_round: 0,
        }, j3.privateKey),
      });
      await step('DisputeResolved (2:1 buyer)', 'j2', 'DisputeResolved', {
        deal_id: DEAL_ID, outcome: 'buyer', appeal_round: 0,
      });

      const page = await getJson('/v1/entries?from=1&to=500');
      const resolved = page.entries?.some((entry) =>
        entry.event?.type === 'DisputeResolved' &&
        entry.event?.payload?.deal_id === DEAL_ID &&
        entry.event?.payload?.outcome === 'buyer');
      if (!resolved) throw new Error('Resolution event was not found in the relay history.');
      console.log('\nFinish successful. Verify the resolved deal and escrow state in the UI.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\nSTOP:', message);
    if (writesStarted) {
      console.error('WARNING: one or more ledger writes may already have succeeded. Do not rerun setup or finish. Inspect /v1/health and /v1/entries first.');
    } else {
      console.error('No ledger write was attempted by this script run.');
    }
    process.exitCode = 1;
  }
}

await main();
