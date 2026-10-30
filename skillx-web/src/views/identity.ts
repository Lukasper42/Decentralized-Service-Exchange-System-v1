import { el, liveRegion, text, type Deps } from './common.js';
import {
  createVault,
  unlockSigner,
  exportFile,
  importFile,
  saveVault,
  loadVault,
  clearVault,
  MIN_PASSWORD_LENGTH,
  VAULT_STORAGE_KEY,
} from '../vault.js';
import { formatError, shortPubkey } from '../format.js';
import { browserClock, browserCrypto, browserRandom, browserStorage } from '../browser-ports.js';

export function render(root: HTMLElement, deps: Deps): () => void {
  root.replaceChildren();
  const h = el('h2');
  text(h, 'Identität');
  root.append(h);
  const msg = liveRegion();
  root.append(msg);

  const create = el('fieldset');
  const cl = el('legend');
  text(cl, 'Neuen Schlüssel erzeugen');
  create.append(cl);
  const p1l = el('label');
  p1l.htmlFor = 'pw1';
  text(p1l, `Passwort (min. ${MIN_PASSWORD_LENGTH} Zeichen)`);
  const p1 = el('input');
  p1.id = 'pw1';
  p1.type = 'password';
  p1.autocomplete = 'new-password';
  const p2l = el('label');
  p2l.htmlFor = 'pw2';
  text(p2l, 'Passwort wiederholen');
  const p2 = el('input');
  p2.id = 'pw2';
  p2.type = 'password';
  p2.autocomplete = 'new-password';
  const btnCreate = el('button');
  text(btnCreate, 'Schlüssel erzeugen');
  create.append(p1l, p1, p2l, p2, btnCreate);
  root.append(create);
  btnCreate.addEventListener('click', () => {
    if (p1.value !== p2.value) {
      text(msg, 'Passwörter stimmen nicht überein.');
      return;
    }
    void (async () => {
      try {
        const r = await createVault(browserCrypto, browserRandom, browserClock, p1.value);
        if (!r.ok) {
          text(msg, formatError(r.error));
          return;
        }
        saveVault(browserStorage, r.value.vault);
        deps.store.set({
          vault: r.value.vault,
          ownPubkey: r.value.publicKey,
          unlocked: false,
          signingKey: null,
        });
        p1.value = '';
        p2.value = '';
        text(msg, `Schlüssel erzeugt: ${shortPubkey(r.value.publicKey)}`);
      } catch {
        text(msg, 'Schlüsselerzeugung fehlgeschlagen.');
      }
    })();
  });

  const use = el('fieldset');
  const ul = el('legend');
  text(ul, 'Entsperren / Sperren');
  use.append(ul);
  const unl = el('label');
  unl.htmlFor = 'unlock-pw';
  text(unl, 'Passwort');
  const unp = el('input');
  unp.id = 'unlock-pw';
  unp.type = 'password';
  unp.autocomplete = 'current-password';
  const btnUnlock = el('button');
  text(btnUnlock, 'Entsperren');
  const btnLock = el('button');
  text(btnLock, 'Sperren');
  const btnForget = el('button');
  text(btnForget, 'Vault löschen');
  use.append(unl, unp, btnUnlock, btnLock, btnForget);
  root.append(use);
  btnUnlock.addEventListener('click', () => {
    const loaded =
      deps.store.get().vault ??
      (() => {
        const r = loadVault(browserStorage);
        return r.ok ? r.value : null;
      })();
    if (!loaded) {
      text(msg, 'Kein Vault gefunden.');
      return;
    }
    void (async () => {
      const r = await unlockSigner(browserCrypto, loaded, unp.value);
      if (!r.ok) {
        text(msg, formatError(r.error));
        return;
      }
      const unlockedVault = { publicKey: r.value.publicKey, file: loaded.file };
      saveVault(browserStorage, unlockedVault);
      deps.store.set({
        vault: unlockedVault,
        ownPubkey: r.value.publicKey,
        unlocked: true,
        signingKey: r.value.key,
      });
      unp.value = '';
      text(msg, 'Schlüssel entsperrt (Autosperre nach 10 Minuten Inaktivität).');
      deps.resetIdleTimer();
    })();
  });
  btnLock.addEventListener('click', () => {
    deps.store.set({ unlocked: false, signingKey: null });
    text(msg, 'Schlüssel gesperrt.');
  });
  btnForget.addEventListener('click', () => {
    clearVault(browserStorage);
    deps.store.set({ vault: null, ownPubkey: null, unlocked: false, signingKey: null });
    text(msg, 'Vault gelöscht.');
  });

  const io = el('fieldset');
  const iol = el('legend');
  text(iol, 'Vault-Datei');
  io.append(iol);
  const btnExport = el('button');
  text(btnExport, 'Exportieren');
  const btnImport = el('button');
  text(btnImport, 'Importieren');
  io.append(btnExport, btnImport);
  root.append(io);
  btnExport.addEventListener('click', () => {
    const v = deps.store.get().vault;
    if (!v) {
      text(msg, 'Kein Vault zum Exportieren.');
      return;
    }
    deps.saveFile('skillx-vault.json', exportFile(v));
  });
  btnImport.addEventListener('click', () => {
    void (async () => {
      const fileText = await deps.pickFile();
      if (fileText === null) {
        return;
      }
      const r = importFile(fileText);
      if (!r.ok) {
        text(msg, formatError(r.error));
        return;
      }
      const pub = deps.store.get().ownPubkey ?? '';
      deps.store.set({
        vault: { publicKey: pub, file: r.value },
        unlocked: false,
        signingKey: null,
      });
      saveVault(browserStorage, { publicKey: pub, file: r.value });
      text(msg, 'Vault importiert. Bitte entsperren.');
    })();
  });

  const pkWrap = el('p');
  const pkSpan = el('code');
  const btnCopy = el('button');
  text(btnCopy, 'Pubkey kopieren');
  pkWrap.append(document.createTextNode('Pubkey: '), pkSpan, ' ', btnCopy);
  root.append(pkWrap);
  btnCopy.addEventListener('click', () => {
    const pk = deps.store.get().ownPubkey;
    if (pk) {
      void navigator.clipboard.writeText(pk);
    }
  });

  const statusP = el('p');
  root.append(statusP);

  const unsubscribe = deps.store.subscribeNow((s) => {
    text(pkSpan, s.ownPubkey ?? 'kein');
    btnCopy.disabled = s.ownPubkey === null;
    btnExport.disabled = s.vault === null;
    const entries = s.verifier ? s.verifier.getEntries() : [];
    let ks = 'unbekannt';
    if (s.ownPubkey && s.verifier) {
      ks = deps.keyStatusOf(s.ownPubkey, entries);
    }
    text(
      statusP,
      `Schlüsselstatus: ${ks}; entsperrt: ${s.unlocked ? 'ja' : 'nein'} (Speicherplatz: ${VAULT_STORAGE_KEY})`,
    );
  });

  return () => {
    unsubscribe();
    root.replaceChildren();
  };
}
