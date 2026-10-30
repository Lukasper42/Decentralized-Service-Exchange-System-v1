import { ok, err } from './protocol.js';
import type { Result, Pubkey, PayloadMap } from './protocol.js';
import type { JuryCandidate } from './jury.js';

export interface ReputationParams {
  readonly activeWindowMs: number;
  readonly decayHalfLifeMs: number;
}

export interface AccountReputation {
  readonly createdAtMs: number;
  readonly completedDeals: number;
  readonly counterparties: readonly Pubkey[];
  readonly rawSum: number;
  readonly lastActiveAtMs: number | null;
}

export interface ReputationState {
  readonly accounts: Readonly<Record<Pubkey, AccountReputation>>;
  readonly rated: readonly string[];
  readonly settled: readonly string[];
}

interface MutableReputationState {
  accounts: Record<Pubkey, AccountReputation>;
  rated: string[];
  settled: string[];
}

function addSigned(a: number, b: number): Result<number> {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    return err('AMOUNT', 'operands must be safe integers', 'operand');
  }

  const sum = a + b;

  return Number.isSafeInteger(sum)
    ? ok(sum)
    : err('AMOUNT', 'addition overflows the safe integer range', 'result');
}

function createNullRecord<T>(): Record<Pubkey, T> {
  return Object.create(null) as Record<Pubkey, T>;
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function isNonNegativeSafeInteger(value: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function insertSortedDistinct(list: readonly string[], value: string): string[] {
  const copy = list.slice();

  for (let index = 0; index < copy.length; index += 1) {
    const existing = copy[index];

    if (existing === undefined) {
      continue;
    }

    const comparison = compareUtf8(existing, value);

    if (comparison === 0) {
      return copy;
    }

    if (comparison > 0) {
      copy.splice(index, 0, value);
      return copy;
    }
  }

  copy.push(value);
  return copy;
}

function cloneState(state: ReputationState): MutableReputationState {
  const accounts = createNullRecord<AccountReputation>();

  for (const key of Object.keys(state.accounts)) {
    const account = state.accounts[key];

    if (account !== undefined) {
      accounts[key] = {
        createdAtMs: account.createdAtMs,
        completedDeals: account.completedDeals,
        counterparties: account.counterparties.slice(),
        rawSum: account.rawSum,
        lastActiveAtMs: account.lastActiveAtMs,
      };
    }
  }

  return {
    accounts,
    rated: state.rated.slice(),
    settled: state.settled.slice(),
  };
}

function isStrictlyAscending(values: readonly string[]): boolean {
  let previous: string | null = null;

  for (const value of values) {
    if (previous !== null) {
      if (compareUtf8(previous, value) >= 0) {
        return false;
      }
    }

    previous = value;
  }

  return true;
}

function updateCompletedAccount(
  account: AccountReputation,
  counterparty: Pubkey,
  acceptedAtMs: number,
  pubkey: Pubkey,
): Result<AccountReputation> {
  const completedDeals = addSigned(account.completedDeals, 1);

  if (!completedDeals.ok) {
    return err(
      'STATE',
      'completedDeals overflow',
      `state.accounts.${pubkey}.completedDeals`,
    );
  }

  const hasCounterparty = account.counterparties.includes(counterparty);
  const counterparties = hasCounterparty
    ? account.counterparties.slice()
    : insertSortedDistinct(account.counterparties, counterparty);
  const lastActiveAtMs = hasCounterparty ? account.lastActiveAtMs : acceptedAtMs;

  return ok({
    createdAtMs: account.createdAtMs,
    completedDeals: completedDeals.value,
    counterparties,
    rawSum: account.rawSum,
    lastActiveAtMs,
  });
}

export function initialReputationState(): ReputationState {
  return {
    accounts: createNullRecord<AccountReputation>(),
    rated: [],
    settled: [],
  };
}

export function registerAccount(
  state: ReputationState,
  pubkey: Pubkey,
  createdAtMs: number,
): Result<ReputationState> {
  if (typeof pubkey !== 'string' || pubkey.length === 0) {
    return err('FIELD_FORMAT', 'pubkey must be a non-empty string', 'pubkey');
  }

  if (!isNonNegativeSafeInteger(createdAtMs)) {
    return err(
      'FIELD_FORMAT',
      'createdAtMs must be a non-negative safe integer',
      'createdAtMs',
    );
  }

  if (Object.hasOwn(state.accounts, pubkey)) {
    return err('DUPLICATE', 'account already registered', 'pubkey');
  }

  const clone = cloneState(state);

  clone.accounts[pubkey] = {
    createdAtMs,
    completedDeals: 0,
    counterparties: [],
    rawSum: 0,
    lastActiveAtMs: null,
  };

  return ok(clone);
}

export function applyDealCompleted(
  state: ReputationState,
  dealId: string,
  buyer: Pubkey,
  seller: Pubkey,
  acceptedAtMs: number,
): Result<ReputationState> {
  if (buyer === seller) {
    return err('FIELD_FORMAT', 'buyer and seller must differ', 'buyer');
  }

  if (!isNonNegativeSafeInteger(acceptedAtMs)) {
    return err(
      'FIELD_FORMAT',
      'acceptedAtMs must be a non-negative safe integer',
      'acceptedAtMs',
    );
  }

  if (state.settled.includes(dealId)) {
    return err('DUPLICATE', 'deal already settled', 'dealId');
  }

  if (!Object.hasOwn(state.accounts, buyer)) {
    return err('STATE', 'buyer is not registered', `state.accounts.${buyer}`);
  }

  if (!Object.hasOwn(state.accounts, seller)) {
    return err('STATE', 'seller is not registered', `state.accounts.${seller}`);
  }

  const buyerAccount = state.accounts[buyer];
  const sellerAccount = state.accounts[seller];

  if (buyerAccount === undefined || sellerAccount === undefined) {
    return err('STATE', 'deal party is not registered', 'state.accounts');
  }

  const nextBuyer = updateCompletedAccount(
    buyerAccount,
    seller,
    acceptedAtMs,
    buyer,
  );

  if (!nextBuyer.ok) {
    return err(nextBuyer.error.code, nextBuyer.error.message, nextBuyer.error.path);
  }

  const nextSeller = updateCompletedAccount(
    sellerAccount,
    buyer,
    acceptedAtMs,
    seller,
  );

  if (!nextSeller.ok) {
    return err(nextSeller.error.code, nextSeller.error.message, nextSeller.error.path);
  }

  const clone = cloneState(state);

  clone.accounts[buyer] = nextBuyer.value;
  clone.accounts[seller] = nextSeller.value;
  clone.settled = insertSortedDistinct(clone.settled, dealId);

  return ok(clone);
}

export function applyDisputeOutcome(
  state: ReputationState,
  dealId: string,
  winner: Pubkey,
  loser: Pubkey,
): Result<ReputationState> {
  if (winner === loser) {
    return err('FIELD_FORMAT', 'winner and loser must differ', 'winner');
  }

  const settledKey = `${dealId}:outcome`;

  if (state.settled.includes(settledKey)) {
    return err('DUPLICATE', 'dispute outcome already settled', 'dealId');
  }

  if (!Object.hasOwn(state.accounts, winner)) {
    return err('STATE', 'winner is not registered', `state.accounts.${winner}`);
  }

  if (!Object.hasOwn(state.accounts, loser)) {
    return err('STATE', 'loser is not registered', `state.accounts.${loser}`);
  }

  const winnerAccount = state.accounts[winner];
  const loserAccount = state.accounts[loser];

  if (winnerAccount === undefined || loserAccount === undefined) {
    return err('STATE', 'dispute party is not registered', 'state.accounts');
  }

  const winnerSum = addSigned(winnerAccount.rawSum, 1);

  if (!winnerSum.ok) {
    return err(
      'STATE',
      'rawSum overflow',
      `state.accounts.${winner}.rawSum`,
    );
  }

  const loserSum = addSigned(loserAccount.rawSum, -1);

  if (!loserSum.ok) {
    return err(
      'STATE',
      'rawSum overflow',
      `state.accounts.${loser}.rawSum`,
    );
  }

  const clone = cloneState(state);

  clone.accounts[winner] = {
    createdAtMs: winnerAccount.createdAtMs,
    completedDeals: winnerAccount.completedDeals,
    counterparties: winnerAccount.counterparties.slice(),
    rawSum: winnerSum.value,
    lastActiveAtMs: winnerAccount.lastActiveAtMs,
  };

  clone.accounts[loser] = {
    createdAtMs: loserAccount.createdAtMs,
    completedDeals: loserAccount.completedDeals,
    counterparties: loserAccount.counterparties.slice(),
    rawSum: loserSum.value,
    lastActiveAtMs: loserAccount.lastActiveAtMs,
  };

  clone.settled = insertSortedDistinct(clone.settled, settledKey);

  return ok(clone);
}

export function applyReputationEvent(
  state: ReputationState,
  payload: PayloadMap['ReputationEvent'],
  dealParties: { buyer: Pubkey; seller: Pubkey },
  dealStatus: string,
): Result<ReputationState> {
  if (payload.account === payload.counterparty) {
    return err(
      'SIGNER_AUTHORITY',
      'account and counterparty must differ',
      'payload.account',
    );
  }

  const matchesBuyerSeller =
    payload.account === dealParties.buyer &&
    payload.counterparty === dealParties.seller;
  const matchesSellerBuyer =
    payload.account === dealParties.seller &&
    payload.counterparty === dealParties.buyer;

  if (!matchesBuyerSeller && !matchesSellerBuyer) {
    return err(
      'SIGNER_AUTHORITY',
      'account and counterparty must be the deal parties',
      'payload.account',
    );
  }

  if (
    dealStatus !== 'completed' &&
    dealStatus !== 'resolved' &&
    dealStatus !== 'resolved_final'
  ) {
    return err('STATE', 'deal status does not allow reputation', 'dealStatus');
  }

  if (
    payload.delta !== -1 &&
    payload.delta !== 0 &&
    payload.delta !== 1
  ) {
    return err('FIELD_FORMAT', 'delta must be -1, 0 or 1', 'payload.delta');
  }

  const ratedKey = `${payload.deal_id}:${payload.account}`;

  if (state.rated.includes(ratedKey)) {
    return err('DUPLICATE', 'account already rated this deal', 'payload.account');
  }

  if (!Object.hasOwn(state.accounts, payload.account)) {
    return err(
      'STATE',
      'account is not registered',
      `state.accounts.${payload.account}`,
    );
  }

  if (!Object.hasOwn(state.accounts, payload.counterparty)) {
    return err(
      'STATE',
      'counterparty is not registered',
      `state.accounts.${payload.counterparty}`,
    );
  }

  const target = state.accounts[payload.counterparty];

  if (target === undefined) {
    return err(
      'STATE',
      'counterparty is not registered',
      `state.accounts.${payload.counterparty}`,
    );
  }

  const rawSum = addSigned(target.rawSum, payload.delta);

  if (!rawSum.ok) {
    return err(
      'STATE',
      'rawSum overflow',
      `state.accounts.${payload.counterparty}.rawSum`,
    );
  }

  const clone = cloneState(state);

  clone.accounts[payload.counterparty] = {
    createdAtMs: target.createdAtMs,
    completedDeals: target.completedDeals,
    counterparties: target.counterparties.slice(),
    rawSum: rawSum.value,
    lastActiveAtMs: target.lastActiveAtMs,
  };

  clone.rated = insertSortedDistinct(clone.rated, ratedKey);

  return ok(clone);
}

export function decayFactorPpm(
  idleMs: number,
  halfLifeMs: number,
): Result<number> {
  if (!isNonNegativeSafeInteger(idleMs)) {
    return err(
      'FIELD_FORMAT',
      'idleMs must be a non-negative safe integer',
      'idleMs',
    );
  }

  if (!isPositiveSafeInteger(halfLifeMs)) {
    return err(
      'FIELD_FORMAT',
      'halfLifeMs must be a positive safe integer',
      'halfLifeMs',
    );
  }

  const full = Math.floor(idleMs / halfLifeMs);

  if (full >= 20) {
    return ok(0);
  }

  const rem = idleMs - full * halfLifeMs;
  const shift = 1_000_000 >> full;
  const denominator = 2n * BigInt(halfLifeMs);
  const numerator = BigInt(shift) * (denominator - BigInt(rem));
  const factor = Number(numerator / denominator);

  return ok(factor);
}

export function isActive(
  account: AccountReputation,
  nowMs: number,
  params: ReputationParams,
): boolean {
  return (
    account.lastActiveAtMs !== null &&
    nowMs - account.lastActiveAtMs <= params.activeWindowMs
  );
}

export function effectiveSum(
  account: AccountReputation,
  nowMs: number,
  params: ReputationParams,
): Result<number> {
  if (!isNonNegativeSafeInteger(nowMs)) {
    return err(
      'FIELD_FORMAT',
      'nowMs must be a non-negative safe integer',
      'nowMs',
    );
  }

  if (!isNonNegativeSafeInteger(params.activeWindowMs)) {
    return err(
      'FIELD_FORMAT',
      'activeWindowMs must be a non-negative safe integer',
      'params.activeWindowMs',
    );
  }

  if (!isPositiveSafeInteger(params.decayHalfLifeMs)) {
    return err(
      'FIELD_FORMAT',
      'decayHalfLifeMs must be a positive safe integer',
      'params.decayHalfLifeMs',
    );
  }

  if (!Number.isSafeInteger(account.rawSum)) {
    return err(
      'STATE',
      'rawSum must be a safe integer',
      'state.accounts.rawSum',
    );
  }

  const base =
    account.lastActiveAtMs !== null
      ? account.lastActiveAtMs
      : account.createdAtMs;

  if (!isNonNegativeSafeInteger(base)) {
    return err(
      'STATE',
      'account timestamp must be a non-negative safe integer',
      'state.accounts',
    );
  }

  const threshold = addSigned(base, params.activeWindowMs);

  if (!threshold.ok) {
    return err(
      'LIMIT',
      'active window threshold overflow',
      'params.activeWindowMs',
    );
  }

  const idleRaw = nowMs - threshold.value;
  const idle = idleRaw > 0 ? idleRaw : 0;

  if (!Number.isSafeInteger(idle)) {
    return err('LIMIT', 'idle time overflow', 'nowMs');
  }

  const factor = decayFactorPpm(idle, params.decayHalfLifeMs);

  if (!factor.ok) {
    return err('FIELD_FORMAT', factor.error.message, factor.error.path);
  }

  const product = account.rawSum * factor.value;

  if (!Number.isSafeInteger(product)) {
    return err(
      'LIMIT',
      'effective sum overflow',
      'state.accounts.rawSum',
    );
  }

  return ok(Math.trunc(product / 1_000_000));
}

export function rankOf(
  account: AccountReputation,
  nowMs: number,
  params: ReputationParams,
): Result<number> {
  const effective = effectiveSum(account, nowMs, params);

  if (!effective.ok) {
    return err(effective.error.code, effective.error.message, effective.error.path);
  }

  const quality = effective.value > 0 ? effective.value : 0;
  const rank = account.counterparties.length + quality;

  if (!Number.isSafeInteger(rank)) {
    return err('LIMIT', 'rank overflow', 'rank');
  }

  return ok(rank);
}

export function toJuryCandidate(
  pubkey: Pubkey,
  account: AccountReputation,
): JuryCandidate {
  return {
    pubkey,
    createdAtMs: account.createdAtMs,
    completedDeals: account.completedDeals,
    distinctCounterparties: account.counterparties.length,
    reputationSum: account.rawSum,
  };
}

export function canonicalizeReputationState(
  state: ReputationState,
): ReputationState {
  const accounts = createNullRecord<AccountReputation>();
  const keys = Object.keys(state.accounts).sort(compareUtf8);

  for (const key of keys) {
    const account = state.accounts[key];

    if (account !== undefined) {
      accounts[key] = {
        createdAtMs: account.createdAtMs,
        completedDeals: account.completedDeals,
        counterparties: account.counterparties.slice().sort(compareUtf8),
        rawSum: account.rawSum,
        lastActiveAtMs: account.lastActiveAtMs,
      };
    }
  }

  return {
    accounts,
    rated: state.rated.slice().sort(compareUtf8),
    settled: state.settled.slice().sort(compareUtf8),
  };
}

export function assertReputationInvariants(
  state: ReputationState,
): Result<true> {
  if (!isStrictlyAscending(state.rated)) {
    return err('STATE', 'rated must be strictly ascending', 'rated');
  }

  if (!isStrictlyAscending(state.settled)) {
    return err('STATE', 'settled must be strictly ascending', 'settled');
  }

  for (const key of Object.keys(state.accounts)) {
    const account = state.accounts[key];

    if (account === undefined) {
      return err('STATE', 'account is missing', `state.accounts.${key}`);
    }

    if (!isNonNegativeSafeInteger(account.createdAtMs)) {
      return err(
        'STATE',
        'createdAtMs must be a non-negative safe integer',
        `state.accounts.${key}.createdAtMs`,
      );
    }

    if (
      !Number.isSafeInteger(account.completedDeals) ||
      account.completedDeals < 0
    ) {
      return err(
        'STATE',
        'completedDeals must be a non-negative safe integer',
        `state.accounts.${key}.completedDeals`,
      );
    }

    if (!Number.isSafeInteger(account.rawSum)) {
      return err(
        'STATE',
        'rawSum must be a safe integer',
        `state.accounts.${key}.rawSum`,
      );
    }

    if (
      account.lastActiveAtMs !== null &&
      !isNonNegativeSafeInteger(account.lastActiveAtMs)
    ) {
      return err(
        'STATE',
        'lastActiveAtMs must be null or a non-negative safe integer',
        `state.accounts.${key}.lastActiveAtMs`,
      );
    }

    if (!isStrictlyAscending(account.counterparties)) {
      return err(
        'STATE',
        'counterparties must be strictly ascending',
        `state.accounts.${key}.counterparties`,
      );
    }

    if (account.counterparties.length > account.completedDeals) {
      return err(
        'STATE',
        'counterparties cannot exceed completedDeals',
        `state.accounts.${key}.counterparties`,
      );
    }
  }

  return ok(true);
}