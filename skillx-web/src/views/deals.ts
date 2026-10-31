import { el, liveRegion, text, blockedReasons, type Deps } from './common.js';
import { deriveDeals } from '../project.js';
import { formatAmount, formatError, formatIso } from '../format.js';
import { consentDeal } from '../actions.js';

export function render(root: HTMLElement, deps: Deps): () => void {
  root.replaceChildren();
  const h = el('h2');
  text(h, 'Meine Deals');
  root.append(h);
  const note = el('p', 'derived-note');
  text(note, 'Abgeleitet, nicht autoritativ.');
  root.append(note);
  const msg = liveRegion();
  root.append(msg);
  const hint = el('p');
  root.append(hint);
  const table = el('table');
  root.append(table);

  const unsubscribe = deps.store.subscribeNow((s) => {
    table.replaceChildren();
    const own = s.ownPubkey;
    const entries = s.verifier ? s.verifier.getEntries() : [];
    const reasons = blockedReasons({
      unlocked: s.unlocked,
      verifierBroken: s.verifier !== null && s.verifier.isBroken,
      readOnly: s.health !== null && s.health.readOnly,
      transportError: !s.sync.lastSyncOk,
    });
    const blocked = reasons.length > 0;
    const syncDetail = s.sync.lastError ? ` (${formatError(s.sync.lastError)})` : '';
    text(
      hint,
      s.actionError
        ? `Letzte Aktion fehlgeschlagen: ${formatError(s.actionError)}`
        : blocked
          ? `Aktionen gesperrt: ${reasons.join('; ')}${syncDetail}.`
          : '',
    );
    const thead = el('thead');
    const hrow = el('tr');
    for (const label of ['Deal-ID', 'Rolle', 'Betrag', 'Deadline', 'Zustand', 'Aktion']) {
      const th = el('th');
      th.scope = 'col';
      text(th, label);
      hrow.append(th);
    }
    thead.append(hrow);
    table.append(thead);
    const tbody = el('tbody');
    let count = 0;
    for (const deal of deriveDeals(entries).values()) {
      if (!own || (deal.buyer !== own && deal.seller !== own)) {
        continue;
      }
      count++;
      const tr = el('tr');
      const values = [
        deal.deal_id,
        deal.buyer === own ? 'Käufer' : 'Verkäufer',
        formatAmount(deal.amount),
        formatIso(deal.deadline),
        deal.state,
      ];
      for (const v of values) {
        const td = el('td');
        text(td, v);
        tr.append(td);
      }
      const tdAct = el('td');
      if (own && deal.seller === own && deal.state === 'angelegt') {
        const btn = el('button');
        text(btn, 'Zustimmen');
        btn.disabled = blocked;
        btn.addEventListener('click', () => {
          const ctx = deps.makeActionContext();
          if (!ctx) {
            text(msg, 'Aktion gesperrt.');
            return;
          }
          void deps.runAction(consentDeal(ctx, deal.deal_id));
        });
        tdAct.append(btn);
      } else {
        text(tdAct, '–');
      }
      tr.append(tdAct);
      tbody.append(tr);
    }
    if (count === 0) {
      const tr = el('tr');
      const td = el('td');
      td.colSpan = 6;
      text(td, own ? 'Keine Deals für diesen Schlüssel.' : 'Zuerst Schlüssel entsperren.');
      tr.append(td);
      tbody.append(tr);
    }
    table.append(tbody);
    if (s.actionMessage) {
      text(msg, s.actionMessage);
    }
  });

  return () => {
    unsubscribe();
    root.replaceChildren();
  };
}
