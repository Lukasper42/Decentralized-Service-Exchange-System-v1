/**
 * Tests for the deterministic accounting projector.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AMOUNT_MAX } from './protocol.js';
import type { Result } from './protocol.js';
import type { Movement, FundsView } from './ports.js';
import {
  assertConservation,
  applyIssuance,
  applyMovements,
  applyTreasurySpend,
  balanceOf,
  canonicalizeAccountingState,
  initialAccountingState,
  spendableView,
} from './accounting.js';
import type { AccountingState } from './accounting.js';

function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} at ${r.error.path}`);
  return r.value;
}

function init(options?: { treasury?: number }): AccountingState {
  return must(initialAccountingState(options));
}

function issue(
  state: AccountingState,
  nonce: string,
  recipient: string,
  amount: number,
): AccountingState {
  return must(applyIssuance(state, { nonce, recipient, amount }));
}

function treasurySpend(
  state: AccountingState,
  nonce: string,
  recipient: string,
  amount: number,
): AccountingState {
  return must(applyTreasurySpend(state, { nonce, recipient, amount }));
}

function movement(
  kind: Movement['kind'],
  dealId: string,
  amount: number,
  account?: string,
): Movement {
  switch (kind) {
    case 'escrow_lock':
      assert.ok(account !== undefined);
      return { kind, dealId, from: account, amount };

    case 'escrow_release_to_seller':
      assert.ok(account !== undefined);
      return { kind, dealId, to: account, amount };

    case 'escrow_refund_to_buyer':
      assert.ok(account !== undefined);
      return { kind, dealId, to: account, amount };

    case 'fee_burn':
      return { kind, dealId, amount };

    case 'appeal_escrow_lock':
      assert.ok(account !== undefined);
      return { kind, dealId, from: account, amount };

    case 'appeal_fee_return':
      assert.ok(account !== undefined);
      return { kind, dealId, to: account, amount };

    case 'appeal_fee_burn':
      return { kind, dealId, amount };

    case 'juror_payout':
      assert.ok(account !== undefined);
      return { kind, dealId, to: account, amount };

    default: {
      const _x: never = kind;
      return _x;
    }
  }
}

function move(state: AccountingState, movements: readonly Movement[]): AccountingState {
  return must(applyMovements(state, movements));
}

test('all movement types apply exact balances and preserve conservation', () => {
  let s = init();
  s = issue(s, 'i1', 'buyer', 1000);

  s = move(s, [movement('escrow_lock', 'd1', 500, 'buyer')]);
  assert.equal(balanceOf(s, 'buyer'), 500);
  assert.equal(s.escrow['d1'], 500);
  assert.ok(assertConservation(s).ok);

  s = move(s, [movement('escrow_release_to_seller', 'd1', 300, 'seller')]);
  assert.equal(s.escrow['d1'], 200);
  assert.equal(balanceOf(s, 'seller'), 300);
  assert.ok(assertConservation(s).ok);

  s = move(s, [movement('escrow_refund_to_buyer', 'd1', 100, 'buyer')]);
  assert.equal(s.escrow['d1'], 100);
  assert.equal(balanceOf(s, 'buyer'), 600);
  assert.ok(assertConservation(s).ok);

  s = move(s, [movement('fee_burn', 'd1', 100)]);
  assert.equal(s.escrow['d1'], undefined);
  assert.equal(s.issuedSupply, 900);
  assert.equal(s.burned, 100);
  assert.ok(assertConservation(s).ok);

  s = move(s, [movement('appeal_escrow_lock', 'd1', 50, 'buyer')]);
  assert.equal(s.appealEscrow['d1'], 50);
  assert.equal(balanceOf(s, 'buyer'), 550);
  assert.ok(assertConservation(s).ok);

  s = move(s, [movement('appeal_fee_return', 'd1', 20, 'seller')]);
  assert.equal(s.appealEscrow['d1'], 30);
  assert.equal(balanceOf(s, 'seller'), 320);
  assert.ok(assertConservation(s).ok);

  s = move(s, [movement('appeal_fee_burn', 'd1', 30)]);
  assert.equal(s.appealEscrow['d1'], undefined);
  assert.equal(s.issuedSupply, 870);
  assert.equal(s.burned, 130);
  assert.ok(assertConservation(s).ok);
});

test('complete deal flow: issuance, lock, release, fee burn', () => {
  let s = init();
  s = issue(s, 'deal-issuance', 'buyer', 1000);
  s = move(s, [movement('escrow_lock', 'deal-1', 500, 'buyer')]);
  s = move(s, [movement('escrow_release_to_seller', 'deal-1', 495, 'seller')]);
  s = move(s, [movement('fee_burn', 'deal-1', 5)]);

  assert.equal(balanceOf(s, 'buyer'), 500);
  assert.equal(balanceOf(s, 'seller'), 495);
  assert.equal(s.escrow['deal-1'], undefined);
  assert.equal(s.issuedSupply, 995);
  assert.equal(s.burned, 5);
  assert.equal(s.treasury, 0);
  assert.ok(assertConservation(s).ok);
});

test('refund flow restores buyer balance and leaves supply unchanged', () => {
  let s = init();
  s = issue(s, 'refund-issuance', 'buyer', 1000);
  s = move(s, [movement('escrow_lock', 'deal-refund', 500, 'buyer')]);
  s = move(s, [movement('escrow_refund_to_buyer', 'deal-refund', 500, 'buyer')]);

  assert.equal(balanceOf(s, 'buyer'), 1000);
  assert.equal(s.escrow['deal-refund'], undefined);
  assert.equal(s.issuedSupply, 1000);
  assert.equal(s.burned, 0);
  assert.ok(assertConservation(s).ok);
});

test('appeal flow supports lock, return, and burn', () => {
  let s = init();
  s = issue(s, 'appeal-issuance', 'buyer', 1000);
  s = move(s, [movement('appeal_escrow_lock', 'appeal-1', 100, 'buyer')]);
  s = move(s, [movement('appeal_fee_return', 'appeal-1', 60, 'helper')]);
  s = move(s, [movement('appeal_fee_burn', 'appeal-1', 40)]);

  assert.equal(balanceOf(s, 'buyer'), 900);
  assert.equal(balanceOf(s, 'helper'), 60);
  assert.equal(s.appealEscrow['appeal-1'], undefined);
  assert.equal(s.issuedSupply, 960);
  assert.equal(s.burned, 40);
  assert.ok(assertConservation(s).ok);
});

test('fee_burn and appeal_fee_burn accept amount 1', () => {
  let s = init();
  s = issue(s, 'fee-one-issuance', 'buyer', 100);

  s = move(s, [movement('escrow_lock', 'fee-one', 10, 'buyer')]);
  s = move(s, [movement('fee_burn', 'fee-one', 1)]);
  assert.equal(s.escrow['fee-one'], 9);
  assert.equal(s.burned, 1);
  assert.equal(s.issuedSupply, 99);
  assert.ok(assertConservation(s).ok);

  s = move(s, [movement('appeal_escrow_lock', 'fee-one', 10, 'buyer')]);
  s = move(s, [movement('appeal_fee_burn', 'fee-one', 1)]);
  assert.equal(s.appealEscrow['fee-one'], 9);
  assert.equal(s.burned, 2);
  assert.equal(s.issuedSupply, 98);
  assert.ok(assertConservation(s).ok);
});

test('treasury spend debits treasury and credits recipient', () => {
  let s = init({ treasury: 1000 });
  s = treasurySpend(s, 'treasury-1', 'alice', 250);

  assert.equal(s.treasury, 750);
  assert.equal(balanceOf(s, 'alice'), 250);
  assert.equal(s.issuedSupply, 1000);
  assert.ok(assertConservation(s).ok);
});

test('rejects insufficient spendable balance', () => {
  let s = init();
  s = issue(s, 'insufficient-spendable', 'alice', 10);

  const r = applyMovements(s, [movement('escrow_lock', 'd', 11, 'alice')]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'INSUFFICIENT_FUNDS');
});

test('rejects escrow overdraw', () => {
  let s = init();
  s = issue(s, 'escrow-overdraw', 'alice', 100);
  s = move(s, [movement('escrow_lock', 'd', 100, 'alice')]);

  const r = applyMovements(s, [movement('escrow_release_to_seller', 'd', 101, 'bob')]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'INSUFFICIENT_FUNDS');
});

test('rejects appeal escrow overdraw', () => {
  let s = init();
  s = issue(s, 'appeal-overdraw', 'alice', 100);
  s = move(s, [movement('appeal_escrow_lock', 'd', 50, 'alice')]);

  const r = applyMovements(s, [movement('appeal_fee_return', 'd', 51, 'bob')]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'INSUFFICIENT_FUNDS');
});

test('rejects invalid movement amounts', () => {
  const s = init();

  for (const amount of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    AMOUNT_MAX + 1,
  ]) {
    const r = applyMovements(s, [movement('escrow_lock', 'd', amount, 'alice')]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'AMOUNT');
  }
});

test('rejects event amounts below AMOUNT_MIN', () => {
  const issuance = applyIssuance(init(), {
    nonce: 'issuance-amount-one',
    recipient: 'alice',
    amount: 1,
  });
  assert.equal(issuance.ok, false);
  if (!issuance.ok) assert.equal(issuance.error.code, 'AMOUNT');

  const treasury = applyTreasurySpend(init({ treasury: 10 }), {
    nonce: 'treasury-amount-one',
    recipient: 'alice',
    amount: 1,
  });
  assert.equal(treasury.ok, false);
  if (!treasury.ok) assert.equal(treasury.error.code, 'AMOUNT');
});

test('rejects overflow when adding balances', () => {
  const base = init();
  const state: AccountingState = {
    ...base,
    spendable: { alice: Number.MAX_SAFE_INTEGER - 1 },
    issuedSupply: Number.MAX_SAFE_INTEGER - 1,
  };

  const r = applyIssuance(state, {
    nonce: 'overflow',
    recipient: 'alice',
    amount: 2,
  });

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'AMOUNT');
});

test('rejects issuance nonce replay', () => {
  let s = init();
  s = issue(s, 'same-nonce', 'alice', 10);

  const r = applyIssuance(s, {
    nonce: 'same-nonce',
    recipient: 'alice',
    amount: 10,
  });

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'REPLAY');
});

test('rejects treasury nonce replay', () => {
  let s = init({ treasury: 100 });
  s = treasurySpend(s, 'same-treasury-nonce', 'alice', 10);

  const r = applyTreasurySpend(s, {
    nonce: 'same-treasury-nonce',
    recipient: 'alice',
    amount: 10,
  });

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'REPLAY');
});

test('rejects treasury underflow', () => {
  const s = init({ treasury: 10 });

  const r = applyTreasurySpend(s, {
    nonce: 'too-much',
    recipient: 'alice',
    amount: 11,
  });

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'INSUFFICIENT_FUNDS');
});

test('detects corrupt state with STATE errors', () => {
  const base = init();

  const violatedEquation: AccountingState = {
    ...base,
    issuedSupply: 10,
    spendable: { alice: 5 },
  };
  const equationResult = assertConservation(violatedEquation);
  assert.equal(equationResult.ok, false);
  if (!equationResult.ok) assert.equal(equationResult.error.code, 'STATE');

  const negativeBalance: AccountingState = {
    ...base,
    spendable: { alice: -1 },
  };
  const negativeResult = assertConservation(negativeBalance);
  assert.equal(negativeResult.ok, false);
  if (!negativeResult.ok) assert.equal(negativeResult.error.code, 'STATE');

  const unsortedNonces: AccountingState = {
    ...base,
    usedNonces: ['b', 'a'],
  };
  const nonceResult = assertConservation(unsortedNonces);
  assert.equal(nonceResult.ok, false);
  if (!nonceResult.ok) assert.equal(nonceResult.error.code, 'STATE');
});

test('detects a corrupt juror payout shortfall', () => {
  const corrupt: AccountingState = { ...init(), jurorPayoutShortfall: -1 };
  const r = assertConservation(corrupt);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'STATE');
});

test('rejects invalid initial treasury amount', () => {
  const r = initialAccountingState({ treasury: -1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'AMOUNT');
});

test('movement lists are atomic', () => {
  let s = init();
  s = issue(s, 'atomic', 'alice', 100);

  const beforeRef = s;
  const beforeCanonical = canonicalizeAccountingState(s);

  const r = applyMovements(s, [
    movement('escrow_lock', 'd', 10, 'alice'),
    movement('escrow_lock', 'd', 200, 'alice'),
  ]);

  assert.equal(r.ok, false);
  assert.equal(s, beforeRef);
  assert.equal(canonicalizeAccountingState(s), beforeCanonical);
});

test('frozen inputs are not mutated and operations do not throw', () => {
  const state = issue(init(), 'freeze', 'alice', 100);
  const beforeCanonical = canonicalizeAccountingState(state);

  Object.freeze(state.spendable);
  Object.freeze(state.escrow);
  Object.freeze(state.appealEscrow);
  Object.freeze(state.usedNonces);
  Object.freeze(state);

  const successMovements: Movement[] = [movement('escrow_lock', 'd', 10, 'alice')];
  Object.freeze(successMovements);
  for (const m of successMovements) Object.freeze(m);

  const success = applyMovements(state, successMovements);
  assert.equal(success.ok, true);
  assert.equal(canonicalizeAccountingState(state), beforeCanonical);

  const failureMovements: Movement[] = [movement('escrow_lock', 'd', 200, 'alice')];
  Object.freeze(failureMovements);
  for (const m of failureMovements) Object.freeze(m);

  const failure = applyMovements(state, failureMovements);
  assert.equal(failure.ok, false);
  assert.equal(canonicalizeAccountingState(state), beforeCanonical);
});

test('spendableView exposes the FundsView spendable function', () => {
  const s = issue(init(), 'view', 'alice', 10);
  const view: FundsView = spendableView(s);

  assert.equal(view.spendable('alice'), 10);
  assert.equal(view.spendable('bob'), 0);
});

test('dangerous keys behave like normal keys and survive canonical JSON', () => {
  let s = init();
  s = issue(s, 'i-proto', '__proto__', 10);
  s = issue(s, 'i-constructor', 'constructor', 20);
  s = issue(s, 'i-tostring', 'toString', 30);
  s = issue(s, 'i-alice', 'alice', 100);
  s = move(s, [movement('escrow_lock', '__proto__', 40, 'alice')]);

  assert.equal(balanceOf(s, '__proto__'), 10);
  assert.equal(balanceOf(s, 'constructor'), 20);
  assert.equal(balanceOf(s, 'toString'), 30);
  assert.equal(s.escrow['__proto__'], 40);
  assert.ok(assertConservation(s).ok);

  const parsed = JSON.parse(canonicalizeAccountingState(s)) as {
    spendable: Record<string, number>;
    escrow: Record<string, number>;
    appealEscrow: Record<string, number>;
  };

  assert.equal(Object.hasOwn(parsed.spendable, '__proto__'), true);
  assert.equal(parsed.spendable['__proto__'], 10);
  assert.equal(Object.hasOwn(parsed.spendable, 'constructor'), true);
  assert.equal(parsed.spendable['constructor'], 20);
  assert.equal(Object.hasOwn(parsed.spendable, 'toString'), true);
  assert.equal(parsed.spendable['toString'], 30);
  assert.equal(Object.hasOwn(parsed.escrow, '__proto__'), true);
  assert.equal(parsed.escrow['__proto__'], 40);
});

test('deterministic canonical state is independent of insertion order', () => {
  const first = issue(
    issue(init(), 'nonce-a', 'alice', 10),
    'nonce-b',
    'bob',
    20,
  );

  const second = issue(
    issue(init(), 'nonce-b', 'bob', 20),
    'nonce-a',
    'alice',
    10,
  );

  assert.equal(canonicalizeAccountingState(first), canonicalizeAccountingState(second));

  const view: FundsView = spendableView(first);
  assert.equal(view.spendable('alice'), 10);
});

test('different paths to the same state produce the same canonical form', () => {
  const withRoundTrip = move(
    move(issue(init(), 'same-path', 'buyer', 100), [
      movement('escrow_lock', 'd', 50, 'buyer'),
    ]),
    [movement('escrow_refund_to_buyer', 'd', 50, 'buyer')],
  );

  const withoutAction = issue(init(), 'same-path', 'buyer', 100);

  assert.equal(
    canonicalizeAccountingState(withRoundTrip),
    canonicalizeAccountingState(withoutAction),
  );
  assert.equal(Object.hasOwn(withRoundTrip.escrow, 'd'), false);
});

test('juror payout moves treasury funds to the juror', () => {
  let s = init({ treasury: 1000 });
  s = move(s, [movement('juror_payout', 'd1', 100, 'j1')]);

  assert.equal(s.treasury, 900);
  assert.equal(balanceOf(s, 'j1'), 100);
  assert.equal(s.jurorPayoutShortfall, 0);
  assert.equal(s.issuedSupply, 1000);
  assert.ok(assertConservation(s).ok);
});

test('juror payout pays only what the treasury holds and records the shortfall', () => {
  let s = init({ treasury: 30 });
  s = move(s, [movement('juror_payout', 'd1', 100, 'j1')]);

  assert.equal(s.treasury, 0);
  assert.equal(balanceOf(s, 'j1'), 30);
  assert.equal(s.jurorPayoutShortfall, 70);
  assert.ok(assertConservation(s).ok);
});

test('juror payout with an empty treasury moves nothing and grows the shortfall', () => {
  let s = init();
  s = move(s, [movement('juror_payout', 'd1', 100, 'j1')]);

  assert.equal(balanceOf(s, 'j1'), 0);
  assert.equal(Object.hasOwn(s.spendable, 'j1'), false);
  assert.equal(s.jurorPayoutShortfall, 100);
  assert.ok(assertConservation(s).ok);
});

test('three juror payouts in roster order drain the treasury in order', () => {
  let s = init({ treasury: 250 });
  s = move(s, [
    movement('juror_payout', 'd1', 100, 'j1'),
    movement('juror_payout', 'd1', 100, 'j2'),
    movement('juror_payout', 'd1', 100, 'j3'),
  ]);

  assert.equal(balanceOf(s, 'j1'), 100);
  assert.equal(balanceOf(s, 'j2'), 100);
  assert.equal(balanceOf(s, 'j3'), 50);
  assert.equal(s.treasury, 0);
  assert.equal(s.jurorPayoutShortfall, 50);
  assert.ok(assertConservation(s).ok);
});

test('juror payout rejects invalid amounts', () => {
  const s = init({ treasury: 1000 });

  for (const amount of [0, -1, 1.5, AMOUNT_MAX + 1]) {
    const r = applyMovements(s, [movement('juror_payout', 'd1', amount, 'j1')]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'AMOUNT');
  }
});

test('a failing movement after a juror payout leaves the state unchanged', () => {
  const s = init({ treasury: 1000 });
  const before = canonicalizeAccountingState(s);

  const r = applyMovements(s, [
    movement('juror_payout', 'd1', 100, 'j1'),
    movement('escrow_release_to_seller', 'missing', 5, 'j1'),
  ]);

  assert.equal(r.ok, false);
  assert.equal(canonicalizeAccountingState(s), before);
});

test('canonical form contains the juror payout shortfall', () => {
  const s = move(init(), [movement('juror_payout', 'd1', 10, 'j1')]);
  const parsed = JSON.parse(canonicalizeAccountingState(s)) as { jurorPayoutShortfall: number };
  assert.equal(parsed.jurorPayoutShortfall, 10);
});

test('seeded random sequences preserve invariant and leave state unchanged on errors', () => {
  let seed = 0xdecafbad >>> 0;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const int = (max: number): number => Math.floor(rand() * max);

  const movementKinds: readonly Movement['kind'][] = [
    'escrow_lock',
    'escrow_release_to_seller',
    'escrow_refund_to_buyer',
    'fee_burn',
    'appeal_escrow_lock',
    'appeal_fee_return',
    'appeal_fee_burn',
    'juror_payout',
  ];

  for (let seq = 0; seq < 500; seq += 1) {
    let state = init({ treasury: 10000 });

    for (let step = 0; step < 8; step += 1) {
      const before = state;
      const beforeCanonical = canonicalizeAccountingState(state);
      const dealId = `d${int(5)}`;
      const account = `a${int(3)}`;
      const amount = int(80);
      const nonce = `s${seq}-${step}`;
      const op = int(9);

      let result: Result<AccountingState>;

      if (op === 0) {
        result = applyIssuance(state, {
          nonce: `i-${nonce}`,
          recipient: account,
          amount,
        });
      } else if (op === 1) {
        result = applyTreasurySpend(state, {
          nonce: `t-${nonce}`,
          recipient: account,
          amount,
        });
      } else {
        const kind = movementKinds[int(movementKinds.length)]!;
        const needsAccount = kind !== 'fee_burn' && kind !== 'appeal_fee_burn';
        result = applyMovements(state, [
          movement(kind, dealId, amount, needsAccount ? account : undefined),
        ]);
      }

      if (result.ok) {
        state = result.value;
        assert.equal(assertConservation(state).ok, true);
      } else {
        assert.equal(state, before);
        assert.equal(canonicalizeAccountingState(state), beforeCanonical);
      }
    }
  }
});