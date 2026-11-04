import { el, liveRegion, text, blockedReasons, type Deps } from './common.js';
import { deriveDeals, deriveKeyStatus } from '../project.js';
import { formatAmount, formatError, formatIso } from '../format.js';
import {
  acceptDeal,
  consentDeal,
  createDeal,
  fundEscrow,
  openDispute,
  rejectDeal,
  submitDeliverable,
} from '../actions.js';
import { sha256HexUtf8 } from '../crypto.js';
import type { ActionContext } from '../actions.js';

export function render(root: HTMLElement, deps: Deps): () => void {
  root.replaceChildren();
  const h = el('h2');
  text(h, 'My deals');
  root.append(h);
  const note = el('p', 'derived-note');
  text(note, 'Derived, not authoritative.');
  root.append(note);
  const msg = liveRegion();
  root.append(msg);
  const hint = el('p');
  root.append(hint);
  const table = el('table');
  root.append(table);

  // Built once (not inside the subscription) so that typed text survives the 15 s poll.
  const form = el('section');
  form.hidden = true;
  const formTitle = el('h3');
  text(formTitle, 'New deal (you are the buyer)');
  form.append(formTitle);
  const field = (id: string, label: string, input: HTMLInputElement | HTMLTextAreaElement): void => {
    const l = el('label');
    l.htmlFor = id;
    text(l, label);
    input.id = id;
    form.append(l, input);
  };
  const seller = el('input');
  seller.autocomplete = 'off';
  field('deal-seller', 'Seller public key', seller);
  const amount = el('input');
  amount.inputMode = 'numeric';
  amount.autocomplete = 'off';
  field('deal-amount', 'Amount (whole number, at least 2)', amount);
  const days = el('input');
  days.inputMode = 'numeric';
  days.autocomplete = 'off';
  days.value = '7';
  field('deal-days', 'Deadline in days from now (1 to 365)', days);
  const criteria = el('textarea');
  criteria.rows = 4;
  field('deal-criteria', 'Acceptance criteria (up to 2000 characters)', criteria);
  const formNote = el('p');
  text(
    formNote,
    'Only a salted hash of the criteria goes on the ledger. The text and the salt stay in this browser; clearing site data loses them.',
  );
  const create = el('button');
  create.id = 'deal-create';
  text(create, 'Create deal');
  form.append(formNote, create);
  root.append(form);
  create.addEventListener('click', () => {
    const ctx = deps.makeActionContext();
    if (!ctx) {
      text(msg, 'Action blocked.');
      return;
    }
    const result = createDeal(
      ctx,
      { random: deps.random, storage: deps.storage },
      {
        seller: seller.value,
        amountText: amount.value,
        deadlineDaysText: days.value,
        criteriaText: criteria.value,
      },
    );
    void result.then((r) => {
      if (r.ok) {
        seller.value = '';
        amount.value = '';
        criteria.value = '';
      }
    });
    void deps.runAction(result);
  });

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
    form.hidden = !(own !== null && deriveKeyStatus(entries, own) === 'active');
    create.disabled = blocked;
    const syncDetail = s.sync.lastError ? ` (${formatError(s.sync.lastError)})` : '';
    text(
      hint,
      s.actionError
        ? `Last action failed: ${formatError(s.actionError)}`
        : blocked
          ? `Actions blocked: ${reasons.join('; ')}${syncDetail}.`
          : '',
    );
    const thead = el('thead');
    const hrow = el('tr');
    for (const label of ['Deal ID', 'Role', 'Amount', 'Deadline', 'State', 'Action']) {
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
        deal.buyer === own ? 'Buyer' : 'Seller',
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
      const simpleAction = (label: string, build: (ctx: ActionContext) => Promise<unknown>): void => {
        const btn = el('button');
        text(btn, label);
        btn.disabled = blocked;
        btn.addEventListener('click', () => {
          const ctx = deps.makeActionContext();
          if (!ctx) {
            text(msg, 'Action blocked.');
            return;
          }
          void build(ctx);
        });
        tdAct.append(btn);
      };
      if (own && deal.seller === own && deal.state === 'created') {
        simpleAction('Consent', (ctx) => deps.runAction(consentDeal(ctx, deal.deal_id)));
      } else if (own && deal.buyer === own && deal.state === 'consented') {
        simpleAction('Fund escrow', (ctx) => deps.runAction(fundEscrow(ctx, deal.deal_id)));
      } else if (own && deal.seller === own && deal.state === 'funded') {
        const content = el('textarea');
        content.rows = 3;
        content.placeholder = 'Deliverable text (send the same text to the buyer via Messages)';
        const btn = el('button');
        text(btn, 'Submit deliverable');
        btn.disabled = blocked;
        btn.addEventListener('click', () => {
          const ctx = deps.makeActionContext();
          if (!ctx) {
            text(msg, 'Action blocked.');
            return;
          }
          if (content.value.trim() === '') {
            text(msg, 'Enter the deliverable text first.');
            return;
          }
          void (async () => {
            const content_hash = await sha256HexUtf8(deps.crypto, content.value);
            await deps.runAction(submitDeliverable(ctx, deal.deal_id, content_hash));
          })();
        });
        tdAct.append(content, btn);
      } else if (own && deal.buyer === own && deal.state === 'delivered') {
        const acceptBtn = el('button');
        text(acceptBtn, 'Accept');
        acceptBtn.disabled = blocked;
        acceptBtn.addEventListener('click', () => {
          const ctx = deps.makeActionContext();
          if (!ctx) {
            text(msg, 'Action blocked.');
            return;
          }
          void deps.runAction(acceptDeal(ctx, deal.deal_id));
        });
        const reason = el('input');
        reason.placeholder = 'Rejection reason';
        const rejectBtn = el('button');
        text(rejectBtn, 'Reject');
        rejectBtn.disabled = blocked;
        rejectBtn.addEventListener('click', () => {
          const ctx = deps.makeActionContext();
          if (!ctx) {
            text(msg, 'Action blocked.');
            return;
          }
          if (reason.value.trim() === '') {
            text(msg, 'Enter a rejection reason first.');
            return;
          }
          void deps.runAction(
            rejectDeal(ctx, { random: deps.random, storage: deps.storage }, deal.deal_id, reason.value),
          );
        });
        tdAct.append(acceptBtn, reason, rejectBtn);
      } else if (own && (deal.buyer === own || deal.seller === own) && deal.state === 'rejected') {
        simpleAction('Open dispute', (ctx) => deps.runAction(openDispute(ctx, deal.deal_id)));
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
      text(td, own ? 'No deals for this key.' : 'Unlock a key first.');
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
