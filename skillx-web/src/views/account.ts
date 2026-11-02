import { el, liveRegion, text, blockedReasons, type Deps } from './common.js';
import { deriveAccountTotals, deriveKeyStatus, type AmountKey } from '../project.js';
import { formatAmount, formatError } from '../format.js';
import { createAccount } from '../actions.js';

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

  const reg = el('section');
  reg.hidden = true;
  const regTitle = el('h3');
  text(regTitle, 'Register this key on the ledger');
  const regInfo = el('p');
  text(
    regInfo,
    'This key is not an account on the ledger yet. Registering is possible only if the operator listed your public key in the genesis. In this version the recovery key is the same as this key: there is no separate recovery.',
  );
  const regBtn = el('button');
  regBtn.id = 'register-key';
  text(regBtn, 'Register this key');
  const regMsg = liveRegion();
  reg.append(regTitle, regInfo, regBtn, regMsg);
  root.append(reg);
  regBtn.addEventListener('click', () => {
    const ctx = deps.makeActionContext();
    if (!ctx) {
      text(regMsg, 'Action blocked.');
      return;
    }
    void deps.runAction(createAccount(ctx));
  });

  const unsubscribe = deps.store.subscribeNow((s) => {
    table.replaceChildren();
    const entriesNow = s.verifier ? s.verifier.getEntries() : [];
    const needsRegistration =
      s.ownPubkey !== null && s.verifier !== null && deriveKeyStatus(entriesNow, s.ownPubkey) === 'unknown';
    reg.hidden = !needsRegistration;
    const reasons = blockedReasons({
      unlocked: s.unlocked,
      verifierBroken: s.verifier !== null && s.verifier.isBroken,
      readOnly: s.health !== null && s.health.readOnly,
      transportError: !s.sync.lastSyncOk,
    });
    regBtn.disabled = reasons.length > 0;
    text(
      regMsg,
      s.actionError
        ? `Last action failed: ${formatError(s.actionError)}`
        : reasons.length > 0
          ? `Actions blocked: ${reasons.join('; ')}.`
          : (s.actionMessage ?? ''),
    );
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
