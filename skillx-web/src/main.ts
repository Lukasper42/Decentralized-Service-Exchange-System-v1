import { render as renderMessages } from './views/messages.js';
import type { Deps as MessagesDeps } from './views/messages.js';
import { MessagesStore } from './messages-store.js';
import { checkAndUpdatePin } from './pin.js';
import { checkRelayUrl } from './net-policy.js';
import {
  browserClock,
  browserRandom,
  browserCrypto,
  browserFetch,
  browserFiles,
  browserScheduler,
  browserStorage,
} from './browser-ports.js';
import { Store } from './state.js';
import { ChainVerifier } from './verify.js';
import { RelayClient } from './relay-client.js';
import { syncOnce } from './sync.js';
import { isValidPubkey } from './crypto.js';
import { loadVault } from './vault.js';
import { deriveKeyStatus } from './project.js';
import type { ActionContext, ActionResult } from './actions.js';
import type { TimerHandle } from './ports.js';
import type { ApiError } from './types.js';
import type { Deps } from './views/common.js';
import { formatError } from './format.js';
import { render as renderStatus } from './views/status.js';
import { render as renderIdentity } from './views/identity.js';
import { render as renderAccount } from './views/account.js';
import { render as renderDeals } from './views/deals.js';
import { render as renderJury } from './views/jury.js';
import { render as renderExplorer } from './views/explorer.js';

export const RELAY_URL_KEY = 'skillx.relay.url';
export const RELAY_PUBKEY_KEY = 'skillx.relay.pubkey';
const IDLE_LOCK_MS = 10 * 60 * 1000;
const ROUTES = ['#/status', '#/identity', '#/account', '#/deals', '#/jury', '#/explorer', '#/messages'];

// Global state deliberately exists only in main.ts (no singletons in modules).
const store = new Store();

let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (store.get().unlocked) {
    idleTimer = setTimeout(() => {
      store.set({ unlocked: false, signingKey: null });
    }, IDLE_LOCK_MS);
  }
}

function makeActionContext(): ActionContext | null {
  const s = store.get();
  if (!s.client || !s.verifier || !s.ownPubkey || !s.relayPubkey) {
    return null;
  }
  return {
    crypto: browserCrypto,
    clock: browserClock,
    client: s.client,
    verifier: s.verifier,
    relayPubkey: s.relayPubkey,
    ownPubkey: s.ownPubkey,
    signingKey: s.unlocked ? s.signingKey : null,
    readOnly: s.health !== null && s.health.readOnly,
    transportError: !s.sync.lastSyncOk,
  };
}

function notify(message: string | null, error: ApiError | null): void {
  store.set({ actionMessage: message, actionError: error });
}

async function runAction(result: Promise<ActionResult>): Promise<void> {
  const r = await result;
  if (r.ok) {
    notify('Event sent and acknowledged.', null);
    await synchronize();
  } else {
    notify(null, r.error);
  }
  resetIdleTimer();
}

let syncing = false;

async function synchronize(): Promise<void> {
  const s = store.get();
  if (!s.client || !s.verifier || syncing) {
    return;
  }
  syncing = true;
  store.set({ sync: { ...s.sync, running: true } });
  try {
    const health = await s.client.health();
    if (!health.ok) {
      store.set({ sync: { running: false, lastSyncOk: false, lastError: health.error } });
      return;
    }
    store.set({ health: health.value });
    const tip = await s.client.tip();
    if (!tip.ok) {
      store.set({ sync: { running: false, lastSyncOk: false, lastError: tip.error } });
      return;
    }
    store.set({ tipSequence: tip.value.tipSequence, stateHash: tip.value.stateHash });
    const synced = await syncOnce(s.client, s.verifier, tip.value.tipSequence);
    const broken = s.verifier.isBroken;
    const pinError =
      synced.error === null && !broken && s.relayPubkey !== null
        ? await checkAndUpdatePin(browserCrypto, browserStorage, s.relayPubkey, s.verifier.getEntries())
        : null;
    const outcome = { ...synced, error: synced.error ?? pinError };
    store.set({
      localLength: s.verifier.length,
      entries: [...s.verifier.getEntries()],
      sync: {
        running: false,
        lastSyncOk: outcome.error === null && !broken,
        lastError: outcome.error,
      },
    });
    const cp = await s.client.latestCheckpoint();
    if (cp.ok) {
      const cpCheck = await s.verifier.verifyCheckpoint(cp.value);
      store.set({ checkpoint: cp.value, checkpointVerified: cpCheck.ok });
    } else {
      store.set({ checkpoint: null, checkpointVerified: null });
    }
  } finally {
    syncing = false;
  }
}

async function applyRelayConfig(): Promise<void> {
  const s = store.get();
  if (!s.relayUrl || !s.relayPubkey) {
    return;
  }
  const client = new RelayClient(s.relayUrl, browserFetch);
  const verifier = new ChainVerifier(browserCrypto, s.relayPubkey);
  await verifier.init();
  store.set({
    client,
    verifier,
    entries: [],
    localLength: 0,
    checkpoint: null,
    checkpointVerified: null,
  });
  browserStorage.set(RELAY_URL_KEY, s.relayUrl);
  browserStorage.set(RELAY_PUBKEY_KEY, s.relayPubkey);
  await synchronize();
}

const deps: Deps = {
  store,
  makeActionContext,
  runAction,
  notify,
  applyRelayConfig,
  resetIdleTimer,
  saveFile: (name, text) => browserFiles.save(name, text),
  pickFile: () => browserFiles.pick(),
  keyStatusOf: (pubkey, entries) => deriveKeyStatus(entries, pubkey),
};

const messagesStore = new MessagesStore(browserCrypto, browserStorage, browserRandom);
store.subscribe((state) => {
  if (!state.unlocked) {
    messagesStore.clear();
  }
});
const messagesDeps: MessagesDeps = {
  crypto: browserCrypto,
  clock: browserClock,
  random: browserRandom,
  storage: browserStorage,
  fetch: browserFetch,
  messages: messagesStore,
  getIdentity: () => {
    const s = store.get();
    return s.unlocked && s.signingKey !== null && s.ownPubkey !== null
      ? { pubkey: s.ownPubkey, edKey: s.signingKey }
      : null;
  },
};

let currentCleanup: (() => void) | null = null;
let pollHandle: TimerHandle | null = null;

function route(): void {
  const hash = location.hash;
  const target = ROUTES.includes(hash) ? hash : '#/status';
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }
  if (pollHandle !== null) {
    browserScheduler.clear(pollHandle);
    pollHandle = null;
  }
  const root = document.getElementById('main');
  if (!root) {
    return;
  }
  const renderer =
    target === '#/identity'
      ? renderIdentity
      : target === '#/account'
        ? renderAccount
        : target === '#/deals'
          ? renderDeals
          : target === '#/jury'
            ? renderJury
            : target === '#/explorer'
              ? renderExplorer
              : renderStatus;
  currentCleanup = target === '#/messages' ? renderMessages(root, messagesDeps) : renderer(root, deps);
  // Polling every 15 s; torn down when leaving the view (see cleanup above).
  pollHandle = browserScheduler.every(15000, () => {
    void synchronize();
  });
}

function boot(): void {
  const url = browserStorage.get(RELAY_URL_KEY);
  const pk = browserStorage.get(RELAY_PUBKEY_KEY);
  const checked = url ? checkRelayUrl(url) : null;
  if (checked?.ok && pk && isValidPubkey(pk)) {
    store.set({ relayUrl: checked.url, relayPubkey: pk });
    void applyRelayConfig();
  }
  const vault = loadVault(browserStorage);
  if (vault.ok) {
    store.set({ vault: vault.value, ownPubkey: vault.value.publicKey });
  }
  window.addEventListener('hashchange', route);
  for (const ev of ['click', 'keydown']) {
    window.addEventListener(ev, resetIdleTimer);
  }
  route();
  void formatError; // Format library stays available for error display in the views.
}

boot();
