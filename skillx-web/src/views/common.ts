import type { ApiError, LedgerEntry } from '../types.js';
import type { Store } from '../state.js';
import type { ActionContext, ActionResult } from '../actions.js';
import type { KeyStatus } from '../project.js';

export interface Deps {
  store: Store;
  makeActionContext: () => ActionContext | null;
  runAction: (result: Promise<ActionResult>) => Promise<void>;
  notify: (message: string | null, error: ApiError | null) => void;
  applyRelayConfig: () => Promise<void>;
  resetIdleTimer: () => void;
  saveFile: (name: string, text: string) => void;
  pickFile: () => Promise<string | null>;
  keyStatusOf: (pubkey: string, entries: readonly LedgerEntry[]) => KeyStatus;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  return e;
}

export function text(n: Node, s: string): void {
  n.textContent = s;
}

export function liveRegion(cls = 'action-status'): HTMLParagraphElement {
  const p = el('p', cls);
  p.setAttribute('role', 'status');
  p.setAttribute('aria-live', 'polite');
  return p;
}

export interface BlockState {
  unlocked: boolean;
  verifierBroken: boolean;
  readOnly: boolean;
  transportError: boolean;
}

/** Nennt die tatsächlichen Gründe, warum Aktionen gesperrt sind (leer = nicht gesperrt). */
export function blockedReasons(state: BlockState): string[] {
  const reasons: string[] = [];
  if (!state.unlocked) {
    reasons.push('Schlüssel gesperrt');
  }
  if (state.verifierBroken) {
    reasons.push('Divergenz in der Kette');
  }
  if (state.readOnly) {
    reasons.push('Relay ist nur lesbar');
  }
  if (state.transportError) {
    reasons.push('letzte Synchronisation fehlgeschlagen');
  }
  return reasons;
}

export function actionsBlocked(state: BlockState): boolean {
  return blockedReasons(state).length > 0;
}
