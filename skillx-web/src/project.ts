import type { DealPayload, Hash, IsoUtc, LedgerEntry, Pubkey } from './types.js';
import {
  field,
  guardAmount,
  guardArray,
  guardHash,
  guardIso,
  guardLiteral,
  guardString,
  hasOwn,
  isRecord,
  GuardError,
} from './guards.js';

export interface DealView {
  deal_id: string;
  buyer: Pubkey;
  seller: Pubkey;
  amount: number;
  deadline: IsoUtc;
  criteria_hash: Hash;
  state: string;
  appealRound: number;
}

export type AmountKey =
  | 'erhalten_ausgegeben'
  | 'erhalten_treasury'
  | 'erhalten_escrow'
  | 'eingezahlt_escrow'
  | 'berufungsgebuehren';

export interface AccountTotals {
  amounts: Record<AmountKey, number | 'Überlauf'>;
  reputation: number | 'Überlauf';
}

export interface JuryCase {
  deal_id: string;
  appeal_round: number;
  voted: boolean;
}

export type KeyStatus = 'aktiv' | 'rotiert' | 'unbekannt';

const STATE_BY_TYPE: Partial<Record<LedgerEntry['event']['type'], string>> = {
  DealCreated: 'angelegt',
  DealConsented: 'zugestimmt',
  EscrowFunded: 'finanziert',
  DeliverableSubmitted: 'geliefert',
  DealAccepted: 'akzeptiert',
  DealAutoAccepted: 'akzeptiert',
  DealRejected: 'abgelehnt',
  DealExpired: 'abgelaufen',
  DisputeOpened: 'Streit',
  JuryAssigned: 'Jury gezogen',
  DisputeResolved: 'entschieden',
  AppealOpened: 'Berufung',
  EscrowReleased: 'ausgezahlt',
};

function readDealCreated(entry: LedgerEntry): DealPayload | null {
  if (entry.event.type !== 'DealCreated') {
    return null;
  }
  try {
    const p = entry.event.payload;
    if (!isRecord(p)) {
      return null;
    }
    return {
      deal_id: field(p, 'deal_id', '$.event.payload', guardString),
      buyer: field(p, 'buyer', '$.event.payload', guardString),
      seller: field(p, 'seller', '$.event.payload', guardString),
      amount: field(p, 'amount', '$.event.payload', guardAmount),
      criteria_hash: field(p, 'criteria_hash', '$.event.payload', guardHash),
      deadline: field(p, 'deadline', '$.event.payload', guardIso),
    };
  } catch {
    return null;
  }
}

function getDealId(event: LedgerEntry['event']): string | null {
  const p = event.payload;
  if (!isRecord(p)) {
    return null;
  }
  if (!hasOwn(p, 'deal_id')) {
    return null;
  }
  const v = p['deal_id'];
  return typeof v === 'string' ? v : null;
}

function numField(event: LedgerEntry['event'], key: string): number | null {
  const p = event.payload;
  if (!isRecord(p) || !hasOwn(p, key)) {
    return null;
  }
  const v = p[key];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

function strField(event: LedgerEntry['event'], key: string): string | null {
  const p = event.payload;
  if (!isRecord(p) || !hasOwn(p, key)) {
    return null;
  }
  const v = p[key];
  return typeof v === 'string' ? v : null;
}

function jurorsOf(event: LedgerEntry['event']): Pubkey[] | null {
  const p = event.payload;
  if (!isRecord(p) || !hasOwn(p, 'jurors')) {
    return null;
  }
  try {
    return guardArray(p['jurors'], '$.event.payload.jurors', guardString);
  } catch {
    return null;
  }
}

function addAmount(
  current: number | 'Überlauf',
  delta: number,
): number | 'Überlauf' {
  if (current === 'Überlauf') {
    return 'Überlauf';
  }
  const next = current + delta;
  return Number.isSafeInteger(next) ? next : 'Überlauf';
}

export function deriveDeals(entries: readonly LedgerEntry[]): Map<string, DealView> {
  const deals = new Map<string, DealView>();
  for (const entry of entries) {
    const event = entry.event;
    const created = readDealCreated(entry);
    if (created) {
      if (!deals.has(created.deal_id)) {
        deals.set(created.deal_id, {
          deal_id: created.deal_id,
          buyer: created.buyer,
          seller: created.seller,
          amount: created.amount,
          deadline: created.deadline,
          criteria_hash: created.criteria_hash,
          state: 'angelegt',
          appealRound: 0,
        });
      }
      continue;
    }
    const dealId = getDealId(event);
    if (dealId === null) {
      continue;
    }
    const deal = deals.get(dealId);
    if (!deal) {
      continue;
    }
    const st = STATE_BY_TYPE[event.type];
    if (st !== undefined) {
      deal.state = st;
    }
    const round = numField(event, 'appeal_round');
    if (round !== null && (event.type === 'JuryAssigned' || event.type === 'DisputeResolved')) {
      if (round > deal.appealRound) {
        deal.appealRound = round;
      }
    }
  }
  return deals;
}

export function deriveAccountTotals(
  entries: readonly LedgerEntry[],
  pubkey: Pubkey,
): AccountTotals {
  const amounts: Record<AmountKey, number | 'Überlauf'> = {
    erhalten_ausgegeben: 0,
    erhalten_treasury: 0,
    erhalten_escrow: 0,
    eingezahlt_escrow: 0,
    berufungsgebuehren: 0,
  };
  let reputation: number | 'Überlauf' = 0;
  for (const entry of entries) {
    const event = entry.event;
    switch (event.type) {
      case 'CurrencyIssued': {
        if (strField(event, 'recipient') === pubkey) {
          const a = numField(event, 'amount');
          if (a !== null) {
            amounts.erhalten_ausgegeben = addAmount(amounts.erhalten_ausgegeben, a);
          }
        }
        break;
      }
      case 'TreasurySpend': {
        if (strField(event, 'recipient') === pubkey) {
          const a = numField(event, 'amount');
          if (a !== null) {
            amounts.erhalten_treasury = addAmount(amounts.erhalten_treasury, a);
          }
        }
        break;
      }
      case 'EscrowReleased': {
        if (strField(event, 'to') === pubkey) {
          const a = numField(event, 'amount');
          if (a !== null) {
            amounts.erhalten_escrow = addAmount(amounts.erhalten_escrow, a);
          }
        }
        break;
      }
      case 'EscrowFunded': {
        if (strField(event, 'from') === pubkey) {
          const a = numField(event, 'amount');
          if (a !== null) {
            amounts.eingezahlt_escrow = addAmount(amounts.eingezahlt_escrow, a);
          }
        }
        break;
      }
      case 'AppealOpened': {
        if (strField(event, 'by') === pubkey) {
          const a = numField(event, 'fee_amount');
          if (a !== null) {
            amounts.berufungsgebuehren = addAmount(amounts.berufungsgebuehren, a);
          }
        }
        break;
      }
      case 'ReputationEvent': {
        if (strField(event, 'account') === pubkey) {
          const d = numField(event, 'delta');
          if (d !== null && (d === -1 || d === 0 || d === 1)) {
            reputation = addAmount(reputation, d);
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return { amounts, reputation };
}

interface CaseState {
  assigned: boolean;
  removed: boolean;
  replacedIn: boolean;
  resolved: boolean;
  voted: boolean;
}

export function deriveOpenJuryCases(
  entries: readonly LedgerEntry[],
  pubkey: Pubkey,
): JuryCase[] {
  const cases = new Map<string, CaseState>();
  const keyOf = (dealId: string, round: number): string => `${dealId}\u0000${round}`;
  const ensure = (dealId: string, round: number): CaseState => {
    const k = keyOf(dealId, round);
    let s = cases.get(k);
    if (!s) {
      s = {
        assigned: false,
        removed: false,
        replacedIn: false,
        resolved: false,
        voted: false,
      };
      cases.set(k, s);
    }
    return s;
  };

  for (const entry of entries) {
    const event = entry.event;
    const dealId = getDealId(event);
    if (dealId === null) {
      continue;
    }
    const round = numField(event, 'appeal_round') ?? 0;
    switch (event.type) {
      case 'JuryAssigned': {
        const jurors = jurorsOf(event);
        if (jurors && jurors.includes(pubkey)) {
          ensure(dealId, round).assigned = true;
        }
        break;
      }
      case 'JurorReplaced': {
        const missing = strField(event, 'missing_juror');
        const replacement = strField(event, 'replacement');
        if (missing === pubkey) {
          ensure(dealId, round).removed = true;
        }
        if (replacement === pubkey) {
          ensure(dealId, round).replacedIn = true;
        }
        break;
      }
      case 'DisputeResolved': {
        ensure(dealId, round).resolved = true;
        break;
      }
      case 'JuryVoted': {
        if (strField(event, 'juror') === pubkey) {
          ensure(dealId, round).voted = true;
        }
        break;
      }
      default:
        break;
    }
  }

  const open: JuryCase[] = [];
  for (const [k, s] of cases) {
    if ((s.assigned || s.replacedIn) && !s.removed && !s.resolved) {
      const parts = k.split('\u0000');
      open.push({
        deal_id: parts[0] ?? '',
        appeal_round: Number(parts[1]),
        voted: s.voted,
      });
    }
  }
  return open;
}

export function deriveKeyStatus(
  entries: readonly LedgerEntry[],
  pubkey: Pubkey,
): KeyStatus {
  let created = false;
  let rotatedOut = false;
  for (const entry of entries) {
    const event = entry.event;
    if (event.type === 'AccountCreated') {
      if (strField(event, 'pubkey') === pubkey) {
        created = true;
      }
    } else if (event.type === 'KeyRotated') {
      if (strField(event, 'old_pubkey') === pubkey) {
        rotatedOut = true;
      }
    }
  }
  if (rotatedOut) {
    return 'rotiert';
  }
  if (created) {
    return 'aktiv';
  }
  return 'unbekannt';
}

/** Extrahiert den Deal-consent-Body aus einer verifizierten DealCreated-Payload. */
export function consentBodyOfDeal(deal: DealPayload): Record<string, unknown> {
  return {
    deal_id: deal.deal_id,
    buyer: deal.buyer,
    seller: deal.seller,
    amount: deal.amount,
    criteria_hash: deal.criteria_hash,
    deadline: deal.deadline,
  };
}

export function findDealForConsent(
  entries: readonly LedgerEntry[],
  dealId: string,
): DealPayload | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    const created = readDealCreated(entry);
    if (created && created.deal_id === dealId) {
      return created;
    }
  }
  return null;
}

export function parseVote(value: string): 'buyer' | 'seller' | null {
  try {
    return guardLiteral(value, '$.vote', ['buyer', 'seller'] as const);
  } catch (e) {
    if (e instanceof GuardError) {
      return null;
    }
    throw e;
  }
}
