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
import type { Envelope } from '../mailbox-crypto.js';
import type { MessagesStore } from '../messages-store.js';
import type { StoredMessage } from '../messages-store.js';

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

export function render(root: HTMLElement, deps: Deps): () => void {
  const store = deps.messages;
  let baseUrl = deps.storage.get(URL_KEY) ?? '';
  let client: MailboxClient | null = null;
  let lastSeq = 0;

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
  const urlInput = el('input') as HTMLInputElement;
  urlInput.value = baseUrl;
  urlInput.placeholder = 'https://…';
  const urlButton = el('button') as HTMLButtonElement;
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
  const keyButton = el('button') as HTMLButtonElement;
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
  const recipientInput = el('input') as HTMLInputElement;
  const bodyLabel = el('label');
  text(bodyLabel, 'Text');
  const bodyInput = el('textarea') as HTMLTextAreaElement;
  const sendButton = el('button') as HTMLButtonElement;
  text(sendButton, 'Send');
  sendButton.addEventListener('click', () => {
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
        const sendResult = await mailboxClient.send(recipientMailboxId, sealed.value);
        if (!sendResult.ok) {
          setStatus(`Senden: ${sendResult.error.code} ${sendResult.error.message}`);
          return;
        }
        const stored: StoredMessage = {
          serverId: sendResult.value,
          peer: recipient,
          direction: 'out',
          sentAt: deps.clock.nowIso(),
          body,
          seq: null
        };
        store.add(stored);
        bodyInput.value = '';
        setStatus(`Sent (${sendResult.value}).`);
      } catch {
        setStatus('Sending failed.');
      }
    })();
  });
  sendSection.append(recipientLabel, recipientInput, bodyLabel, bodyInput, sendButton);
  container.append(sendSection);

  const inboxSection = el('section', 'inbox');
  const inboxButton = el('button') as HTMLButtonElement;
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
          const deleteButton = el('button') as HTMLButtonElement;
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
