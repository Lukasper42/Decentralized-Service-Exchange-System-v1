import { el, liveRegion, text, actionsBlocked, type Deps } from './common.js';
import { deriveOpenJuryCases } from '../project.js';
import { formatError } from '../format.js';
import { castVote } from '../actions.js';

export function render(root: HTMLElement, deps: Deps): () => void {
  root.replaceChildren();
  const h = el('h2');
  text(h, 'Jury');
  root.append(h);
  const note = el('p', 'derived-note');
  text(note, 'Derived, not authoritative.');
  root.append(note);
  const msg = liveRegion();
  root.append(msg);
  const list = el('div');
  root.append(list);

  const unsubscribe = deps.store.subscribeNow((s) => {
    list.replaceChildren();
    if (!s.ownPubkey || !s.verifier) {
      const p = el('p');
      text(p, 'No unlocked key.');
      list.append(p);
      return;
    }
    const blocked = actionsBlocked({
      unlocked: s.unlocked,
      verifierBroken: s.verifier.isBroken,
      readOnly: s.health !== null && s.health.readOnly,
      transportError: !s.sync.lastSyncOk,
    });
    const cases = deriveOpenJuryCases(s.verifier.getEntries(), s.ownPubkey);
    if (cases.length === 0) {
      const p = el('p');
      text(p, 'No open jury cases.');
      list.append(p);
      return;
    }
    for (const c of cases) {
      const item = el('fieldset');
      const lg = el('legend');
      text(
        lg,
        `Deal ${c.deal_id} – appeal round ${c.appeal_round}${c.voted ? ' (already voted)' : ''}`,
      );
      item.append(lg);
      if (c.voted) {
        const span = el('span');
        text(span, 'Your vote has been recorded.');
        item.append(span);
      } else {
        for (const vote of ['buyer', 'seller'] as const) {
          const btn = el('button');
          text(btn, vote === 'buyer' ? 'Buyer' : 'Seller');
          btn.disabled = blocked;
          btn.addEventListener('click', () => {
            const ctx = deps.makeActionContext();
            if (!ctx) {
              text(msg, 'Action blocked.');
              return;
            }
            void deps.runAction(castVote(ctx, c.deal_id, vote));
          });
          item.append(btn);
        }
      }
      list.append(item);
    }
    if (s.actionError) {
      text(msg, `Error: ${formatError(s.actionError)}`);
    } else if (s.actionMessage) {
      text(msg, s.actionMessage);
    }
  });

  return () => {
    unsubscribe();
    root.replaceChildren();
  };
}
