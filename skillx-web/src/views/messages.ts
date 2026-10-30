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
  text(title, 'Nachrichten');
  container.append(title);

  const hint = el('p', 'hint');
  text(hint, 'Der Postfach-Server sieht IP-Adresse und Zugriffszeiten. Nutze Tor/VPN.');
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
  text(urlLabel, 'Postfach-URL');
  const urlInput = el('input') as HTMLInputElement;
  urlInput.value = baseUrl;
  urlInput.placeholder = 'https://…';
  const urlButton = el('button') as HTMLButtonElement;
  text(urlButton, 'URL speichern');
  urlButton.addEventListener('click', () => {
    const checked = checkRelayUrl(urlInput.value.trim());
    if (!checked.ok) {
      setStatus(`Ungültige URL: ${checked.reason}`);
      return;
    }
    deps.storage.set(URL_KEY, checked.url);
    baseUrl = checked.url;
    client = new MailboxClient(checked.url, deps.fetch);
    setStatus('Postfach-URL gespeichert.');
  });
  urlSection.append(urlLabel, urlInput, urlButton);
  container.append(urlSection);

  const keySection = el('section', 'key-bundle');
  const keyButton = el('button') as HTMLButtonElement;
  text(keyButton, 'Schlüsselbündel veröffentlichen');
  const keyStatus = el('div', 'key-status');
  text(keyStatus, '');
  keyButton.addEventListener('click', () => {
    void (async () => {
      const identity = deps.getIdentity();
      if (identity === null) {
        setStatus('Keine entsperrte Identität.');
        return;
      }
      const mailboxClient = getClient();
      if (mailboxClient === null) {
        setStatus('Bitte zuerst eine gültige Postfach-URL setzen.');
        return;
      }
      try {
        const derived = await deriveMessagingKey(deps.crypto, identity.edKey);
        if (!derived.ok) {
          setStatus(`Schlüssel: ${derived.error.message}`);
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
          setStatus(`Schlüsselbündel: ${result.error.code} ${result.error.message}`);
          return;
        }
        text(keyStatus, `X25519: ${key.xPubkey}`);
        setStatus(`Schlüsselbündel veröffentlicht (${result.value.status}).`);
      } catch {
        setStatus('Schlüsselbündel konnte nicht erstellt werden.');
      }
    })();
  });
  keySection.append(keyButton, keyStatus);
  container.append(keySection);

  const sendSection = el('section', 'send-message');
  const recipientLabel = el('label');
  text(recipientLabel, 'Empfänger (Identity-Pubkey)');
  const recipientInput = el('input') as HTMLInputElement;
  const bodyLabel = el('label');
  text(bodyLabel, 'Text');
  const bodyInput = el('textarea') as HTMLTextAreaElement;
  const sendButton = el('button') as HTMLButtonElement;
  text(sendButton, 'Senden');
  sendButton.addEventListener('click', () => {
    void (async () => {
      const identity = deps.getIdentity();
      if (identity === null) {
        setStatus('Keine entsperrte Identität.');
        return;
      }
      const mailboxClient = getClient();
      if (mailboxClient === null) {
        setStatus('Bitte zuerst eine gültige Postfach-URL setzen.');
        return;
      }
      const recipient = recipientInput.value.trim();
      const body = bodyInput.value;
      if (recipient.length === 0) {
        setStatus('Bitte Empfänger angeben.');
        return;
      }
      if (body.length === 0) {
        setStatus('Bitte Text angeben.');
        return;
      }
      if (!isValidPubkey(recipient)) {
        setStatus('Ungültiger Empfänger-Pubkey (erwartet: Base64, 44 Bytes SPKI).');
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
        setStatus(`Gesendet (${sendResult.value}).`);
      } catch {
        setStatus('Senden fehlgeschlagen.');
      }
    })();
  });
  sendSection.append(recipientLabel, recipientInput, bodyLabel, bodyInput, sendButton);
  container.append(sendSection);

  const inboxSection = el('section', 'inbox');
  const inboxButton = el('button') as HTMLButtonElement;
  text(inboxButton, 'Posteingang abrufen');
  const inboxList = el('div', 'inbox-list');
  const inboxStatus = el('div', 'inbox-status');
  text(inboxStatus, '');

  function renderInbox(): void {
    inboxList.replaceChildren();
    const groups = store.listByPeer();
    if (groups.size === 0) {
      const empty = el('p');
      text(empty, 'Keine Nachrichten.');
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
        text(meta, `${message.direction === 'in' ? 'Empfangen' : 'Gesendet'} ${message.sentAt}`);
        row.append(meta);
        const body = el('div', 'body');
        text(body, message.body);
        row.append(body);
        if (message.direction === 'in') {
          const deleteButton = el('button') as HTMLButtonElement;
          text(deleteButton, 'Löschen');
          deleteButton.addEventListener('click', () => {
            void (async () => {
              const identity = deps.getIdentity();
              if (identity === null) {
                setStatus('Keine entsperrte Identität.');
                return;
              }
              const mailboxClient = getClient();
              if (mailboxClient === null) {
                setStatus('Bitte zuerst eine gültige Postfach-URL setzen.');
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
                  setStatus(`Löschen: ${result.error.code} ${result.error.message}`);
                  return;
                }
                store.remove(message.serverId);
                renderInbox();
                setStatus('Nachricht gelöscht.');
              } catch {
                setStatus('Löschen fehlgeschlagen.');
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
        setStatus('Keine entsperrte Identität.');
        return;
      }
      const mailboxClient = getClient();
      if (mailboxClient === null) {
        setStatus('Bitte zuerst eine gültige Postfach-URL setzen.');
        return;
      }
      try {
        const derived = await deriveMessagingKey(deps.crypto, identity.edKey);
        if (!derived.ok) {
          setStatus(`Schlüssel: ${derived.error.message}`);
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
          setStatus(`Posteingang: ${result.error.code} ${result.error.message}`);
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
        text(inboxStatus, `${openedCount} neue Nachricht(en) geladen.`);
        setStatus('Posteingang aktualisiert.');
      } catch {
        setStatus('Posteingang konnte nicht geladen werden.');
      }
    })();
  });

  inboxSection.append(inboxButton, inboxStatus, inboxList);
  container.append(inboxSection);

  const historySection = el('section', 'history');
  const historyLabel = el('label');
  text(historyLabel, 'Passwort für den lokalen Verlauf (verschlüsselt, mind. 16 Zeichen)');
  const historyPw = el('input');
  historyPw.type = 'password';
  historyPw.autocomplete = 'off';
  const saveHistory = el('button');
  text(saveHistory, 'Verlauf verschlüsselt speichern');
  const loadHistory = el('button');
  text(loadHistory, 'Verlauf laden');
  saveHistory.addEventListener('click', () => {
    void (async () => {
      if (historyPw.value.length < 16) {
        setStatus('Passwort zu kurz (mindestens 16 Zeichen).');
        return;
      }
      const r = await store.persist(historyPw.value);
      historyPw.value = '';
      setStatus(r.ok ? 'Verlauf gespeichert.' : `Verlauf: ${r.error.message}`);
    })();
  });
  loadHistory.addEventListener('click', () => {
    void (async () => {
      const r = await store.load(historyPw.value);
      historyPw.value = '';
      if (!r.ok) {
        setStatus(`Verlauf: ${r.error.message}`);
        return;
      }
      setStatus(r.value ? 'Verlauf geladen.' : 'Kein gespeicherter Verlauf.');
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
