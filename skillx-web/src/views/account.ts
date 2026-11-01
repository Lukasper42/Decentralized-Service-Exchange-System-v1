import { el, text, type Deps } from './common.js';
import { deriveAccountTotals, type AmountKey } from '../project.js';
import { formatAmount } from '../format.js';

const LABELS: Record<AmountKey, string> = {
  received_issued: 'Received (currency issuance)',
  received_treasury: 'Received (treasury)',
  received_escrow: 'Received (escrow payout)',
  deposited_escrow: 'Deposited (escrow)',
  appeal_fees: 'Appeal fees',
};

export function render(root: HTMLElement, deps: Deps): () => void {
  root.replaceChildren();
  const h = el('h2');
  text(h, 'Account');
  root.append(h);
  const note = el('p', 'derived-note');
  text(note, 'Totals derived from the verified chain – not authoritative balances.');
  root.append(note);
  const table = el('table');
  root.append(table);

  const unsubscribe = deps.store.subscribeNow((s) => {
    table.replaceChildren();
    if (!s.ownPubkey || !s.verifier) {
      const p = el('p');
      text(p, 'No key unlocked.');
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
    text(thRep, 'Reputation total (without decay)');
    const tdRep = el('td');
    text(tdRep, totals.reputation === 'overflow' ? 'overflow' : String(totals.reputation));
    trRep.append(thRep, tdRep);
    tbody.append(trRep);
    table.append(tbody);
  });

  return () => {
    unsubscribe();
    root.replaceChildren();
  };
}
