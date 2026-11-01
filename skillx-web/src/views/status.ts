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
    'Anonymity: the relay sees your IP address and access times. This UI cannot hide them. Use Tor Browser (ideally with an .onion relay) or a trustworthy VPN. Your pseudonym (public key) is public on the chain.',
  );
  root.append(privacy);

  const form = el('form');
  const urlLabel = el('label');
  urlLabel.htmlFor = 'relay-url';
  text(urlLabel, 'Relay URL');
  const urlInput = el('input');
  urlInput.id = 'relay-url';
  urlInput.type = 'url';
  urlInput.autocomplete = 'off';
  urlInput.value = deps.store.get().relayUrl;
  const pkLabel = el('label');
  pkLabel.htmlFor = 'relay-pubkey';
  text(pkLabel, 'Pinned relay pubkey (Base64, 44 bytes SPKI)');
  const pkInput = el('input');
  pkInput.id = 'relay-pubkey';
  pkInput.type = 'text';
  pkInput.spellcheck = false;
  pkInput.value = deps.store.get().relayPubkey ?? '';
  const saveBtn = el('button', 'btn');
  saveBtn.type = 'submit';
  text(saveBtn, 'Save and connect');
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
      text(statusMsg, 'Invalid relay pubkey (strict Base64, 44 bytes, SPKI prefix required).');
      return;
    }
    deps.store.set({ relayUrl: check.url, relayPubkey: pk });
    deps.notify('Relay configured.', null);
    void deps.applyRelayConfig();
  });
  root.append(form);

  const pinBtn = el('button', 'btn');
  pinBtn.type = 'button';
  text(pinBtn, 'Reset remembered chain state');
  pinBtn.addEventListener('click', () => {
    clearPin(browserStorage);
    text(
      statusMsg,
      'Remembered chain state cleared (only needed if the relay was reset on purpose).',
    );
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
  term('Locally verified length', 'st-local');
  term('Latest checkpoint (sequence)', 'st-cp');
  term('Checkpoint verified', 'st-cp-ok');
  root.append(dl);

  const setDd = (id: string, v: string): void => {
    const n = document.getElementById(id);
    if (n) {
      text(n, v);
    }
  };

  const unsubscribe = deps.store.subscribeNow((s) => {
    setDd('st-health', s.health ? (s.health.ok ? 'ok' : 'error') : 'no data');
    setDd('st-readonly', s.health ? (s.health.readOnly ? 'yes' : 'no') : '–');
    setDd('st-tip', s.tipSequence === null ? '–' : String(s.tipSequence));
    setDd('st-statehash', s.stateHash ? shortHash(s.stateHash) : '–');
    setDd('st-local', String(s.localLength));
    setDd('st-cp', s.checkpoint ? String(s.checkpoint.sequence) : 'none');
    setDd(
      'st-cp-ok',
      s.checkpointVerified === null ? '–' : s.checkpointVerified ? 'yes' : 'no',
    );
    const broken = s.verifier !== null && s.verifier.isBroken;
    if (broken && s.verifier) {
      const e = s.verifier.broken;
      banner.hidden = false;
      text(
        banner,
        `Divergence detected: ${e ? formatError(e) : 'unknown error'} – actions blocked.`,
      );
    } else if (s.sync.lastError) {
      banner.hidden = false;
      text(banner, `Sync error: ${formatError(s.sync.lastError)}`);
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
