import type { ClockPort, CryptoPort, FetchPort, RandomPort, StoragePort } from '../ports.js';
import { checkRelayUrl } from '../net-policy.js';
import { isValidPubkey } from '../crypto.js';
import { bundleLookupMessage } from '../format.js';
import { el, text } from './common.js';
import { MailboxClient } from '../mailbox-client.js';
import {
  buildAuthHeader,
  createKeyBundle,
  deriveMessagingKey,
  mailboxId,
  openMessage,
  sealMessage
} from '../mailbox-crypto.js';
import type { MessagesStore } from '../messages-store.js';
import type { StoredMessage } from '../messages-store.js';
import type { Envelope } from '../mailbox-crypto.js';

export interface Deps {
  crypto: CryptoPort;
  clock: ClockPort;
  random: RandomPort;
  storage: StoragePort;
  fetch: FetchPort;
  messages: MessagesStore;
  getIdentity: () => { pubkey: string; edKey: CryptoKey } | null;
}

const URL_KEY = 'skillx.mailbox.url';
const PENDING_SEND_KEY = 'skillx.mailbox.pending-send.v1';

interface PendingSend {
  identityPubkey: string;
  recipientPubkey: string;
  mailboxUrl: string;
  body?: string; // Kept only in memory; never persisted.
  mailboxId: string;
  envelope: Envelope;
  idempotencyKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPendingSend(storage: StoragePort): PendingSend | null {
  try {
    const raw = storage.get(PENDING_SEND_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error('invalid pending send');

    const identityPubkey = value['identityPubkey'];
    const recipientPubkey = value['recipientPubkey'];
    const mailboxUrl = value['mailboxUrl'];
    const mailboxIdValue = value['mailboxId'];
    const idempotencyKey = value['idempotencyKey'];
    const rawEnvelope = value['envelope'];
    const checkedUrl = typeof mailboxUrl === 'string' ? checkRelayUrl(mailboxUrl) : null;

    if (typeof identityPubkey !== 'string' || !isValidPubkey(identityPubkey) ||
        typeof recipientPubkey !== 'string' || !isValidPubkey(recipientPubkey) ||
        typeof mailboxUrl !== 'string' || checkedUrl === null || !checkedUrl.ok ||
        checkedUrl.url !== mailboxUrl ||
        typeof mailboxIdValue !== 'string' || !/^[0-9a-f]{64}$/.test(mailboxIdValue) ||
        typeof idempotencyKey !== 'string' || !/^[0-9a-f]{32}$/.test(idempotencyKey) ||
        !isRecord(rawEnvelope) || rawEnvelope['v'] !== 1 ||
        typeof rawEnvelope['eph_pub'] !== 'string' ||
        typeof rawEnvelope['iv'] !== 'string' ||
        typeof rawEnvelope['ct'] !== 'string') {
      throw new Error('invalid pending send');
    }

    return {
      identityPubkey,
      recipientPubkey,
      mailboxUrl,
      mailboxId: mailboxIdValue,
      envelope: {
        v: 1,
        eph_pub: rawEnvelope['eph_pub'],
        iv: rawEnvelope['iv'],
        ct: rawEnvelope['ct'],
      },
      idempotencyKey,
    };
  } catch {
    try { storage.remove(PENDING_SEND_KEY); } catch { /* Keep rendering available if storage is unavailable. */ }
    return null;
  }
}

function persistPendingSend(storage: StoragePort, pending: PendingSend): void {
  // Only ciphertext and retry metadata are persisted. The plaintext body is deliberately omitted.
  storage.set(PENDING_SEND_KEY, JSON.stringify({
    identityPubkey: pending.identityPubkey,
    recipientPubkey: pending.recipientPubkey,
    mailboxUrl: pending.mailboxUrl,
    mailboxId: pending.mailboxId,
    envelope: pending.envelope,
    idempotencyKey: pending.idempotencyKey,
  }));
}

function makeIdempotencyKey(random: RandomPort): string {
  const bytes = random.bytes(16);
  if (bytes.length !== 16) throw new Error('random source returned an invalid id');
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function render(root: HTMLElement, deps: Deps): () => void {
  const store = deps.messages;
  let baseUrl = deps.storage.get(URL_KEY) ?? '';
  let client: MailboxClient | null = null;
  let lastSeq = 0;
  let pendingSend: PendingSend | null = readPendingSend(deps.storage);

  const container = el('div', 'messages-view');
  const title = el('h2');
  text(title, 'Messages');
  container.append(title);

  const hint = el('p', 'hint');
  text(hint, 'The mailbox server sees your IP address and access times. Use Tor/VPN.');
  container.append(hint);

  const status = el('div', 'status');
  text(status, '');
  container.append(status);

  function setStatus(value: string): void {
    text(status, value);
  }

  if (pendingSend !== null) {
    setStatus('A pending encrypted send was restored. Retry it or discard it before sending a new message.');
  }

  function getClient(): MailboxClient | null {
    if (client !== null) return client;
    const checked = checkRelayUrl(baseUrl);
    if (!checked.ok) return null;
    client = new MailboxClient(checked.url, deps.fetch);
    return client;
  }

  const urlSection = el('section', 'mailbox-url');
  const urlLabel = el('label');
  text(urlLabel, 'Mailbox URL');
  const urlInput = el('input');
  urlInput.value = baseUrl;
  urlInput.placeholder = 'https://…';
  const urlButton = el('button');
  text(urlButton, 'Save URL');
  urlButton.addEventListener('click', () => {
    const checked = checkRelayUrl(urlInput.value.trim());
    if (!checked.ok) {
      setStatus(`Invalid URL: ${checked.reason}`);
      return;
    }
    deps.storage.set(URL_KEY, checked.url);
    baseUrl = checked.url;
    client = new MailboxClient(checked.url, deps.fetch);
    setStatus('Mailbox URL saved.');
  });
  urlSection.append(urlLabel, urlInput, urlButton);
  container.append(urlSection);

  const keySection = el('section', 'key-bundle');
  const keyButton = el('button');
  text(keyButton, 'Publish key bundle');
  const keyStatus = el('div', 'key-status');
  text(keyStatus, '');
  keyButton.addEventListener('click', () => {
    void (async () => {
      const identity = deps.getIdentity();
      if (identity === null) {
        setStatus('No unlocked identity.');
        return;
      }
      const mailboxClient = getClient();
      if (mailboxClient === null) {
        setStatus('Please set a valid mailbox URL first.');
        return;
      }
      try {
        const derived = await deriveMessagingKey(deps.crypto, identity.edKey);
        if (!derived.ok) {
          setStatus(`Key: ${derived.error.message}`);
          return;
        }
        const key = derived.value;
        const bundle = await createKeyBundle(
          deps.crypto,
          identity.pubkey,
          identity.edKey,
          key.xPubkey,
          deps.clock.nowIso()
        );
        const result = await mailboxClient.putKeyBundle(bundle);
        if (!result.ok) {
          setStatus(`Key bundle: ${result.error.code} ${result.error.message}`);
          return;
        }
        text(keyStatus, `X25519: ${key.xPubkey}`);
        setStatus(`Key bundle published (${result.value.status}).`);
      } catch {
        setStatus('Key bundle could not be created.');
      }
    })();
  });
  keySection.append(keyButton, keyStatus);
  container.append(keySection);

  const sendSection = el('section', 'send-message');
  const recipientLabel = el('label');
  text(recipientLabel, 'Recipient (identity pubkey)');
  const recipientInput = el('input');
  const bodyLabel = el('label');
  text(bodyLabel, 'Text');
  const bodyInput = el('textarea');
  const sendButton = el('button');
  text(sendButton, 'Send');
  const retryPendingButton = el('button');
  text(retryPendingButton, 'Retry pending send');
  retryPendingButton.hidden = pendingSend === null;
  const discardPendingButton = el('button');
  text(discardPendingButton, 'Discard pending retry');
  discardPendingButton.hidden = pendingSend === null;
  sendButton.disabled = pendingSend !== null;
  recipientInput.value = pendingSend?.recipientPubkey ?? '';
  recipientInput.disabled = pendingSend !== null;

  let sending = false;

  function clearPendingSend(): boolean {
    try {
      deps.storage.remove(PENDING_SEND_KEY);
      pendingSend = null;
      retryPendingButton.hidden = true;
      discardPendingButton.hidden = true;
      sendButton.disabled = false;
      recipientInput.disabled = false;
      return true;
    } catch {
      setStatus('Could not clear the saved retry state. Keep using Retry pending send; do not start a new message yet.');
      return false;
    }
  }

  retryPendingButton.addEventListener('click', () => {
    if (sending || pendingSend === null) return;
    const pending = pendingSend;
    sending = true;
    retryPendingButton.disabled = true;
    discardPendingButton.disabled = true;
    void (async () => {
      const identity = deps.getIdentity();
      if (identity === null || identity.pubkey !== pending.identityPubkey) {
        setStatus('Unlock the same sending identity before retrying this pending message.');
        return;
      }
      const checked = checkRelayUrl(pending.mailboxUrl);
      if (!checked.ok) {
        setStatus('The saved mailbox URL is invalid. The pending encrypted message has not been changed.');
        return;
      }
      try {
        const retryClient = new MailboxClient(checked.url, deps.fetch);
        const result = await retryClient.send(
          pending.mailboxId,
          pending.envelope,
          pending.idempotencyKey
        );
        if (!result.ok) {
          setStatus(`Retry: ${result.error.code} ${result.error.message}. The same encrypted request is still saved; retry again or discard it.`);
          return;
        }
        if (!clearPendingSend()) return;

        if (pending.body !== undefined) {
          store.add({
            serverId: result.value,
            peer: pending.recipientPubkey,
            direction: 'out',
            sentAt: deps.clock.nowIso(),
            body: pending.body,
            seq: null
          });
          bodyInput.value = '';
          setStatus(`Sent (${result.value}).`);
        } else {
          setStatus(`Pending send confirmed (${result.value}). The message text was not retained after reopening, so it was not added to local history.`);
        }
      } catch {
        setStatus('Retry failed. The same encrypted request is still saved; retry again to avoid creating a duplicate.');
      }
    })().finally(() => {
      sending = false;
      retryPendingButton.disabled = false;
      discardPendingButton.disabled = false;
    });
  });

  discardPendingButton.addEventListener('click', () => {
    if (pendingSend === null || sending) return;
    if (!clearPendingSend()) return;
    setStatus('Pending retry discarded. The previous message may already have been delivered.');
  });

  sendButton.addEventListener('click', () => {
    if (sending) return;
    if (pendingSend !== null) {
      setStatus('A previous send is still pending. Retry it or discard it before sending a new message.');
      return;
    }
    sending = true;
    sendButton.disabled = true;
    void (async () => {
      const identity = deps.getIdentity();
      if (identity === null) {
        setStatus('No unlocked identity.');
        return;
      }
      const mailboxClient = getClient();
      if (mailboxClient === null) {
        setStatus('Please set a valid mailbox URL first.');
        return;
      }
      const recipient = recipientInput.value.trim();
      const body = bodyInput.value;
      if (recipient.length === 0) {
        setStatus('Please enter a recipient.');
        return;
      }
      if (body.length === 0) {
        setStatus('Please enter a message text.');
        return;
      }
      if (!isValidPubkey(recipient)) {
        setStatus('Invalid recipient pubkey (expected: Base64, 44 bytes SPKI).');
        return;
      }

      try {
        const recipientMailboxId = await mailboxId(deps.crypto, recipient);
        const bundleResult = await mailboxClient.getKeyBundle(recipientMailboxId);
        if (!bundleResult.ok) {
          setStatus(bundleLookupMessage(bundleResult.error.code));
          return;
        }
        const sealed = await sealMessage(deps.crypto, deps.random, deps.clock, {
          from: identity.pubkey,
          edKey: identity.edKey,
          recipientBundle: bundleResult.value,
          body
        });
        if (!sealed.ok) {
          setStatus(`Senden: ${sealed.error.code} ${sealed.error.message}`);
          return;
        }

        const pending: PendingSend = {
          identityPubkey: identity.pubkey,
          recipientPubkey: recipient,
          mailboxUrl: baseUrl,
          body,
          mailboxId: recipientMailboxId,
          envelope: sealed.value,
          idempotencyKey: makeIdempotencyKey(deps.random),
        };
        try {
          persistPendingSend(deps.storage, pending);
        } catch {
          setStatus('The encrypted retry state could not be saved locally. The message was not sent.');
          return;
        }
        pendingSend = pending;
        retryPendingButton.hidden = false;
        discardPendingButton.hidden = false;
        recipientInput.disabled = true;

        const result = await mailboxClient.send(
          pending.mailboxId,
          pending.envelope,
          pending.idempotencyKey
        );
        if (!result.ok) {
          setStatus(`Senden: ${result.error.code} ${result.error.message}. The exact encrypted request is saved; use Retry pending send to safely repeat it.`);
          return;
        }
        if (!clearPendingSend()) return;

        store.add({
          serverId: result.value,
          peer: recipient,
          direction: 'out',
          sentAt: deps.clock.nowIso(),
          body,
          seq: null
        });
        bodyInput.value = '';
        setStatus(`Sent (${result.value}).`);
      } catch {
        setStatus('Sending failed. The exact encrypted request is saved; use Retry pending send to avoid creating a duplicate.');
      }
    })().finally(() => {
      sending = false;
      sendButton.disabled = pendingSend !== null;
      retryPendingButton.disabled = false;
      discardPendingButton.disabled = false;
    });
  });

  sendSection.append(
    recipientLabel,
    recipientInput,
    bodyLabel,
    bodyInput,
    sendButton,
    retryPendingButton,
    discardPendingButton
  );
  container.append(sendSection);

  const inboxSection = el('section', 'inbox');
  const inboxButton = el('button');
  text(inboxButton, 'Fetch inbox');
  const inboxList = el('div', 'inbox-list');
  const inboxStatus = el('div', 'inbox-status');
  text(inboxStatus, '');

  function renderInbox(): void {
    inboxList.replaceChildren();
    const groups = store.listByPeer();
    if (groups.size === 0) {
      const empty = el('p');
      text(empty, 'No messages.');
      inboxList.append(empty);
      return;
    }
    for (const [peer, messages] of groups) {
      const section = el('section', 'conversation');
      const heading = el('h3');
      text(heading, peer);
      section.append(heading);
      for (const message of messages) {
        const row = el('div', 'message');
        const meta = el('div', 'meta');
        text(meta, `${message.direction === 'in' ? 'Received' : 'Sent'} ${message.sentAt}`);
        row.append(meta);
        const body = el('div', 'body');
        text(body, message.body);
        row.append(body);
        if (message.direction === 'in') {
          const deleteButton = el('button');
          text(deleteButton, 'Delete');
          deleteButton.addEventListener('click', () => {
            void (async () => {
              const identity = deps.getIdentity();
              if (identity === null) {
                setStatus('No unlocked identity.');
                return;
              }
              const mailboxClient = getClient();
              if (mailboxClient === null) {
                setStatus('Please set a valid mailbox URL first.');
                return;
              }
              try {
                const myMailboxId = await mailboxId(deps.crypto, identity.pubkey);
                const path = `/v1/mailbox/${myMailboxId}/messages/${message.serverId}`;
                const auth = await buildAuthHeader(
                  deps.crypto,
                  identity.pubkey,
                  identity.edKey,
                  'DELETE',
                  path,
                  Math.floor(deps.clock.nowMs() / 1000)
                );
                const result = await mailboxClient.deleteMessage(
                  myMailboxId,
                  message.serverId,
                  auth
                );
                if (!result.ok) {
                  setStatus(`Delete: ${result.error.code} ${result.error.message}`);
                  return;
                }
                store.remove(message.serverId);
                renderInbox();
                setStatus('Message deleted.');
              } catch {
                setStatus('Deleting failed.');
              }
            })();
          });
          row.append(deleteButton);
        }
        section.append(row);
      }
      inboxList.append(section);
    }
  }

  inboxButton.addEventListener('click', () => {
    void (async () => {
      const identity = deps.getIdentity();
      if (identity === null) {
        setStatus('No unlocked identity.');
        return;
      }
      const mailboxClient = getClient();
      if (mailboxClient === null) {
        setStatus('Please set a valid mailbox URL first.');
        return;
      }
      try {
        const derived = await deriveMessagingKey(deps.crypto, identity.edKey);
        if (!derived.ok) {
          setStatus(`Key: ${derived.error.message}`);
          return;
        }
        const key = derived.value;
        const myMailboxId = await mailboxId(deps.crypto, identity.pubkey);
        const path = `/v1/mailbox/${myMailboxId}/messages`;
        const auth = await buildAuthHeader(
          deps.crypto,
          identity.pubkey,
          identity.edKey,
          'GET',
          path,
          Math.floor(deps.clock.nowMs() / 1000)
        );
        const result = await mailboxClient.fetchMessages(myMailboxId, auth, lastSeq);
        if (!result.ok) {
          setStatus(`Inbox: ${result.error.code} ${result.error.message}`);
          return;
        }
        let openedCount = 0;
        for (const entry of result.value.messages) {
          const opened = await openMessage(
            deps.crypto,
            myMailboxId,
            key.xPrivatePkcs8,
            entry.envelope
          );
          if (!opened.ok) continue;
          const stored: StoredMessage = {
            serverId: entry.id,
            peer: opened.value.from,
            direction: 'in',
            sentAt: opened.value.sentAt,
            body: opened.value.body,
            seq: entry.seq
          };
          store.add(stored);
          openedCount += 1;
        }
        lastSeq = result.value.next;
        renderInbox();
        text(inboxStatus, `${openedCount} new message(s) loaded.`);
        setStatus('Inbox updated.');
      } catch {
        setStatus('Inbox could not be loaded.');
      }
    })();
  });

  inboxSection.append(inboxButton, inboxStatus, inboxList);
  container.append(inboxSection);

  const historySection = el('section', 'history');
  const historyLabel = el('label');
  text(historyLabel, 'Password for the local history (encrypted, min. 16 characters)');
  const historyPw = el('input');
  historyPw.type = 'password';
  historyPw.autocomplete = 'off';
  const saveHistory = el('button');
  text(saveHistory, 'Save history encrypted');
  const loadHistory = el('button');
  text(loadHistory, 'Load history');
  saveHistory.addEventListener('click', () => {
    void (async () => {
      if (historyPw.value.length < 16) {
        setStatus('Password too short (at least 16 characters).');
        return;
      }
      const r = await store.persist(historyPw.value);
      historyPw.value = '';
      setStatus(r.ok ? 'History saved.' : `History: ${r.error.message}`);
    })();
  });
  loadHistory.addEventListener('click', () => {
    void (async () => {
      const r = await store.load(historyPw.value);
      historyPw.value = '';
      if (!r.ok) {
        setStatus(`History: ${r.error.message}`);
        return;
      }
      setStatus(r.value ? 'History loaded.' : 'No saved history.');
      renderInbox();
    })();
  });
  historySection.append(historyLabel, historyPw, saveHistory, loadHistory);
  container.append(historySection);

  renderInbox();
  root.append(container);
  return () => {
    root.replaceChildren();
  };
}
