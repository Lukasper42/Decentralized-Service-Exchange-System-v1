import { el, liveRegion, text, type Deps } from './common.js';
import { isValidPubkey } from '../crypto.js';
import { formatError, shortHash } from '../format.js';
import { checkRelayUrl } from '../net-policy.js';
import { clearPin } from '../pin.js';
import { browserStorage } from '../browser-ports.js';

export function render(root: HTMLElement, deps: Deps): () => void {
  root.replaceChildren();
  const h = el('h2');
  text(h, 'Status');
  root.append(h);

  const banner = el('div', 'error');
  banner.setAttribute('role', 'alert');
  banner.hidden = true;
  root.append(banner);

  const privacy = el('p', 'notice');
  text(
    privacy,
    'Anonymität: Der Relay sieht deine IP-Adresse und Zugriffszeiten. Diese UI kann sie nicht verbergen. Nutze den Tor Browser (am besten mit einem .onion-Relay) oder ein vertrauenswürdiges VPN. Dein Pseudonym (Public Key) ist auf der Kette öffentlich.',
  );
  root.append(privacy);

  const form = el('form');
  const urlLabel = el('label');
  urlLabel.htmlFor = 'relay-url';
  text(urlLabel, 'Relay-URL');
  const urlInput = el('input');
  urlInput.id = 'relay-url';
  urlInput.type = 'url';
  urlInput.autocomplete = 'off';
  urlInput.value = deps.store.get().relayUrl;
  const pkLabel = el('label');
  pkLabel.htmlFor = 'relay-pubkey';
  text(pkLabel, 'Gepinnter Relay-Pubkey (Base64, 44 Bytes SPKI)');
  const pkInput = el('input');
  pkInput.id = 'relay-pubkey';
  pkInput.type = 'text';
  pkInput.spellcheck = false;
  pkInput.value = deps.store.get().relayPubkey ?? '';
  const saveBtn = el('button', 'btn');
  saveBtn.type = 'submit';
  text(saveBtn, 'Speichern und verbinden');
  const statusMsg = liveRegion();
  form.append(urlLabel, urlInput, pkLabel, pkInput, saveBtn, statusMsg);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const url = urlInput.value.trim();
    const pk = pkInput.value.trim();
    const check = checkRelayUrl(url);
    if (!check.ok) {
      text(statusMsg, check.reason);
      return;
    }
    if (!isValidPubkey(pk)) {
      text(
        statusMsg,
        'Ungültiger Relay-Pubkey (striktes Base64, 44 Bytes, SPKI-Präfix erforderlich).',
      );
      return;
    }
    deps.store.set({ relayUrl: check.url, relayPubkey: pk });
    deps.notify('Relay konfiguriert.', null);
    void deps.applyRelayConfig();
  });
  root.append(form);

  const pinBtn = el('button', 'btn');
  pinBtn.type = 'button';
  text(pinBtn, 'Gemerkten Kettenstand zurücksetzen');
  pinBtn.addEventListener('click', () => {
    clearPin(browserStorage);
    text(statusMsg, 'Gemerkter Kettenstand gelöscht (nur nötig, wenn der Relay bewusst zurückgesetzt wurde).');
  });
  root.append(pinBtn);

  const dl = el('dl');
  function term(label: string, id: string): void {
    const dt = el('dt');
    text(dt, label);
    const dd = el('dd');
    dd.id = id;
    text(dd, '–');
    dl.append(dt, dd);
  }
  term('Health', 'st-health');
  term('readOnly', 'st-readonly');
  term('tipSequence', 'st-tip');
  term('stateHash', 'st-statehash');
  term('Lokal verifizierte Länge', 'st-local');
  term('Letzter Checkpoint (Sequenz)', 'st-cp');
  term('Checkpoint geprüft', 'st-cp-ok');
  root.append(dl);

  const setDd = (id: string, v: string): void => {
    const n = document.getElementById(id);
    if (n) {
      text(n, v);
    }
  };

  const unsubscribe = deps.store.subscribeNow((s) => {
    setDd('st-health', s.health ? (s.health.ok ? 'ok' : 'Fehler') : 'keine Daten');
    setDd('st-readonly', s.health ? (s.health.readOnly ? 'ja' : 'nein') : '–');
    setDd('st-tip', s.tipSequence === null ? '–' : String(s.tipSequence));
    setDd('st-statehash', s.stateHash ? shortHash(s.stateHash) : '–');
    setDd('st-local', String(s.localLength));
    setDd('st-cp', s.checkpoint ? String(s.checkpoint.sequence) : 'kein');
    setDd(
      'st-cp-ok',
      s.checkpointVerified === null ? '–' : s.checkpointVerified ? 'ja' : 'nein',
    );
    const broken = s.verifier !== null && s.verifier.isBroken;
    if (broken && s.verifier) {
      const e = s.verifier.broken;
      banner.hidden = false;
      text(
        banner,
        `Divergenz erkannt: ${e ? formatError(e) : 'unbekannter Fehler'} – Aktionen gesperrt.`,
      );
    } else if (s.sync.lastError) {
      banner.hidden = false;
      text(banner, `Sync-Fehler: ${formatError(s.sync.lastError)}`);
    } else {
      banner.hidden = true;
      text(banner, '');
    }
  });

  return () => {
    unsubscribe();
    root.replaceChildren();
  };
}
