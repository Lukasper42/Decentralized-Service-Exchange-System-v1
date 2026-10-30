import test from 'node:test';
import assert from 'node:assert/strict';

import { newIdentity, h, DAY, T0 } from '../../testing/src/fixtures.js';
import type { PayloadMap, Result } from './protocol.js';
import {
  initialReputationState,
  registerAccount,
  applyDealCompleted,
  applyDisputeOutcome,
  applyReputationEvent,
  decayFactorPpm,
  effectiveSum,
  rankOf,
  toJuryCandidate,
  canonicalizeReputationState,
  assertReputationInvariants,
} from './reputation.js';
import type {
  AccountReputation,
  ReputationParams,
  ReputationState,
} from './reputation.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }

  return result.value;
}

function expectErr(result: Result<unknown>, code: string): void {
  assert.equal(result.ok, false);

  if (result.ok) {
    return;
  }

  assert.equal(result.error.code, code);
}

function snapshot(state: ReputationState): unknown {
  return JSON.parse(JSON.stringify(state));
}

function accountOf(state: ReputationState, pubkey: string): AccountReputation {
  assert.equal(Object.hasOwn(state.accounts, pubkey), true);

  const account = state.accounts[pubkey];

  if (account === undefined) {
    throw new Error('missing account');
  }

  return account;
}

function makePayload(
  account: string,
  counterparty: string,
  dealId: string,
  delta: unknown,
): PayloadMap['ReputationEvent'] {
  const raw = {
    account,
    counterparty,
    deal_id: dealId,
    delta,
    reason_hash: h('x'),
  };

  return JSON.parse(JSON.stringify(raw));
}

function stateWithAccount(account: AccountReputation): ReputationState {
  const accounts: Record<string, AccountReputation> = Object.create(null);
  accounts['a'] = account;

  return {
    accounts,
    rated: [],
    settled: [],
  };
}

function stateWithLists(rated: string[], settled: string[]): ReputationState {
  const accounts: Record<string, AccountReputation> = Object.create(null);

  return {
    accounts,
    rated,
    settled,
  };
}

function validInvariantState(): ReputationState {
  let state = initialReputationState();
  state = unwrap(registerAccount(state, 'a', T0));
  state = unwrap(registerAccount(state, 'b', T0));
  state = unwrap(applyDealCompleted(state, 'd1', 'a', 'b', T0 + DAY));
  state = unwrap(applyDisputeOutcome(state, 'd2', 'a', 'b'));

  return state;
}

function pickString(items: readonly string[], rnd: () => number): string {
  const value = items[rnd() % items.length];

  if (value === undefined) {
    throw new Error('empty items');
  }

  return value;
}

function pickTwo(
  items: readonly string[],
  rnd: () => number,
): { a: string; b: string } {
  const a = pickString(items, rnd);
  let b = pickString(items, rnd);

  while (b === a) {
    b = pickString(items, rnd);
  }

  return { a, b };
}

function createLcg(seed: number): () => number {
  let state = seed >>> 0;

  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

function totalRawSum(state: ReputationState): number {
  let total = 0;

  for (const key of Object.keys(state.accounts)) {
    const account = state.accounts[key];

    if (account !== undefined) {
      total += account.rawSum;
    }
  }

  return total;
}

test('applyDealCompleted counts both sides and tracks new counterparties', () => {
  const buyer = newIdentity().publicKey;
  const seller = newIdentity().publicKey;

  let state = initialReputationState();
  state = unwrap(registerAccount(state, buyer, T0));
  state = unwrap(registerAccount(state, seller, T0));

  const before = structuredClone(state);
  const first = unwrap(
    applyDealCompleted(state, 'deal-1', buyer, seller, T0 + DAY),
  );

  assert.deepEqual(snapshot(state), snapshot(before));

  const firstBuyer = accountOf(first, buyer);
  const firstSeller = accountOf(first, seller);

  assert.equal(firstBuyer.completedDeals, 1);
  assert.deepEqual(firstBuyer.counterparties, [seller]);
  assert.equal(firstBuyer.lastActiveAtMs, T0 + DAY);

  assert.equal(firstSeller.completedDeals, 1);
  assert.deepEqual(firstSeller.counterparties, [buyer]);
  assert.equal(firstSeller.lastActiveAtMs, T0 + DAY);

  const second = unwrap(
    applyDealCompleted(first, 'deal-2', buyer, seller, T0 + 2 * DAY),
  );

  const secondBuyer = accountOf(second, buyer);
  const secondSeller = accountOf(second, seller);

  assert.equal(secondBuyer.completedDeals, 2);
  assert.deepEqual(secondBuyer.counterparties, [seller]);
  assert.equal(secondBuyer.lastActiveAtMs, T0 + DAY);

  assert.equal(secondSeller.completedDeals, 2);
  assert.deepEqual(secondSeller.counterparties, [buyer]);
  assert.equal(secondSeller.lastActiveAtMs, T0 + DAY);

  const beforeDuplicate = structuredClone(second);
  expectErr(
    applyDealCompleted(second, 'deal-1', buyer, seller, T0 + 3 * DAY),
    'DUPLICATE',
  );
  assert.deepEqual(snapshot(second), snapshot(beforeDuplicate));

  const onlyBuyer = unwrap(registerAccount(initialReputationState(), buyer, T0));
  expectErr(
    applyDealCompleted(onlyBuyer, 'deal-3', buyer, seller, T0),
    'STATE',
  );

  expectErr(
    applyDealCompleted(second, 'deal-4', buyer, buyer, T0),
    'FIELD_FORMAT',
  );
});

test('applyDisputeOutcome adjusts rawSum without completedDeals', () => {
  const winner = newIdentity().publicKey;
  const loser = newIdentity().publicKey;

  let state = initialReputationState();
  state = unwrap(registerAccount(state, winner, T0));
  state = unwrap(registerAccount(state, loser, T0));

  const before = structuredClone(state);
  const next = unwrap(applyDisputeOutcome(state, 'dispute-1', winner, loser));

  assert.deepEqual(snapshot(state), snapshot(before));

  assert.equal(accountOf(next, winner).rawSum, 1);
  assert.equal(accountOf(next, loser).rawSum, -1);
  assert.equal(accountOf(next, winner).completedDeals, 0);
  assert.equal(accountOf(next, loser).completedDeals, 0);
  assert.equal(accountOf(next, winner).lastActiveAtMs, null);
  assert.equal(accountOf(next, loser).lastActiveAtMs, null);

  const beforeDuplicate = structuredClone(next);
  expectErr(
    applyDisputeOutcome(next, 'dispute-1', winner, loser),
    'DUPLICATE',
  );
  assert.deepEqual(snapshot(next), snapshot(beforeDuplicate));
});

test('applyReputationEvent routes delta to counterparty and enforces rules', () => {
  const buyer = newIdentity().publicKey;
  const seller = newIdentity().publicKey;
  const outsider = newIdentity().publicKey;

  let state = initialReputationState();
  state = unwrap(registerAccount(state, buyer, T0));
  state = unwrap(registerAccount(state, seller, T0));
  state = unwrap(registerAccount(state, outsider, T0));

  const parties = { buyer, seller };

  const first = unwrap(
    applyReputationEvent(
      state,
      makePayload(buyer, seller, 'deal-e1', 1),
      parties,
      'completed',
    ),
  );

  assert.equal(accountOf(first, seller).rawSum, 1);
  assert.equal(accountOf(first, buyer).rawSum, 0);
  assert.deepEqual(first.rated, [`deal-e1:${buyer}`]);

  const second = unwrap(
    applyReputationEvent(
      first,
      makePayload(seller, buyer, 'deal-e1', -1),
      parties,
      'resolved',
    ),
  );

  assert.equal(accountOf(second, buyer).rawSum, -1);
  assert.equal(accountOf(second, seller).rawSum, 1);

  const third = unwrap(
    applyReputationEvent(
      second,
      makePayload(buyer, seller, 'deal-e2', 0),
      parties,
      'resolved_final',
    ),
  );

  assert.equal(accountOf(third, seller).rawSum, 1);

  expectErr(
    applyReputationEvent(
      third,
      makePayload(outsider, seller, 'deal-e3', 1),
      parties,
      'completed',
    ),
    'SIGNER_AUTHORITY',
  );

  expectErr(
    applyReputationEvent(
      third,
      makePayload(buyer, seller, 'deal-e3', 1),
      parties,
      'delivered',
    ),
    'STATE',
  );

  const beforeDuplicate = structuredClone(third);
  expectErr(
    applyReputationEvent(
      third,
      makePayload(buyer, seller, 'deal-e1', 0),
      parties,
      'completed',
    ),
    'DUPLICATE',
  );
  assert.deepEqual(snapshot(third), snapshot(beforeDuplicate));

  const opposite = unwrap(
    applyReputationEvent(
      third,
      makePayload(seller, buyer, 'deal-e2', 1),
      parties,
      'completed',
    ),
  );

  assert.equal(accountOf(opposite, buyer).rawSum, 0);

  for (const delta of [2, '1', 0.5, null]) {
    const payload = makePayload(
      buyer,
      seller,
      `deal-invalid-${String(delta)}`,
      delta,
    );

    expectErr(
      applyReputationEvent(opposite, payload, parties, 'completed'),
      'FIELD_FORMAT',
    );
  }
});

test('operations are atomic and never mutate input on error', () => {
  const buyer = newIdentity().publicKey;
  const seller = newIdentity().publicKey;

  let state = initialReputationState();
  state = unwrap(registerAccount(state, buyer, T0));
  state = unwrap(registerAccount(state, seller, T0));

  const beforeSuccess = structuredClone(state);
  const completed = unwrap(
    applyDealCompleted(state, 'atomic-deal', buyer, seller, T0 + DAY),
  );
  assert.deepEqual(snapshot(state), snapshot(beforeSuccess));

  const beforeError = structuredClone(completed);
  expectErr(
    applyDealCompleted(completed, 'atomic-deal', buyer, seller, T0 + DAY),
    'DUPLICATE',
  );
  assert.deepEqual(snapshot(completed), snapshot(beforeError));

  const beforeEventError = structuredClone(completed);
  expectErr(
    applyReputationEvent(
      completed,
      makePayload('missing', seller, 'atomic-event', 1),
      { buyer, seller },
      'completed',
    ),
    'SIGNER_AUTHORITY',
  );
  assert.deepEqual(snapshot(completed), snapshot(beforeEventError));
});

test('decayFactorPpm computes integer decay', () => {
  const halfLife = DAY;

  assert.equal(unwrap(decayFactorPpm(0, halfLife)), 1_000_000);
  assert.equal(unwrap(decayFactorPpm(halfLife, halfLife)), 500_000);
  assert.equal(unwrap(decayFactorPpm(2 * halfLife, halfLife)), 250_000);
  assert.equal(unwrap(decayFactorPpm(halfLife / 2, halfLife)), 750_000);

  let previous = 1_000_001;

  for (let index = 0; index <= 40; index += 1) {
    const idle = Math.floor((halfLife * index) / 40);
    const factor = unwrap(decayFactorPpm(idle, halfLife));

    assert.ok(factor <= previous);
    previous = factor;
  }

  assert.equal(unwrap(decayFactorPpm(20 * halfLife, halfLife)), 0);
  assert.equal(unwrap(decayFactorPpm(100 * halfLife, halfLife)), 0);

  expectErr(decayFactorPpm(-1, halfLife), 'FIELD_FORMAT');
  expectErr(decayFactorPpm(1.5, halfLife), 'FIELD_FORMAT');
  expectErr(decayFactorPpm(0, 0), 'FIELD_FORMAT');
  expectErr(decayFactorPpm(0, -1), 'FIELD_FORMAT');
  expectErr(decayFactorPpm(0, 1.5), 'FIELD_FORMAT');
});

test('effectiveSum applies decay only after active window', () => {
  const params: ReputationParams = {
    activeWindowMs: DAY,
    decayHalfLifeMs: DAY,
  };

  const active: AccountReputation = {
    createdAtMs: T0,
    completedDeals: 1,
    counterparties: ['cp'],
    rawSum: 11,
    lastActiveAtMs: T0,
  };

  assert.equal(unwrap(effectiveSum(active, T0 + DAY, params)), 11);
  assert.equal(unwrap(effectiveSum(active, T0 + DAY + DAY, params)), 5);

  const negative: AccountReputation = {
    createdAtMs: T0,
    completedDeals: 1,
    counterparties: ['cp'],
    rawSum: -11,
    lastActiveAtMs: T0,
  };

  assert.equal(unwrap(effectiveSum(negative, T0 + DAY + DAY, params)), -5);

  const noActive: AccountReputation = {
    createdAtMs: T0,
    completedDeals: 0,
    counterparties: [],
    rawSum: 20,
    lastActiveAtMs: null,
  };

  assert.equal(unwrap(effectiveSum(noActive, T0 + DAY + DAY, params)), 10);
});

test('rankOf combines distinct counterparties and positive effective sum', () => {
  const params: ReputationParams = {
    activeWindowMs: DAY,
    decayHalfLifeMs: DAY,
  };

  const account: AccountReputation = {
    createdAtMs: T0,
    completedDeals: 3,
    counterparties: ['a', 'b', 'c'],
    rawSum: 4,
    lastActiveAtMs: T0,
  };

  assert.equal(unwrap(rankOf(account, T0, params)), 7);

  const negative: AccountReputation = {
    createdAtMs: T0,
    completedDeals: 3,
    counterparties: ['a', 'b', 'c'],
    rawSum: -5,
    lastActiveAtMs: T0,
  };

  assert.equal(unwrap(rankOf(negative, T0, params)), 3);
});

test('toJuryCandidate uses rawSum without decay', () => {
  const params: ReputationParams = {
    activeWindowMs: DAY,
    decayHalfLifeMs: DAY,
  };

  const account: AccountReputation = {
    createdAtMs: T0,
    completedDeals: 3,
    counterparties: ['a', 'b', 'c'],
    rawSum: 10,
    lastActiveAtMs: T0,
  };

  const candidate = toJuryCandidate('pk', account);

  assert.equal(candidate.reputationSum, 10);
  assert.equal(candidate.distinctCounterparties, 3);
  assert.equal(unwrap(effectiveSum(account, T0 + 100 * DAY, params)), 0);
});

test('special pubkey strings are safe in null-prototype records', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();

  let state = initialReputationState();
  state = unwrap(registerAccount(state, '__proto__', T0));
  state = unwrap(registerAccount(state, 'constructor', T0));
  state = unwrap(registerAccount(state, 'toString', T0));

  assert.equal(Object.hasOwn(state.accounts, '__proto__'), true);

  const next = unwrap(
    applyDealCompleted(state, 'special-deal', '__proto__', 'constructor', T0),
  );

  assert.deepEqual(accountOf(next, '__proto__').counterparties, ['constructor']);
  assert.deepEqual(accountOf(next, 'constructor').counterparties, ['__proto__']);

  const after = Object.getOwnPropertyNames(Object.prototype).sort();
  assert.deepEqual(after, before);
});

test('canonicalizeReputationState normalizes insertion order', () => {
  const a = newIdentity().publicKey;
  const b = newIdentity().publicKey;
  const c = newIdentity().publicKey;

  function build(order: readonly string[]): ReputationState {
    let state = initialReputationState();

    for (const key of order) {
      state = unwrap(registerAccount(state, key, T0));
    }

    state = unwrap(applyDealCompleted(state, 'd1', a, b, T0 + DAY));
    state = unwrap(applyDisputeOutcome(state, 'd2', b, a));
    state = unwrap(
      applyReputationEvent(
        state,
        makePayload(a, b, 'e1', 1),
        { buyer: a, seller: b },
        'completed',
      ),
    );

    return state;
  }

  const first = build([a, b, c]);
  const second = build([c, b, a]);

  assert.equal(
    JSON.stringify(canonicalizeReputationState(first)),
    JSON.stringify(canonicalizeReputationState(second)),
  );
});

test('assertReputationInvariants rejects broken states', () => {
  const valid = validInvariantState();
  assert.equal(unwrap(assertReputationInvariants(valid)), true);

  const baseAccount: AccountReputation = {
    createdAtMs: T0,
    completedDeals: 1,
    counterparties: ['b'],
    rawSum: 0,
    lastActiveAtMs: null,
  };

  expectErr(
    assertReputationInvariants(
      stateWithAccount({
        createdAtMs: T0,
        completedDeals: 1,
        counterparties: ['b'],
        rawSum: Number.MAX_SAFE_INTEGER + 1,
        lastActiveAtMs: null,
      }),
    ),
    'STATE',
  );

  expectErr(
    assertReputationInvariants(
      stateWithAccount({
        createdAtMs: T0,
        completedDeals: -1,
        counterparties: [],
        rawSum: 0,
        lastActiveAtMs: null,
      }),
    ),
    'STATE',
  );

  expectErr(
    assertReputationInvariants(
      stateWithAccount({
        ...baseAccount,
        completedDeals: 2,
        counterparties: ['b', 'a'],
      }),
    ),
    'STATE',
  );

  expectErr(
    assertReputationInvariants(
      stateWithAccount({
        ...baseAccount,
        completedDeals: 2,
        counterparties: ['b', 'b'],
      }),
    ),
    'STATE',
  );

  expectErr(
    assertReputationInvariants(
      stateWithAccount({
        ...baseAccount,
        completedDeals: 0,
        counterparties: ['b'],
      }),
    ),
    'STATE',
  );

  expectErr(
    assertReputationInvariants(stateWithLists(['b', 'a'], [])),
    'STATE',
  );

  expectErr(
    assertReputationInvariants(stateWithLists([], ['b', 'a'])),
    'STATE',
  );
});

test('seeded random operations preserve invariants and rawSum total', () => {
  const rnd = createLcg(0x5eed1234);
  const pubkeys: string[] = [];

  for (let index = 0; index < 6; index += 1) {
    pubkeys.push(newIdentity().publicKey);
  }

  let state = initialReputationState();

  for (const pubkey of pubkeys) {
    state = unwrap(registerAccount(state, pubkey, T0));
  }

  let appliedDeltaSum = 0;

  for (let index = 0; index < 500; index += 1) {
    const operation = rnd() % 3;

    if (operation === 0) {
      const parties = pickTwo(pubkeys, rnd);
      state = unwrap(
        applyDealCompleted(
          state,
          `deal-${index}`,
          parties.a,
          parties.b,
          T0 + index * DAY,
        ),
      );
    } else if (operation === 1) {
      const parties = pickTwo(pubkeys, rnd);
      state = unwrap(
        applyDisputeOutcome(state, `dispute-${index}`, parties.a, parties.b),
      );
    } else {
      const parties = pickTwo(pubkeys, rnd);
      const delta = (rnd() % 3) - 1;
      const account = rnd() % 2 === 0 ? parties.a : parties.b;
      const counterparty = account === parties.a ? parties.b : parties.a;
      const statuses = ['completed', 'resolved', 'resolved_final'] as const;
      const status = statuses[rnd() % statuses.length];

      if (status === undefined) {
        throw new Error('missing status');
      }

      state = unwrap(
        applyReputationEvent(
          state,
          makePayload(account, counterparty, `event-${index}`, delta),
          { buyer: parties.a, seller: parties.b },
          status,
        ),
      );

      appliedDeltaSum += delta;
    }

    assert.equal(unwrap(assertReputationInvariants(state)), true);
    assert.equal(totalRawSum(state), appliedDeltaSum);
  }
});