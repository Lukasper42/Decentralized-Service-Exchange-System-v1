// packages/domain/src/jury-draws.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertJuryDrawInvariants,
  canonicalizeJuryDraws,
  closeDraws,
  drawKey,
  initialJuryDraws,
  juryContextSource,
  openDraw,
  recordBeacon,
} from './jury-draws.js';
import type { JuryDraw, JuryDraws, OpenDrawInput } from './jury-draws.js';
import { createJuryOracle, eligiblePool } from './jury.js';
import type { JuryCandidate, JuryRules } from './jury.js';
import type { PolicyTier } from './policy.js';
import type { Pubkey, Result } from './protocol.js';
import { h, T0, DAY } from '../../testing/src/fixtures.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error('Expected ok result');
  }
  return result.value;
}

function expectError<T>(result: Result<T>): void {
  assert.equal(result.ok, false);
}

interface CandidateOverrides {
  readonly createdAtMs?: number;
  readonly completedDeals?: number;
  readonly distinctCounterparties?: number;
  readonly reputationSum?: number;
}

function candidate(
  name: string,
  overrides: CandidateOverrides = {},
): JuryCandidate {
  const createdAtMs =
    overrides.createdAtMs === undefined ? T0 - 100 * DAY : overrides.createdAtMs;
  const completedDeals =
    overrides.completedDeals === undefined ? 25 : overrides.completedDeals;
  const distinctCounterparties =
    overrides.distinctCounterparties === undefined
      ? 8
      : overrides.distinctCounterparties;
  const reputationSum =
    overrides.reputationSum === undefined ? 5 : overrides.reputationSum;

  return {
    pubkey: name,
    createdAtMs,
    completedDeals,
    distinctCounterparties,
    reputationSum,
  };
}

interface TierConfig {
  readonly minDeals: number;
  readonly minCounterparties: number;
  readonly minAccountAgeDays: number;
  readonly requirePositiveBalance: boolean;
}

function makeTier(config: TierConfig): PolicyTier {
  return { ...config };
}

function makeRules(
  tiers: readonly PolicyTier[],
  minPoolSizeRound0 = 3,
  minPoolSizeRound1 = 5,
): JuryRules {
  return { tiers, minPoolSizeRound0, minPoolSizeRound1 };
}

interface InputOverrides {
  readonly triggerSequence?: number;
  readonly triggerAcceptedAtMs?: number;
  readonly candidates?: readonly JuryCandidate[];
  readonly excluded?: readonly Pubkey[];
  readonly rules?: JuryRules;
}

function makeInput(overrides: InputOverrides = {}): OpenDrawInput {
  const tier0 = makeTier({ minDeals: 20, minCounterparties: 5, minAccountAgeDays: 50, requirePositiveBalance: true });
  const tier1 = makeTier({ minDeals: 10, minCounterparties: 3, minAccountAgeDays: 10, requirePositiveBalance: false });

  return {
    triggerSequence:
      overrides.triggerSequence === undefined ? 5 : overrides.triggerSequence,
    triggerAcceptedAtMs:
      overrides.triggerAcceptedAtMs === undefined
        ? T0
        : overrides.triggerAcceptedAtMs,
    candidates:
      overrides.candidates === undefined
        ? [candidate('p01'), candidate('p02'), candidate('p03')]
        : overrides.candidates,
    excluded: overrides.excluded === undefined ? [] : overrides.excluded,
    rules:
      overrides.rules === undefined
        ? makeRules([tier0, tier1], 3, 5)
        : overrides.rules,
  };
}

function openValidDraw(
  dealId = 'deal',
  round: 0 | 1 = 0,
  input: OpenDrawInput = makeInput(),
): JuryDraws {
  return unwrap(openDraw(initialJuryDraws(), dealId, round, input));
}

function drawAt(draws: JuryDraws, key: string): JuryDraw {
  if (!Object.hasOwn(draws, key)) {
    throw new Error(`Missing draw ${key}`);
  }
  const draw = draws[key];
  if (draw === undefined) {
    throw new Error(`Missing draw ${key}`);
  }
  return draw;
}

function setDraw(draws: JuryDraws, key: string, draw: JuryDraw): JuryDraws {
  const next: Record<string, JuryDraw> = Object.create(null);
  for (const existingKey of Object.keys(draws)) {
    if (Object.hasOwn(draws, existingKey)) {
      const existing = draws[existingKey];
      if (existing !== undefined) {
        next[existingKey] = existing;
      }
    }
  }
  next[key] = draw;
  return next;
}

test('openDraw freezes, sorts, deduplicates, and filters candidates', () => {
  const tier0 = makeTier({ minDeals: 20, minCounterparties: 5, minAccountAgeDays: 50, requirePositiveBalance: true });
  const tier1 = makeTier({ minDeals: 10, minCounterparties: 3, minAccountAgeDays: 10, requirePositiveBalance: false });

  const input: OpenDrawInput = {
    triggerSequence: 5,
    triggerAcceptedAtMs: T0,
    candidates: [
      candidate('p07'),
      candidate('p02', { reputationSum: 0 }),
      candidate('p01'),
      candidate('p03', { completedDeals: 5 }),
      candidate('p04', { createdAtMs: T0 - 5 * DAY }),
      candidate('p05', { distinctCounterparties: 2 }),
      candidate('p06', {
        completedDeals: 15,
        distinctCounterparties: 3,
        createdAtMs: T0 - 20 * DAY,
        reputationSum: 0,
      }),
    ],
    excluded: ['p06', 'p01', 'p06'],
    rules: makeRules([tier0, tier1], 1, 1),
  };

  const before = structuredClone(input);
  const draws = unwrap(openDraw(initialJuryDraws(), 'deal', 0, input));
  assert.deepEqual(input, before);

  const draw = drawAt(draws, drawKey('deal', 0));
  assert.deepEqual(
    draw.candidates.map((item) => item.pubkey),
    ['p02', 'p07'],
  );
  assert.deepEqual(draw.excluded, ['p01', 'p06']);
  assert.equal(draw.triggerSequence, 5);
  assert.equal(draw.triggerAcceptedAtMs, T0);
  assert.equal(draw.beaconReceiptHash, null);
  assert.notStrictEqual(draw.rules, input.rules);
  assert.notStrictEqual(draw.rules.tiers, input.rules.tiers);
});

test('frozen candidates produce the same eligible pools for every tier', () => {
  const tier0 = makeTier({ minDeals: 20, minCounterparties: 5, minAccountAgeDays: 50, requirePositiveBalance: true });
  const tier1 = makeTier({ minDeals: 10, minCounterparties: 3, minAccountAgeDays: 10, requirePositiveBalance: false });

  const input: OpenDrawInput = {
    triggerSequence: 5,
    triggerAcceptedAtMs: T0,
    candidates: [
      candidate('p07'),
      candidate('p02', { reputationSum: 0 }),
      candidate('p01'),
      candidate('p03', { completedDeals: 5 }),
      candidate('p04', { createdAtMs: T0 - 5 * DAY }),
      candidate('p05', { distinctCounterparties: 2 }),
      candidate('p06', {
        completedDeals: 15,
        distinctCounterparties: 3,
        createdAtMs: T0 - 20 * DAY,
        reputationSum: 0,
      }),
    ],
    excluded: ['p06', 'p01', 'p06'],
    rules: makeRules([tier0, tier1], 1, 1),
  };

  const draws = unwrap(openDraw(initialJuryDraws(), 'deal', 0, input));
  const draw = drawAt(draws, drawKey('deal', 0));

  for (const tier of input.rules.tiers) {
    const full = unwrap(
      eligiblePool(
        input.candidates,
        tier,
        input.excluded,
        input.triggerAcceptedAtMs,
      ),
    );
    const frozen = unwrap(
      eligiblePool(
        draw.candidates,
        tier,
        draw.excluded,
        draw.triggerAcceptedAtMs,
      ),
    );
    assert.deepEqual(frozen, full);
  }
});

test('openDraw rejects invalid input without mutation', () => {
  const invalidInputs: readonly OpenDrawInput[] = [
    { ...makeInput(), triggerSequence: 0 },
    { ...makeInput(), triggerSequence: 1.5 },
    { ...makeInput(), triggerAcceptedAtMs: -1 },
    { ...makeInput(), triggerAcceptedAtMs: 1.5 },
    {
      ...makeInput(),
      candidates: [candidate(''), ...makeInput().candidates],
    },
    {
      ...makeInput(),
      candidates: [candidate('p01'), candidate('p01')],
    },
    { ...makeInput(), excluded: [''] },
    {
      ...makeInput(),
      rules: { ...makeInput().rules, minPoolSizeRound0: -1 },
    },
    {
      ...makeInput(),
      rules: { ...makeInput().rules, minPoolSizeRound1: 1.5 },
    },
    {
      ...makeInput(),
      rules: { ...makeInput().rules, tiers: [] },
    },
  ];

  for (const input of invalidInputs) {
    const before = structuredClone(input);
    expectError(openDraw(initialJuryDraws(), 'deal', 0, input));
    assert.deepEqual(input, before);
  }

  const emptyDealInput = makeInput();
  const emptyDealBefore = structuredClone(emptyDealInput);
  expectError(openDraw(initialJuryDraws(), '', 0, emptyDealInput));
  assert.deepEqual(emptyDealInput, emptyDealBefore);

  const draws = openValidDraw('dup', 0);
  const drawsBefore = canonicalizeJuryDraws(draws);
  const duplicateInput = makeInput();
  const duplicateBefore = structuredClone(duplicateInput);
  expectError(openDraw(draws, 'dup', 0, duplicateInput));
  assert.deepEqual(duplicateInput, duplicateBefore);
  assert.deepEqual(canonicalizeJuryDraws(draws), drawsBefore);
});

test('recordBeacon waits, sets once, and validates the beacon window', () => {
  let draws = openValidDraw('deal', 0, makeInput({ triggerSequence: 5 }));
  const before = draws;
  const early = unwrap(recordBeacon(draws, 15, h('early')));
  assert.equal(early, before);
  assert.equal(drawAt(early, drawKey('deal', 0)).beaconReceiptHash, null);

  const beacon = h('beacon');
  draws = unwrap(recordBeacon(early, 16, beacon));
  assert.equal(drawAt(draws, drawKey('deal', 0)).beaconReceiptHash, beacon);

  const later = unwrap(recordBeacon(draws, 17, h('later')));
  assert.equal(later, draws);
  assert.equal(drawAt(later, drawKey('deal', 0)).beaconReceiptHash, beacon);

  expectError(
    recordBeacon(
      openValidDraw('null', 0, makeInput({ triggerSequence: 5 })),
      16,
      null,
    ),
  );

  expectError(
    recordBeacon(
      openValidDraw('missed', 0, makeInput({ triggerSequence: 5 })),
      17,
      h('late'),
    ),
  );
});

test('recordBeacon fills independent deal rounds separately', () => {
  let draws = initialJuryDraws();
  draws = unwrap(openDraw(draws, 'a', 0, makeInput({ triggerSequence: 5 })));
  draws = unwrap(openDraw(draws, 'a', 1, makeInput({ triggerSequence: 7 })));
  draws = unwrap(openDraw(draws, 'b', 0, makeInput({ triggerSequence: 6 })));

  const hashA0 = h('a0');
  const hashB0 = h('b0');
  const hashA1 = h('a1');

  draws = unwrap(recordBeacon(draws, 16, hashA0));
  assert.equal(drawAt(draws, drawKey('a', 0)).beaconReceiptHash, hashA0);
  assert.equal(drawAt(draws, drawKey('a', 1)).beaconReceiptHash, null);
  assert.equal(drawAt(draws, drawKey('b', 0)).beaconReceiptHash, null);

  draws = unwrap(recordBeacon(draws, 17, hashB0));
  assert.equal(drawAt(draws, drawKey('a', 0)).beaconReceiptHash, hashA0);
  assert.equal(drawAt(draws, drawKey('a', 1)).beaconReceiptHash, null);
  assert.equal(drawAt(draws, drawKey('b', 0)).beaconReceiptHash, hashB0);

  draws = unwrap(recordBeacon(draws, 18, hashA1));
  assert.equal(drawAt(draws, drawKey('a', 0)).beaconReceiptHash, hashA0);
  assert.equal(drawAt(draws, drawKey('a', 1)).beaconReceiptHash, hashA1);
  assert.equal(drawAt(draws, drawKey('b', 0)).beaconReceiptHash, hashB0);
});

test('closeDraws removes both rounds and ignores unknown deals', () => {
  let draws = initialJuryDraws();
  draws = unwrap(openDraw(draws, 'deal', 0, makeInput()));
  draws = unwrap(openDraw(draws, 'deal', 1, makeInput()));
  draws = unwrap(openDraw(draws, 'other', 0, makeInput()));

  const other = drawAt(draws, drawKey('other', 0));
  const closed = closeDraws(draws, 'deal');
  assert.equal(Object.hasOwn(closed, drawKey('deal', 0)), false);
  assert.equal(Object.hasOwn(closed, drawKey('deal', 1)), false);
  assert.deepEqual(drawAt(closed, drawKey('other', 0)), other);

  const unknown = closeDraws(closed, 'missing');
  assert.equal(unknown, closed);
});

test('jury oracle integrates with draw snapshots', () => {
  const tier0 = makeTier({ minDeals: 20, minCounterparties: 5, minAccountAgeDays: 50, requirePositiveBalance: true });
  const tier1 = makeTier({ minDeals: 10, minCounterparties: 3, minAccountAgeDays: 10, requirePositiveBalance: false });

  const candidates = Array.from({ length: 25 }, (_, index) =>
    candidate(`p${String(index + 1).padStart(2, '0')}`),
  );

  const input: OpenDrawInput = {
    triggerSequence: 1,
    triggerAcceptedAtMs: T0,
    candidates,
    excluded: ['p25'],
    rules: makeRules([tier0, tier1], 3, 5),
  };

  let draws = unwrap(openDraw(initialJuryDraws(), 'deal', 0, input));
  draws = unwrap(openDraw(draws, 'deal', 1, input));
  let seated: readonly Pubkey[] = [];

  let oracle = createJuryOracle(juryContextSource(draws, () => seated));
  expectError(oracle.expectedJurors('deal', 0));

  const beacon = h('beacon');
  draws = unwrap(recordBeacon(draws, 12, beacon));

  oracle = createJuryOracle(juryContextSource(draws, () => seated));
  const jurors0 = unwrap(oracle.expectedJurors('deal', 0));
  assert.equal(jurors0.length, 3);
  assert.equal(new Set(jurors0).size, 3);
  assert.equal(jurors0.includes('p25'), false);

  const jurors1 = unwrap(oracle.expectedJurors('deal', 1));
  assert.equal(jurors1.length, 5);
  assert.equal(new Set(jurors1).size, 5);
  assert.equal(jurors1.includes('p25'), false);

  const jurorsAgain = unwrap(oracle.expectedJurors('deal', 0));
  assert.deepEqual(jurorsAgain, jurors0);

  seated = jurors0;
  oracle = createJuryOracle(juryContextSource(draws, () => seated));
  const missing = jurors0[0];
  if (missing === undefined) {
    throw new Error('Expected at least one seated juror');
  }
  const replacement1 = unwrap(
    oracle.expectedReplacement('deal', 0, missing),
  );
  const replacement2 = unwrap(
    oracle.expectedReplacement('deal', 0, missing),
  );
  assert.equal(replacement1, replacement2);
  assert.equal(jurors0.includes(replacement1), false);

  const emptyOracle = createJuryOracle(
    juryContextSource(initialJuryDraws(), () => []),
  );
  expectError(emptyOracle.expectedJurors('missing', 0));
});

test('jury oracle falls back to the second tier when the first pool is too small', () => {
  const tier0 = makeTier({ minDeals: 20, minCounterparties: 5, minAccountAgeDays: 50, requirePositiveBalance: true });
  const tier1 = makeTier({ minDeals: 10, minCounterparties: 3, minAccountAgeDays: 10, requirePositiveBalance: false });

  const candidates = [
    candidate('p01'),
    candidate('p02'),
    candidate('p03', {
      completedDeals: 15,
      distinctCounterparties: 4,
      createdAtMs: T0 - 20 * DAY,
      reputationSum: 0,
    }),
    candidate('p04', {
      completedDeals: 15,
      distinctCounterparties: 4,
      createdAtMs: T0 - 20 * DAY,
      reputationSum: 0,
    }),
    candidate('p05', {
      completedDeals: 15,
      distinctCounterparties: 4,
      createdAtMs: T0 - 20 * DAY,
      reputationSum: 0,
    }),
  ];

  const input: OpenDrawInput = {
    triggerSequence: 2,
    triggerAcceptedAtMs: T0,
    candidates,
    excluded: [],
    rules: makeRules([tier0, tier1], 3, 5),
  };

  let draws = unwrap(openDraw(initialJuryDraws(), 'deal', 0, input));
  draws = unwrap(recordBeacon(draws, 13, h('beacon')));

  const oracle = createJuryOracle(juryContextSource(draws, () => []));
  const jurors = unwrap(oracle.expectedJurors('deal', 0));
  assert.equal(jurors.length, 3);

  const draw = drawAt(draws, drawKey('deal', 0));
  const tier1Pool = unwrap(
    eligiblePool(
      draw.candidates,
      tier1,
      draw.excluded,
      draw.triggerAcceptedAtMs,
    ),
  );
  for (const juror of jurors) {
    assert.equal(tier1Pool.includes(juror), true);
  }

  const extended = ['p03', 'p04', 'p05'];
  assert.equal(jurors.some((juror) => extended.includes(juror)), true);
});

test('canonicalizeJuryDraws normalizes key order', () => {
  const inputA = makeInput({ triggerSequence: 5 });
  const inputB = makeInput({ triggerSequence: 6 });

  let draws1 = initialJuryDraws();
  draws1 = unwrap(openDraw(draws1, 'b', 0, inputB));
  draws1 = unwrap(openDraw(draws1, 'a', 0, inputA));

  let draws2 = initialJuryDraws();
  draws2 = unwrap(openDraw(draws2, 'a', 0, inputA));
  draws2 = unwrap(openDraw(draws2, 'b', 0, inputB));

  assert.equal(
    JSON.stringify(canonicalizeJuryDraws(draws1)),
    JSON.stringify(canonicalizeJuryDraws(draws2)),
  );
});

test('assertJuryDrawInvariants accepts valid state and rejects each violation', () => {
  const draws = openValidDraw('deal', 0, makeInput({ triggerSequence: 5 }));
  const valid = assertJuryDrawInvariants(draws);
  assert.equal(valid.ok, true);

  const key = drawKey('deal', 0);
  const draw = drawAt(draws, key);

  expectError(
    assertJuryDrawInvariants(
      setDraw(draws, key, { ...draw, triggerSequence: 1.5 }),
    ),
  );

  expectError(
    assertJuryDrawInvariants(
      setDraw(draws, key, { ...draw, triggerAcceptedAtMs: -1.5 }),
    ),
  );

  expectError(assertJuryDrawInvariants(setDraw(draws, 'bad', draw)));

  expectError(
    assertJuryDrawInvariants(
      setDraw(draws, key, {
        ...draw,
        candidates: [candidate('p02'), candidate('p01')],
      }),
    ),
  );

  expectError(
    assertJuryDrawInvariants(
      setDraw(draws, key, { ...draw, excluded: ['p02', 'p01'] }),
    ),
  );

  expectError(
    assertJuryDrawInvariants(
      setDraw(draws, key, {
        ...draw,
        candidates: [candidate('p01')],
        excluded: ['p01'],
      }),
    ),
  );

  expectError(
    assertJuryDrawInvariants(
      setDraw(draws, key, { ...draw, beaconReceiptHash: 'x' }),
    ),
  );
});

test('null-prototype records handle special deal ids without pollution', () => {
  const specialDealIds = ['__proto__', 'constructor'];
  let draws = initialJuryDraws();

  for (const dealId of specialDealIds) {
    draws = unwrap(openDraw(draws, dealId, 0, makeInput()));
  }

  assert.equal(Object.getPrototypeOf(draws), null);

  for (const dealId of specialDealIds) {
    assert.equal(Object.hasOwn(draws, drawKey(dealId, 0)), true);
    const source = juryContextSource(draws, () => []);
    const context = unwrap(source.contextFor(dealId, 0));
    assert.equal(context.triggerAcceptedAtMs, T0);
  }

  assert.equal(Object.hasOwn(Object.prototype, drawKey('__proto__', 0)), false);
});