import { el, text, type Deps } from './common.js';
import { canonical, eventHash, receiptHash, verifyEvent, verifyReceipt } from '../crypto.js';
import { EVENT_TYPES, type LedgerEntry } from '../types.js';
import { shortHash, shortPubkey } from '../format.js';
import { browserCrypto } from '../browser-ports.js';

const PAGE_SIZE = 50;

export function render(root: HTMLElement, deps: Deps): () => void {
  root.replaceChildren();
  const h = el('h2');
  text(h, 'Explorer');
  root.append(h);
  const note = el('p', 'derived-note');
  text(note, 'Locally verified entries; newest first, 50 per page.');
  root.append(note);

  const controls = el('div');
  const typeLabel = el('label');
  typeLabel.htmlFor = 'f-type';
  text(typeLabel, 'Event type');
  const typeSel = el('select');
  typeSel.id = 'f-type';
  const optAll = el('option');
  optAll.value = '';
  text(optAll, 'all');
  typeSel.append(optAll);
  for (const t of EVENT_TYPES) {
    const o = el('option');
    o.value = t;
    text(o, t);
    typeSel.append(o);
  }
  const pkLabel = el('label');
  pkLabel.htmlFor = 'f-pk';
  text(pkLabel, 'Signer pubkey (exact)');
  const pkInput = el('input');
  pkInput.id = 'f-pk';
  pkInput.type = 'text';
  pkInput.autocomplete = 'off';
  controls.append(typeLabel, typeSel, pkLabel, pkInput);
  root.append(controls);

  const listEl = el('ul');
  root.append(listEl);
  const pager = el('div');
  const btnPrev = el('button');
  text(btnPrev, 'Older');
  const pageInfo = el('span');
  const btnNext = el('button');
  text(btnNext, 'Newer');
  pager.append(btnPrev, pageInfo, btnNext);
  root.append(pager);

  const detail = el('div');
  root.append(detail);

  let page = 0;

  function filtered(): LedgerEntry[] {
    const entries = deps.store.get().verifier
      ? [...deps.store.get().verifier!.getEntries()]
      : [];
    const rev = entries.reverse();
    const tp = typeSel.value;
    const pk = pkInput.value.trim();
    return rev.filter((e) => {
      if (tp !== '' && e.event.type !== tp) {
        return false;
      }
      if (pk !== '' && e.event.signer !== pk) {
        return false;
      }
      return true;
    });
  }

  async function showDetail(entry: LedgerEntry): Promise<void> {
    detail.replaceChildren();
    const h3a = el('h3');
    text(h3a, 'Event (canonical)');
    const pre = el('pre');
    text(pre, canonical(entry.event));
    const h3b = el('h3');
    text(h3b, 'Receipt (canonical)');
    const pre2 = el('pre');
    text(pre2, canonical(entry.receipt));
    detail.append(h3a, pre, h3b, pre2);
    const results = el('ul');
    const sigOk = await verifyEvent(browserCrypto, entry.event);
    const eh = await eventHash(browserCrypto, entry.event);
    const rh = await receiptHash(browserCrypto, entry.receipt);
    const relayPk = deps.store.get().relayPubkey ?? '';
    const recOk = relayPk === '' ? false : await verifyReceipt(browserCrypto, entry.receipt, relayPk);
    const li1 = el('li');
    text(li1, `Event signature: ${sigOk ? 'yes' : 'no'}`);
    const li2 = el('li');
    text(
      li2,
      `Hash link (eventHash): ${eh === entry.receipt.eventHash ? 'yes' : 'no'} (${shortHash(eh)})`,
    );
    const li3 = el('li');
    text(li3, `Receipt verified: ${recOk ? 'yes' : 'no'} (receiptHash ${shortHash(rh)})`);
    results.append(li1, li2, li3);
    detail.append(results);
  }

  function refresh(): void {
    const all = filtered();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (page >= pages) {
      page = pages - 1;
    }
    const slice = all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    listEl.replaceChildren();
    for (const entry of slice) {
      const li = el('li');
      const btn = el('button');
      text(btn, `#${entry.receipt.sequence} ${entry.event.type} ${shortPubkey(entry.event.signer)}`);
      btn.addEventListener('click', () => {
        void showDetail(entry);
      });
      li.append(btn);
      listEl.append(li);
    }
    text(pageInfo, ` Page ${page + 1} of ${pages} (${all.length} entries)`);
    btnPrev.disabled = page >= pages - 1;
    btnNext.disabled = page <= 0;
  }

  typeSel.addEventListener('change', () => {
    page = 0;
    refresh();
  });
  pkInput.addEventListener('input', () => {
    page = 0;
    refresh();
  });
  btnNext.addEventListener('click', () => {
    page = Math.max(0, page - 1);
    refresh();
  });
  btnPrev.addEventListener('click', () => {
    page = page + 1;
    refresh();
  });

  const unsubscribe = deps.store.subscribe(() => {
    refresh();
  });
  refresh();

  return () => {
    unsubscribe();
    root.replaceChildren();
  };
}
