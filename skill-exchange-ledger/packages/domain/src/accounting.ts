/**
 * Deterministic accounting projector for the Skill Exchange Ledger.
 *
 * This module applies ledger movements, issuance, and treasury spends to an
 * immutable, JSON-serializable accounting state. Approval checks and policy
 * limits are intentionally out of scope here and belong in policy.ts.
 */

import { ok, err, AMOUNT_MIN, AMOUNT_MAX } from './protocol.js';
import type { Result, Pubkey, ErrorCode, PayloadMap } from './protocol.js';
import { checkedAdd, checkedSub } from './amount.js';
import type { Movement, FundsView } from './ports.js';

export interface AccountingState {
  readonly spendable: Readonly<Record<Pubkey, number>>;
  readonly escrow: Readonly<Record<string, number>>;
  readonly appealEscrow: Readonly<Record<string, number>>;
  readonly issuedSupply: number;
  readonly burned: number;
  readonly usedNonces: readonly string[];
  readonly treasury: number;
  readonly jurorPayoutShortfall: number;
}

type MutableAccountingState = {
  spendable: Record<Pubkey, number>;
  escrow: Record<string, number>;
  appealEscrow: Record<string, number>;
  issuedSupply: number;
  burned: number;
  usedNonces: string[];
  treasury: number;
  jurorPayoutShortfall: number;
};

const AMOUNT_CODE: ErrorCode = 'AMOUNT';
const REPLAY_CODE: ErrorCode = 'REPLAY';
const STATE_CODE: ErrorCode = 'STATE';
const INSUFFICIENT_FUNDS_CODE: ErrorCode = 'INSUFFICIENT_FUNDS';

function fail<T>(code: ErrorCode, message: string, path: string): Result<T> {
  return err(code, message, path);
}

function emptyRecord<T extends string>(): Record<T, number> {
  return Object.create(null) as Record<T, number>;
}

function getNumber<T extends string>(record: Readonly<Record<T, number>>, key: T): number {
  if (!Object.hasOwn(record, key)) return 0;
  const value = record[key];
  return value === undefined ? 0 : value;
}

function setNumber<T extends string>(record: Record<T, number>, key: T, value: number): void {
  if (value === 0) {
    if (Object.hasOwn(record, key)) delete record[key];
    return;
  }

  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cloneRecord<T extends string>(record: Readonly<Record<T, number>>): Record<T, number> {
  const out = emptyRecord<T>();
  for (const key of Object.keys(record) as T[]) {
    const value = record[key];
    if (value !== undefined) setNumber(out, key, value);
  }
  return out;
}

function cloneState(state: AccountingState): MutableAccountingState {
  return {
    spendable: cloneRecord(state.spendable),
    escrow: cloneRecord(state.escrow),
    appealEscrow: cloneRecord(state.appealEscrow),
    issuedSupply: state.issuedSupply,
    burned: state.burned,
    usedNonces: [...state.usedNonces],
    treasury: state.treasury,
    jurorPayoutShortfall: state.jurorPayoutShortfall,
  };
}

function addNonce(nonces: string[], key: string): void {
  let index = 0;
  while (index < nonces.length && (nonces[index] ?? '') < key) index += 1;
  if (nonces[index] === key) return;
  nonces.splice(index, 0, key);
}

function checkStateInteger(value: number, path: string): Result<true> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return fail(STATE_CODE, 'Expected non-negative safe integer', path);
  }
  return ok(true);
}

function validateMovementAmount(amount: number, path: string): Result<true> {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > AMOUNT_MAX) {
    return fail(
      AMOUNT_CODE,
      'Movement amount must be an integer between 1 and AMOUNT_MAX',
      path,
    );
  }
  return ok(true);
}

function validateEventAmount(amount: number, path: string): Result<true> {
  if (!Number.isSafeInteger(amount) || amount < AMOUNT_MIN || amount > AMOUNT_MAX) {
    return fail(
      AMOUNT_CODE,
      'Event amount must be an integer between AMOUNT_MIN and AMOUNT_MAX',
      path,
    );
  }
  return ok(true);
}

function debit<T extends string>(
  record: Record<T, number>,
  key: T,
  amount: number,
  path: string,
): Result<true> {
  const current = getNumber(record, key);

  if (!Number.isSafeInteger(current) || current < 0) {
    return fail(STATE_CODE, 'Corrupt balance', path);
  }

  if (current < amount) {
    return fail(INSUFFICIENT_FUNDS_CODE, 'Insufficient balance', path);
  }

  const next = checkedSub(current, amount);
  if (!next.ok) {
    return fail(next.error.code, next.error.message, path);
  }

  setNumber(record, key, next.value);
  return ok(true);
}

function credit<T extends string>(
  record: Record<T, number>,
  key: T,
  amount: number,
  path: string,
): Result<true> {
  const current = getNumber(record, key);

  if (!Number.isSafeInteger(current) || current < 0) {
    return fail(STATE_CODE, 'Corrupt balance', path);
  }

  const next = checkedAdd(current, amount);
  if (!next.ok) {
    return fail(next.error.code, next.error.message, path);
  }

  setNumber(record, key, next.value);
  return ok(true);
}

function burnSupply(
  draft: MutableAccountingState,
  amount: number,
  _path: string,
): Result<true> {
  const supplyCheck = checkStateInteger(draft.issuedSupply, 'state.issuedSupply');
  if (!supplyCheck.ok) return supplyCheck;

  const burnedCheck = checkStateInteger(draft.burned, 'state.burned');
  if (!burnedCheck.ok) return burnedCheck;

  if (draft.issuedSupply < amount) {
    return fail(STATE_CODE, 'Corrupt issued supply', 'state.issuedSupply');
  }

  const supplyNext = checkedSub(draft.issuedSupply, amount);
  if (!supplyNext.ok) {
    return fail(STATE_CODE, supplyNext.error.message, 'state.issuedSupply');
  }

  const burnedNext = checkedAdd(draft.burned, amount);
  if (!burnedNext.ok) {
    return fail(STATE_CODE, burnedNext.error.message, 'state.burned');
  }

  draft.issuedSupply = supplyNext.value;
  draft.burned = burnedNext.value;

  return ok(true);
}

function sumRecord<T extends string>(
  record: Readonly<Record<T, number>>,
  path: string,
): Result<number> {
  let sum = 0;

  for (const key of Object.keys(record) as T[]) {
    const value = getNumber(record, key);
    const check = checkStateInteger(value, `${path}.${key}`);
    if (!check.ok) {
      return fail<number>(check.error.code, check.error.message, check.error.path);
    }

    const next = checkedAdd(sum, value);
    if (!next.ok) {
      return fail<number>(STATE_CODE, next.error.message, `${path}.${key}`);
    }

    sum = next.value;
  }

  return ok(sum);
}

/**
 * Verifies that total value is conserved:
 * sum(spendable) + treasury + sum(escrow) + sum(appealEscrow) === issuedSupply
 */
export function assertConservation(state: AccountingState): Result<true> {
  const supply = checkStateInteger(state.issuedSupply, 'state.issuedSupply');
  if (!supply.ok) return supply;

  const burned = checkStateInteger(state.burned, 'state.burned');
  if (!burned.ok) return burned;

  const treasury = checkStateInteger(state.treasury, 'state.treasury');
  if (!treasury.ok) return treasury;

  const shortfall = checkStateInteger(state.jurorPayoutShortfall, 'state.jurorPayoutShortfall');
  if (!shortfall.ok) return shortfall;

  const spendable = sumRecord(state.spendable, 'state.spendable');
  if (!spendable.ok) {
    return fail<true>(spendable.error.code, spendable.error.message, spendable.error.path);
  }

  let total = spendable.value;

  const withTreasury = checkedAdd(total, state.treasury);
  if (!withTreasury.ok) {
    return fail<true>(STATE_CODE, withTreasury.error.message, 'state.treasury');
  }
  total = withTreasury.value;

  const escrow = sumRecord(state.escrow, 'state.escrow');
  if (!escrow.ok) {
    return fail<true>(escrow.error.code, escrow.error.message, escrow.error.path);
  }

  const withEscrow = checkedAdd(total, escrow.value);
  if (!withEscrow.ok) {
    return fail<true>(STATE_CODE, withEscrow.error.message, 'state.escrow');
  }
  total = withEscrow.value;

  const appealEscrow = sumRecord(state.appealEscrow, 'state.appealEscrow');
  if (!appealEscrow.ok) {
    return fail<true>(
      appealEscrow.error.code,
      appealEscrow.error.message,
      appealEscrow.error.path,
    );
  }

  const withAppealEscrow = checkedAdd(total, appealEscrow.value);
  if (!withAppealEscrow.ok) {
    return fail<true>(STATE_CODE, withAppealEscrow.error.message, 'state.appealEscrow');
  }
  total = withAppealEscrow.value;

  if (total !== state.issuedSupply) {
    return fail(
      STATE_CODE,
      `Conservation violated: total ${total} !== issuedSupply ${state.issuedSupply}`,
      'state.issuedSupply',
    );
  }

  for (let i = 1; i < state.usedNonces.length; i += 1) {
    const previousNonce = state.usedNonces[i - 1];
    const currentNonce = state.usedNonces[i];
    if (previousNonce === undefined || currentNonce === undefined || previousNonce >= currentNonce) {
      return fail(STATE_CODE, 'usedNonces must be sorted and unique', 'state.usedNonces');
    }
  }

  return ok(true);
}

/**
 * Creates the initial accounting state. Treasury funding is supplied by policy
 * later; this only establishes the optional starting treasury balance.
 */
export function initialAccountingState(options?: {
  readonly treasury?: number;
}): Result<AccountingState> {
  const treasury = options?.treasury ?? 0;

  if (!Number.isSafeInteger(treasury) || treasury < 0 || treasury > AMOUNT_MAX) {
    return fail<AccountingState>(AMOUNT_CODE, 'Invalid initial treasury amount', 'treasury');
  }

  return ok({
    spendable: emptyRecord<Pubkey>(),
    escrow: emptyRecord<string>(),
    appealEscrow: emptyRecord<string>(),
    issuedSupply: treasury,
    burned: 0,
    usedNonces: [],
    treasury,
    jurorPayoutShortfall: 0,
  });
}

function applyMovement(
  draft: MutableAccountingState,
  movement: Movement,
  path: string,
): Result<true> {
  const amountCheck = validateMovementAmount(movement.amount, `${path}.amount`);
  if (!amountCheck.ok) return amountCheck;

  switch (movement.kind) {
    case 'escrow_lock': {
      const debited = debit(draft.spendable, movement.from, movement.amount, `${path}.from`);
      if (!debited.ok) return debited;

      return credit(draft.escrow, movement.dealId, movement.amount, `${path}.dealId`);
    }

    case 'escrow_release_to_seller': {
      const debited = debit(draft.escrow, movement.dealId, movement.amount, `${path}.dealId`);
      if (!debited.ok) return debited;

      return credit(draft.spendable, movement.to, movement.amount, `${path}.to`);
    }

    case 'escrow_refund_to_buyer': {
      const debited = debit(draft.escrow, movement.dealId, movement.amount, `${path}.dealId`);
      if (!debited.ok) return debited;

      return credit(draft.spendable, movement.to, movement.amount, `${path}.to`);
    }

    case 'fee_burn': {
      const debited = debit(draft.escrow, movement.dealId, movement.amount, `${path}.dealId`);
      if (!debited.ok) return debited;

      return burnSupply(draft, movement.amount, `${path}.amount`);
    }

    case 'appeal_escrow_lock': {
      const debited = debit(draft.spendable, movement.from, movement.amount, `${path}.from`);
      if (!debited.ok) return debited;

      return credit(draft.appealEscrow, movement.dealId, movement.amount, `${path}.dealId`);
    }

    case 'appeal_fee_return': {
      const debited = debit(
        draft.appealEscrow,
        movement.dealId,
        movement.amount,
        `${path}.dealId`,
      );
      if (!debited.ok) return debited;

      return credit(draft.spendable, movement.to, movement.amount, `${path}.to`);
    }

    case 'appeal_fee_burn': {
      const debited = debit(
        draft.appealEscrow,
        movement.dealId,
        movement.amount,
        `${path}.dealId`,
      );
      if (!debited.ok) return debited;

      return burnSupply(draft, movement.amount, `${path}.amount`);
    }

    case 'juror_payout': {
      const treasuryCheck = checkStateInteger(draft.treasury, 'state.treasury');
      if (!treasuryCheck.ok) return treasuryCheck;
      const shortfallCheck = checkStateInteger(draft.jurorPayoutShortfall, 'state.jurorPayoutShortfall');
      if (!shortfallCheck.ok) return shortfallCheck;

      // The treasury pays at most what it holds, so a dispute can never be blocked by an empty treasury.
      const paid = Math.min(movement.amount, draft.treasury);
      const unpaid = movement.amount - paid;

      const shortfallNext = checkedAdd(draft.jurorPayoutShortfall, unpaid);
      if (!shortfallNext.ok) {
        return fail(STATE_CODE, shortfallNext.error.message, 'state.jurorPayoutShortfall');
      }

      if (paid > 0) {
        const credited = credit(draft.spendable, movement.to, paid, `${path}.to`);
        if (!credited.ok) return credited;
        draft.treasury -= paid;
      }
      draft.jurorPayoutShortfall = shortfallNext.value;
      return ok(true);
    }

    default: {
      const _x: never = movement;
      return _x;
    }
  }
}

/**
 * Applies a list of movements atomically. The input state is never mutated.
 */
export function applyMovements(
  state: AccountingState,
  movements: readonly Movement[],
): Result<AccountingState> {
  const draft = cloneState(state);

  for (const [index, movement] of movements.entries()) {
    const applied = applyMovement(draft, movement, `movements[${index}]`);
    if (!applied.ok) {
      return fail<AccountingState>(
        applied.error.code,
        applied.error.message,
        applied.error.path,
      );
    }
  }

  const invariant = assertConservation(draft);
  if (!invariant.ok) {
    return fail<AccountingState>(
      invariant.error.code,
      invariant.error.message,
      invariant.error.path,
    );
  }

  return ok(draft);
}

/**
 * Applies a currency issuance payload. Approval and policy checks are not
 * performed here; they belong in policy.ts. Approvals, policy_id, grant_kind and purpose_hash are validated in policy.ts
 */
export function applyIssuance(
  state: AccountingState,
  p: Pick<PayloadMap['CurrencyIssued'], 'recipient' | 'amount' | 'nonce'>,
): Result<AccountingState> {
  const draft = cloneState(state);
  const nonceKey = `currency:${p.nonce}`;

  if (draft.usedNonces.includes(nonceKey)) {
    return fail<AccountingState>(REPLAY_CODE, 'Nonce already used', 'nonce');
  }

  const amountCheck = validateEventAmount(p.amount, 'amount');
  if (!amountCheck.ok) {
    return fail<AccountingState>(
      amountCheck.error.code,
      amountCheck.error.message,
      amountCheck.error.path,
    );
  }

  const credited = credit(draft.spendable, p.recipient, p.amount, 'recipient');
  if (!credited.ok) {
    return fail<AccountingState>(
      credited.error.code,
      credited.error.message,
      credited.error.path,
    );
  }

  const supply = checkedAdd(draft.issuedSupply, p.amount);
  if (!supply.ok) {
    return fail<AccountingState>(supply.error.code, supply.error.message, 'amount');
  }
  draft.issuedSupply = supply.value;

  addNonce(draft.usedNonces, nonceKey);

  const invariant = assertConservation(draft);
  if (!invariant.ok) {
    return fail<AccountingState>(
      invariant.error.code,
      invariant.error.message,
      invariant.error.path,
    );
  }

  return ok(draft);
}

/**
 * Applies a treasury spend payload. The treasury balance is debited and the
 * recipient spendable balance is credited. Approvals, policy_id, grant_kind and purpose_hash are validated in policy.ts
 */
export function applyTreasurySpend(
  state: AccountingState,
  p: Pick<PayloadMap['TreasurySpend'], 'recipient' | 'amount' | 'nonce'>,
): Result<AccountingState> {
  const draft = cloneState(state);
  const nonceKey = `treasury:${p.nonce}`;

  if (draft.usedNonces.includes(nonceKey)) {
    return fail<AccountingState>(REPLAY_CODE, 'Nonce already used', 'nonce');
  }

  const amountCheck = validateEventAmount(p.amount, 'amount');
  if (!amountCheck.ok) {
    return fail<AccountingState>(
      amountCheck.error.code,
      amountCheck.error.message,
      amountCheck.error.path,
    );
  }

  const treasuryCheck = checkStateInteger(draft.treasury, 'state.treasury');
  if (!treasuryCheck.ok) {
    return fail<AccountingState>(
      treasuryCheck.error.code,
      treasuryCheck.error.message,
      treasuryCheck.error.path,
    );
  }

  if (draft.treasury < p.amount) {
    return fail<AccountingState>(
      INSUFFICIENT_FUNDS_CODE,
      'Insufficient treasury balance',
      'amount',
    );
  }

  const treasuryNext = checkedSub(draft.treasury, p.amount);
  if (!treasuryNext.ok) {
    return fail<AccountingState>(
      STATE_CODE,
      treasuryNext.error.message,
      'state.treasury',
    );
  }
  draft.treasury = treasuryNext.value;

  const credited = credit(draft.spendable, p.recipient, p.amount, 'recipient');
  if (!credited.ok) {
    return fail<AccountingState>(
      credited.error.code,
      credited.error.message,
      credited.error.path,
    );
  }

  addNonce(draft.usedNonces, nonceKey);

  const invariant = assertConservation(draft);
  if (!invariant.ok) {
    return fail<AccountingState>(
      invariant.error.code,
      invariant.error.message,
      invariant.error.path,
    );
  }

  return ok(draft);
}

/**
 * Returns the spendable balance for a public key.
 */
export function balanceOf(state: AccountingState, pubkey: Pubkey): number {
  return getNumber(state.spendable, pubkey);
}

/**
 * Adapter exposing the spendable accounting view to the deal machine.
 */
export function spendableView(state: AccountingState): FundsView {
  return {
    spendable: (account: Pubkey) => balanceOf(state, account),
  };
}

/**
 * Produces canonical JSON with sorted record keys for reproducible state hashes.
 */
export function canonicalizeAccountingState(state: AccountingState): string {
  const sortRecord = <T extends string>(
    record: Readonly<Record<T, number>>,
  ): Record<string, number> => {
    const out = emptyRecord<string>();

    for (const key of (Object.keys(record) as T[]).sort()) {
      setNumber(out, key, getNumber(record, key));
    }

    return out;
  };

  return JSON.stringify({
    spendable: sortRecord(state.spendable),
    escrow: sortRecord(state.escrow),
    appealEscrow: sortRecord(state.appealEscrow),
    issuedSupply: state.issuedSupply,
    burned: state.burned,
    usedNonces: [...state.usedNonces].sort(),
    treasury: state.treasury,
    jurorPayoutShortfall: state.jurorPayoutShortfall,
  });
}