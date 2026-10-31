import { el, text, type Deps } from './common.js';
import { deriveAccountTotals, type AmountKey } from '../project.js';
import { formatAmount } from '../format.js';

const LABELS: Record<AmountKey, string> = {
  erhalten_ausgegeben: 'Erhalten (Währungsausgabe)',
  erhalten_treasury: 'Erhalten (Treasury)',
  erhalten_escrow: 'Erhalten (Escrow-Auszahlung)',
  eingezahlt_escrow: 'Eingezahlt (Escrow)',
  berufungsgebuehren: 'Berufungsgebühren',
};

export function render(root: HTMLElement, deps: Deps): () => void {
  root.replaceChildren();
  const h = el('h2');
  text(h, 'Konto');
  root.append(h);
  const note = el('p', 'derived-note');
  text(note, 'Abgeleitete Summen aus der verifizierten Kette – keine autoritativen Salden.');
  root.append(note);
  const table = el('table');
  root.append(table);

  const unsubscribe = deps.store.subscribeNow((s) => {
    table.replaceChildren();
    if (!s.ownPubkey || !s.verifier) {
      const p = el('p');
      text(p, 'Kein Schlüssel entsperrt.');
      table.append(p);
      return;
    }
    const totals = deriveAccountTotals(s.verifier.getEntries(), s.ownPubkey);
    const tbody = el('tbody');
    for (const key of Object.keys(LABELS) as AmountKey[]) {
      const tr = el('tr');
      const th = el('th');
      th.scope = 'row';
      text(th, LABELS[key]);
      const td = el('td');
      text(td, formatAmount(totals.amounts[key]));
      tr.append(th, td);
      tbody.append(tr);
    }
    const trRep = el('tr');
    const thRep = el('th');
    thRep.scope = 'row';
    text(thRep, 'Reputationssumme (ohne Zerfall)');
    const tdRep = el('td');
    text(tdRep, totals.reputation === 'Überlauf' ? 'Überlauf' : String(totals.reputation));
    trRep.append(thRep, tdRep);
    tbody.append(trRep);
    table.append(tbody);
  });

  return () => {
    unsubscribe();
    root.replaceChildren();
  };
}
