import { readFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..', 'Decentralized-Service-Exchange-System-v1');
const LEDGER = join(PROJECT, 'skill-exchange-ledger');
const WEB = join(PROJECT, 'skillx-web');
const GENESIS_FILE = join(HERE, 'genesis-14d.json');
const EXTRA_FILE = join(LEDGER, 'extra-keys.json');

const EXPECTED_GENESIS_SHA256 = '6980d098fef7131e70f7240df5e28913f2d21f2b4720a88496bdeb8e0eeda4e4';
const EXPECTED_EXTRA_KEYS_SHA256 = '606a1e3c0de4e9415067d061a555e2b6c1d33446b99021e0528a10b00fe45771';
const EXPECTED_POLICY_ID = 'c8-fresh-20261122-14d';
const EXPECTED_VOTING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DISPUTE_DEAL_ID = '00000000-0000-4000-8000-0000000000aa';
const TRAINING_DEAL_COUNT = 48;
const EVENTS_PER_TRAINING_DEAL = 9;
const EXPECTED_SETUP_TIP = 6 + TRAINING_DEAL_COUNT * EVENTS_PER_TRAINING_DEAL + 6 + 12 + 1;
const DEAL_AMOUNT = 101;
const SELLER_AMOUNT = 99;
const FEE_AMOUNT = 2;
const DEAL_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;

let writesStarted = false;
let activePhase = 'unknown';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function importFile(path) {
  return import(pathToFileURL(resolve(path)).href);
}

function derivePublicKey(privateKeyBase64) {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64.trim(), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('A private identity key is not Ed25519.');
  }
  return createPublicKey(key)
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
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

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((entry, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)])
      .map((rest) => [entry, ...rest]));
}

async function main() {
  const [phase, uiPublicKey, vaultPath, relayUrl = 'https://skillx-web-git-feat-c8-14d-serverless-test-lukaspsenner12-1356.vercel.app/api/relay'] = process.argv.slice(2);
  activePhase = phase ?? 'unknown';
  if (!['setup', 'finish'].includes(phase) || !uiPublicKey || !vaultPath) {
    throw new Error('Usage: node c8-fresh-jury-test-14d.mjs <setup|finish> <UI-public-key> <vault-file> [relay-url]');
  }

  // Verify immutable local inputs before prompting for the vault password or writing to the relay.
  const genesisText = readFileSync(GENESIS_FILE, 'utf8');
  const genesisHash = sha256(genesisText);
  if (genesisHash !== EXPECTED_GENESIS_SHA256) {
    throw new Error(`Fresh Genesis SHA-256 mismatch. Expected ${EXPECTED_GENESIS_SHA256}, got ${genesisHash}. No ledger writes were attempted.`);
  }

  const extraText = readFileSync(EXTRA_FILE, 'utf8');
  const extraHash = sha256(extraText);
  if (extraHash !== EXPECTED_EXTRA_KEYS_SHA256) {
    throw new Error(`Original extra-keys.json SHA-256 mismatch. Expected ${EXPECTED_EXTRA_KEYS_SHA256}, got ${extraHash}. No ledger writes were attempted.`);
  }
  const extra = JSON.parse(extraText);
  if (!Array.isArray(extra) || extra.length !== 4 ||
      !extra.every((entry) => entry && typeof entry.publicKey === 'string' &&
        typeof entry.privateKey === 'string' && entry.privateKey.length > 0 &&
        derivePublicKey(entry.privateKey) === entry.publicKey)) {
    throw new Error('Original extra-keys.json must contain exactly four valid matching identities.');
  }
  const [buyer, seller, j2, j3] = extra;

  const inviterPrivateKey = readFileSync(join(HERE, 'inviter.key'), 'utf8').trim();
  const inviter = {
    publicKey: derivePublicKey(inviterPrivateKey),
    privateKey: inviterPrivateKey,
  };

  const { loadGenesis } = await importFile(join(LEDGER, 'dist', 'apps', 'relay', 'genesis.js'));
  const cfg = loadGenesis({
    path: GENESIS_FILE,
    expectedSha256: EXPECTED_GENESIS_SHA256,
    files: { readText: (path) => readFileSync(path, 'utf8') },
    policyDirectory: null,
  });

  if (cfg.genesisPolicy.policyId !== EXPECTED_POLICY_ID || cfg.genesisPolicy.voteWindowMs !== EXPECTED_VOTING_WINDOW_MS) {
    throw new Error('The prepared Genesis does not contain the exact 14-day test policy. No ledger writes were attempted.');
  }

  // The domain Amount type has a minimum of 2. At 100 bp an escrow of 10
  // produces a fee of 1, which cannot be represented by FeeBurned. Validate
  // the training settlement against the active policy before any relay writes.
  const expectedTrainingFee = Math.ceil((DEAL_AMOUNT * cfg.genesisPolicy.feeBp) / 10_000);
  if (!Number.isSafeInteger(expectedTrainingFee) || expectedTrainingFee < 2 ||
      FEE_AMOUNT !== expectedTrainingFee || SELLER_AMOUNT !== DEAL_AMOUNT - expectedTrainingFee) {
    throw new Error('Training settlement amounts do not satisfy the active fee policy and Amount minimum. No ledger writes were attempted.');
  }

  // Keep the Relay mount path (for example /api/relay) when resolving /v1 routes.
  // A leading slash in new URL('/v1/health', relayUrl) would discard that mount path.
  const relayBaseUrl = new URL(`${relayUrl.replace(/\/+$/, '')}/`);
  if (!['http:', 'https:'].includes(relayBaseUrl.protocol)) {
    throw new Error('Relay URL must use HTTP or HTTPS.');
  }
  const getJson = async (route) => {
    const relativeRoute = route.replace(/^\/+/, '');
    const requestUrl = new URL(relativeRoute, relayBaseUrl);
    const response = await fetch(requestUrl, { headers: { accept: 'application/json' } });
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || body === null) {
      const detail = body && typeof body.message === 'string' ? body.message : 'non-JSON response';
      throw new Error(`Relay ${route} returned HTTP ${response.status}: ${detail}`);
    }
    return body;
  };

  // Check the intended phase before unlocking any vault or asking for a password.
  const health = await getJson('/v1/health');
  const tipInfo = await getJson('/v1/tip');
  if (health.ok !== true || health.readOnly !== false ||
      !Number.isSafeInteger(health.tip) || health.tip !== tipInfo.tipSequence) {
    throw new Error('Relay health/tip is inconsistent or read-only. No vault password was requested and no writes were attempted.');
  }
  if (phase === 'setup' && tipInfo.tipSequence !== 0) {
    throw new Error(`Fresh setup refused: relay tip is ${tipInfo.tipSequence}, not 0. Use a new isolated LEDGER_FILE. No vault password was requested and no writes were attempted.`);
  }
  if (phase === 'finish' && tipInfo.tipSequence !== EXPECTED_SETUP_TIP + 1) {
    throw new Error(`Finish refused: expected relay tip ${EXPECTED_SETUP_TIP + 1} after Juror 1's UI vote, got ${tipInfo.tipSequence}. No vault password was requested and no writes were attempted.`);
  }

  if (!cfg.genesisPolicy.inviters.includes(inviter.publicKey)) {
    throw new Error('inviter.key does not match the new Genesis inviter entry.');
  }
  if (!cfg.genesisPolicy.genesisAccounts.includes(uiPublicKey)) {
    throw new Error('The supplied Juror-1 public key is not in the fresh Genesis.');
  }
  if (!cfg.genesisPolicy.genesisAccounts.includes(inviter.publicKey)) {
    throw new Error('The fresh inviter is not in genesisAccounts.');
  }

  const vaultMod = await importFile(join(WEB, 'dist', 'vault.js'));
  const { derivePublicKey: deriveVaultPublicKey } = await importFile(join(WEB, 'dist', 'crypto.js'));
  const { recoveryCommitment, signAttestation } = await importFile(join(LEDGER, 'dist', 'packages', 'crypto', 'src', 'index.js'));
  const { HttpTransport, LedgerClient, keyPairSigner } = await importFile(join(LEDGER, 'dist', 'packages', 'client', 'src', 'index.js'));
  const { Projector } = await importFile(join(LEDGER, 'dist', 'packages', 'relay', 'src', 'index.js'));

  let password = '';
  let unlocked;
  let unlockStage = 'Vault password entry';
  try {
    password = await readHiddenPassword('Vault password (hidden): ');
    unlockStage = 'Read and parse vault file';
    const vaultFile = JSON.parse(readFileSync(vaultPath, 'utf8'));
    unlockStage = 'Unlock vault';
    unlocked = await vaultMod.unlock(globalThis.crypto, { publicKey: uiPublicKey, file: vaultFile }, password);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`Failed at "${unlockStage}": ${detail}`);
  } finally {
    password = '';
  }
  if (!unlocked?.ok) {
    throw new Error(`Could not unlock Juror-1 vault: ${unlocked?.error?.message ?? 'vault unlock failed'}`);
  }
  const derivedUiPublicKey = await deriveVaultPublicKey(globalThis.crypto, unlocked.value);
  if (derivedUiPublicKey !== uiPublicKey) {
    throw new Error('The public key derived from the vault does not match the supplied UI public key. No ledger writes were attempted.');
  }
  const j1 = { publicKey: uiPublicKey, privateKey: unlocked.value };

  const participants = [buyer, seller, inviter, j1, j2, j3];
  const publicKeys = participants.map((identity) => identity.publicKey);
  if (new Set(publicKeys).size !== 6) {
    throw new Error('Expected six distinct identities (buyer, seller, inviter, and three jurors).');
  }
  for (const identity of participants) {
    if (!cfg.genesisPolicy.genesisAccounts.includes(identity.publicKey)) {
      throw new Error(`Identity ${identity.publicKey} is missing from fresh Genesis accounts.`);
    }
  }
  const jurors = [j1, j2, j3];
  const jurorKeys = new Set(jurors.map((identity) => identity.publicKey));

  // Preflight the complete training schedule against immutable Genesis grants.
  // Non-jurors fund 3 of 4 deals against each juror; juror/juror pairs split
  // 2/2. This keeps every participant's gross escrow funding within 1,000.
  const genesisDocument = JSON.parse(genesisText);
  const grantBalances = new Map();
  for (const grant of genesisDocument.grants ?? []) {
    grantBalances.set(grant.recipient, (grantBalances.get(grant.recipient) ?? 0) + grant.amount);
  }
  const plannedBuyerCounts = new Map(participants.map((identity) => [identity.publicKey, 0]));
  let plannedTrainingDeals = 0;
  for (let i = 0; i < participants.length; i += 1) {
    for (let j = i + 1; j < participants.length; j += 1) {
      const first = participants[i];
      const second = participants[j];
      const firstIsJuror = jurorKeys.has(first.publicKey);
      const secondIsJuror = jurorKeys.has(second.publicKey);
      if (!firstIsJuror && !secondIsJuror) continue;
      const firstBuyerRepeats = !firstIsJuror && secondIsJuror ? 3 :
        firstIsJuror && secondIsJuror ? 2 : 0;
      for (let repeat = 0; repeat < 4; repeat += 1) {
        const buyer = repeat < firstBuyerRepeats ? first : second;
        plannedBuyerCounts.set(buyer.publicKey, plannedBuyerCounts.get(buyer.publicKey) + 1);
        plannedTrainingDeals += 1;
      }
    }
  }
  if (plannedTrainingDeals !== TRAINING_DEAL_COUNT) {
    throw new Error(`Training plan contains ${plannedTrainingDeals} deals; expected ${TRAINING_DEAL_COUNT}. No ledger writes were attempted.`);
  }
  for (const identity of participants) {
    const required = plannedBuyerCounts.get(identity.publicKey) * DEAL_AMOUNT;
    const available = grantBalances.get(identity.publicKey) ?? 0;
    if (required > available) {
      throw new Error(`Genesis grant cannot fund the planned training schedule (required ${required}, available ${available}). No ledger writes were attempted.`);
    }
  }

  const makeClient = (identity) => new LedgerClient({
    transport: new HttpTransport({ baseUrl: relayUrl }),
    projector: new Projector(cfg),
    clock: { nowMs: () => Date.now() },
    signer: keyPairSigner(identity),
  });
  const clients = new Map(participants.map((identity) => [identity.publicKey, makeClient(identity)]));
  const clientFor = (identity) => clients.get(identity.publicKey);

  const requireOk = (name, result) => {
    if (!result || result.ok !== true) {
      const detail = result?.error ? JSON.stringify(result.error) : 'unknown relay/client result';
      throw new Error(`${name} failed: ${detail}`);
    }
    return result.value;
  };
  const sync = async (identity, name = identity.publicKey) => {
    requireOk(`${name} sync`, await clientFor(identity).sync());
  };
  const submit = async (name, identity, type, payload) => {
    const client = clientFor(identity);
    await sync(identity, name);
    writesStarted = true;
    return requireOk(name, await client.submit(type, payload));
  };
  const consent = async (name, identity, dealId) => {
    const client = clientFor(identity);
    await sync(identity, `${name} sync`);
    writesStarted = true;
    return requireOk(`${name} DealConsented`, await client.consentDeal(dealId));
  };
  if (phase === 'setup') {
    if (tipInfo.tipSequence !== 0) {
      throw new Error(`Fresh setup refused: relay tip is ${tipInfo.tipSequence}, not 0. Do not rerun setup; inspect the ledger first.`);
    }

    console.log('Creating six Genesis accounts...');
    for (const [index, identity] of participants.entries()) {
      await submit(`AccountCreated ${index + 1}/6`, identity, 'AccountCreated', {
        pubkey: identity.publicKey,
        recovery_commitment: recoveryCommitment(identity.publicKey),
        invite_ref: null,
      });
    }

    console.log('Training three jurors with 48 completed, positively rated deals...');
    let trainingIndex = 0;
    for (let i = 0; i < participants.length; i += 1) {
      for (let j = i + 1; j < participants.length; j += 1) {
        const first = participants[i];
        const second = participants[j];
        if (!jurorKeys.has(first.publicKey) && !jurorKeys.has(second.publicKey)) continue;

        for (let repeat = 0; repeat < 4; repeat += 1) {
          trainingIndex += 1;
          const dealId = `c8000000-0000-4000-8000-${trainingIndex.toString(16).padStart(12, '0')}`;
          const deadline = new Date(Date.now() + DEAL_DEADLINE_MS).toISOString();
          const hash = (char) => char.repeat(64);
          const firstIsJuror = jurorKeys.has(first.publicKey);
          const secondIsJuror = jurorKeys.has(second.publicKey);
          const firstBuyerRepeats = !firstIsJuror && secondIsJuror ? 3 :
            firstIsJuror && secondIsJuror ? 2 : 0;
          const buyer = repeat < firstBuyerRepeats ? first : second;
          const seller = buyer.publicKey === first.publicKey ? second : first;

          await submit(`Training ${trainingIndex}/48 DealCreated`, buyer, 'DealCreated', {
            deal_id: dealId,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            amount: DEAL_AMOUNT,
            criteria_hash: hash('c'),
            deadline,
          });
          await consent(`Training ${trainingIndex}/48`, seller, dealId);
          await submit(`Training ${trainingIndex}/48 EscrowFunded`, buyer, 'EscrowFunded', {
            deal_id: dealId,
            from: buyer.publicKey,
            amount: DEAL_AMOUNT,
          });
          await submit(`Training ${trainingIndex}/48 DeliverableSubmitted`, seller, 'DeliverableSubmitted', {
            deal_id: dealId,
            content_hash: hash('d'),
            precheck_ref: null,
          });
          await submit(`Training ${trainingIndex}/48 DealAccepted`, buyer, 'DealAccepted', {
            deal_id: dealId,
            by: buyer.publicKey,
          });
          await submit(`Training ${trainingIndex}/48 EscrowReleased`, buyer, 'EscrowReleased', {
            deal_id: dealId,
            to: seller.publicKey,
            amount: SELLER_AMOUNT,
          });
          await submit(`Training ${trainingIndex}/48 FeeBurned`, buyer, 'FeeBurned', {
            deal_id: dealId,
            amount: FEE_AMOUNT,
          });
          await submit(`Training ${trainingIndex}/48 buyer ReputationEvent`, first, 'ReputationEvent', {
            account: first.publicKey,
            counterparty: second.publicKey,
            deal_id: dealId,
            delta: 1,
            reason_hash: hash('a'),
          });
          await submit(`Training ${trainingIndex}/48 seller ReputationEvent`, second, 'ReputationEvent', {
            account: second.publicKey,
            counterparty: first.publicKey,
            deal_id: dealId,
            delta: 1,
            reason_hash: hash('b'),
          });

          if (trainingIndex % 4 === 0) console.log(`Completed training deals: ${trainingIndex}/48`);
        }
      }
    }
    if (trainingIndex !== TRAINING_DEAL_COUNT) {
      throw new Error(`Training schedule created ${trainingIndex} deals; expected ${TRAINING_DEAL_COUNT}.`);
    }

    console.log('Creating the C8 dispute deal...');
    const disputeDeadline = new Date(Date.now() + DEAL_DEADLINE_MS).toISOString();
    const h = (char) => char.repeat(64);
    await submit('C8 DealCreated', buyer, 'DealCreated', {
      deal_id: DISPUTE_DEAL_ID,
      buyer: buyer.publicKey,
      seller: seller.publicKey,
      amount: 100,
      criteria_hash: h('c'),
      deadline: disputeDeadline,
    });
    await consent('C8', seller, DISPUTE_DEAL_ID);
    await submit('C8 EscrowFunded', buyer, 'EscrowFunded', {
      deal_id: DISPUTE_DEAL_ID,
      from: buyer.publicKey,
      amount: 100,
    });
    await submit('C8 DeliverableSubmitted', seller, 'DeliverableSubmitted', {
      deal_id: DISPUTE_DEAL_ID,
      content_hash: h('d'),
      precheck_ref: null,
    });
    await submit('C8 DealRejected', buyer, 'DealRejected', {
      deal_id: DISPUTE_DEAL_ID,
      by: buyer.publicKey,
      reason_hash: h('e'),
    });
    await submit('C8 DisputeOpened', buyer, 'DisputeOpened', {
      deal_id: DISPUTE_DEAL_ID,
      by: buyer.publicKey,
    });

    console.log('Adding 12 beacon-padding DealCreated events...');
    for (let i = 0; i < 12; i += 1) {
      const suffix = (i + 1).toString(16).padStart(4, '0');
      await submit(`Padding DealCreated ${i + 1}/12`, buyer, 'DealCreated', {
        deal_id: `00000000-0000-4000-8000-00000000${suffix}`,
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        amount: 2,
        criteria_hash: h('f'),
        deadline: disputeDeadline,
      });
    }

    console.log('Assigning the deterministic three-person jury...');
    let assigned = false;
    let lastError = '';
    for (const roster of permutations(jurors.map((identity) => identity.publicKey))) {
      await sync(j2, 'Juror 2');
      writesStarted = true;
      const result = await clientFor(j2).submit('JuryAssigned', {
        deal_id: DISPUTE_DEAL_ID,
        jurors: roster,
        appeal_round: 0,
      });
      if (result?.ok === true) {
        assigned = true;
        break;
      }
      if (result?.error?.code !== 'JURY_MISMATCH') {
        throw new Error(`JuryAssigned failed unexpectedly: ${result?.error ? JSON.stringify(result.error) : 'unknown error'}`);
      }
      lastError = result.error.message ?? result.error.code;
    }
    if (!assigned) throw new Error(`No jury permutation was accepted: ${lastError}`);

    const finalHealth = await getJson('/v1/health');
    if (finalHealth.tip !== EXPECTED_SETUP_TIP || finalHealth.readOnly !== false) {
      throw new Error(`Setup submitted but final relay tip is ${finalHealth.tip}; expected ${EXPECTED_SETUP_TIP}. Inspect the ledger before continuing.`);
    }
    const assignmentPage = await getJson(`/v1/entries?from=${EXPECTED_SETUP_TIP}&to=${EXPECTED_SETUP_TIP}`);
    const assignmentEntry = assignmentPage.entries?.find((entry) =>
      entry?.event?.type === 'JuryAssigned' && entry.event.payload?.deal_id === DISPUTE_DEAL_ID);
    const acceptedAt = assignmentEntry?.receipt?.acceptedAt;
    const acceptedAtMs = typeof acceptedAt === 'string' ? Date.parse(acceptedAt) : Number.NaN;
    if (!Number.isFinite(acceptedAtMs)) {
      throw new Error('Fresh JuryAssigned receipt has no valid acceptedAt timestamp. Inspect the ledger before asking Juror 1 to vote.');
    }
    const voteDeadline = new Date(acceptedAtMs + cfg.genesisPolicy.voteWindowMs).toISOString();
    console.log(`\nSetup successful. Relay tip: ${EXPECTED_SETUP_TIP}.`);
    console.log(`Policy: ${cfg.genesisPolicy.policyId}; voting window: 14 days.`);
    console.log(`Jury assignment accepted at: ${new Date(acceptedAtMs).toISOString()}.`);
    console.log(`Juror 1 vote deadline: ${voteDeadline}.`);
    console.log('In the SkillX UI, unlock Juror 1, open Jury, and record the Buyer vote. Verify that vote appears in the relay before running finish.');
    return;
  }

  if (tipInfo.tipSequence !== EXPECTED_SETUP_TIP + 1) {
    throw new Error(`Finish refused: expected relay tip ${EXPECTED_SETUP_TIP + 1} after Juror 1's UI vote, got ${tipInfo.tipSequence}. Inspect the ledger first.`);
  }
  const page = await getJson('/v1/entries?from=1&to=500');
  if (!Array.isArray(page.entries)) throw new Error('Relay entries response is invalid.');
  const events = page.entries.map((entry) => entry && entry.event).filter(Boolean);
  const assigned = events.filter((event) =>
    event.type === 'JuryAssigned' && event.payload?.deal_id === DISPUTE_DEAL_ID);
  const uiVotes = events.filter((event) =>
    event.type === 'JuryVoted' && event.payload?.deal_id === DISPUTE_DEAL_ID &&
    event.payload?.juror === uiPublicKey && event.payload?.vote === 'buyer' &&
    event.signer === uiPublicKey);
  const alreadyFinished = events.some((event) =>
    (event.type === 'JuryVoted' && event.payload?.deal_id === DISPUTE_DEAL_ID &&
      (event.payload?.juror === j2.publicKey || event.payload?.juror === j3.publicKey)) ||
    (event.type === 'DisputeResolved' && event.payload?.deal_id === DISPUTE_DEAL_ID));
  if (assigned.length !== 1 || uiVotes.length !== 1 || alreadyFinished) {
    throw new Error('Finish refused: exactly one JuryAssigned and one recorded Juror-1 Buyer vote are required, with no prior Juror-2/Juror-3 vote or resolution. Inspect the ledger first.');
  }

  await submit('Juror 2 JuryVoted (buyer)', j2, 'JuryVoted', {
    deal_id: DISPUTE_DEAL_ID,
    juror: j2.publicKey,
    vote: 'buyer',
    appeal_round: 0,
    sig: signAttestation('jury-vote', {
      deal_id: DISPUTE_DEAL_ID,
      juror: j2.publicKey,
      vote: 'buyer',
      appeal_round: 0,
    }, j2.privateKey),
  });
  await sync(j3, 'Juror 3');
  writesStarted = true;
  requireOk('Juror 3 castVote (seller)', await clientFor(j3).castVote(DISPUTE_DEAL_ID, 'seller'));
  await submit('DisputeResolved (2:1 buyer)', j2, 'DisputeResolved', {
    deal_id: DISPUTE_DEAL_ID,
    outcome: 'buyer',
    appeal_round: 0,
  });

  const finalPage = await getJson('/v1/entries?from=1&to=500');
  const resolved = finalPage.entries?.some((entry) =>
    entry?.event?.type === 'DisputeResolved' &&
    entry.event.payload?.deal_id === DISPUTE_DEAL_ID &&
    entry.event.payload?.outcome === 'buyer');
  if (!resolved) throw new Error('Resolution event was not found in relay history.');
  console.log('\nFinish successful. Verify the resolved deal and escrow state in the SkillX UI.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nC8 fresh jury test failed: ${message}`);
  if (writesStarted) {
    console.error('STOP: ledger writes may already have occurred. Do NOT rerun setup. Inspect the separate test ledger before taking further action.');
  } else {
    console.error('No ledger writes were attempted by this run.');
  }
  process.exitCode = 1;
});