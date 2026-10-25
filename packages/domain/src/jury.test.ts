import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { sha256Hex } from '../../crypto/src/index.js';
import type { PolicyTier } from './policy.js';
import type { JuryOracle } from './ports.js';
import {
  err,
  ok,
  type Hash,
  type Pubkey,
  type Result,
} from './protocol.js';
import {
  createJuryOracle,
  drawSequence,
  eligiblePool,
  selectJurors,
  selectPool,
  selectReplacement,
  type JuryCandidate,
  type JuryContext,
  type JuryContextSource,
  type JuryRules,
} from './jury.js';

const DAY_MS = 86_400_000;

function candidate(
  pubkey: string,
  overrides: Partial<Omit<JuryCandidate, 'pubkey'>> = {},
): JuryCandidate {
  return {
    pubkey,
    createdAtMs: 0,
    completedDeals: 0,
    distinctCounterparties: 0,
    reputationSum: 0,
    ...overrides,
  };
}

function makeTier(overrides: Partial<PolicyTier> = {}): PolicyTier {
  return {
    minDeals: 0,
    minCounterparties: 0,
    minAccountAgeDays: 0,
    requirePositiveBalance: false,
    ...overrides,
  };
}

function makeRules(
  tiers: readonly PolicyTier[],
  minPoolSizeRound0 = 0,
  minPoolSizeRound1 = 0,
): JuryRules {
  return { tiers, minPoolSizeRound0, minPoolSizeRound1 };
}

function makeContext(overrides: Partial<JuryContext> = {}): JuryContext {
  return {
    candidates: [],
    excluded: [],
    triggerAcceptedAtMs: 100 * DAY_MS,
    beaconReceiptHash: sha256Hex('beacon-default'),
    rules: makeRules([makeTier()]),
    seatedJurors: [],
    ...overrides,
  };
}

function candidatesFor(count: number): JuryCandidate[] {
  return Array.from({ length: count }, (_, index) =>
    candidate(`a${String(index + 1).padStart(2, '0')}`),
  );
}

function compareUtf8Test(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function referenceDraw(
  pool: readonly string[],
  seedHex: string,
  count: number,
): string[] {
  const remaining = [...pool].sort(compareUtf8Test);
  const seedBytes = Buffer.from(seedHex, 'hex');
  const chosen: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i, 0);

    const hashHex = createHash('sha256')
      .update(Buffer.concat([seedBytes, counter]))
      .digest('hex');
    const index = Number(BigInt(`0x${hashHex}`) % BigInt(remaining.length));
    const removed = remaining.splice(index, 1)[0];
    if (removed === undefined) {
      assert.fail('referenceDraw exhausted pool');
    }
    chosen.push(removed);
  }

  return chosen;
}

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    assert.fail(`expected ok, got ${result.error.code} ${result.error.path ?? ''}`);
  }
  return result.value;
}

function expectErr<T>(
  result: Result<T>,
  code: string,
  path?: string,
): void {
  if (result.ok) {
    assert.fail('expected error');
  }
  assert.equal(result.error.code, code);
  if (path !== undefined) {
    assert.equal(result.error.path, path);
  }
}

test('drawSequence matches independent reference implementation', () => {
  for (let poolSize = 5; poolSize <= 30; poolSize += 1) {
    const pool = Array.from({ length: poolSize }, (_, index) =>
      `a${String(index + 1).padStart(2, '0')}`,
    );

    for (let seedIndex = 0; seedIndex < 50; seedIndex += 1) {
      const seed = sha256Hex(`ref-seed-${poolSize}-${seedIndex}`);
      const actual = expectOk(drawSequence(pool, seed, poolSize));
      const expected = referenceDraw(pool, seed, poolSize);
      assert.deepEqual(actual, expected);
    }
  }
});

test('drawSequence produces unique jurors and full permutations', () => {
  const pool = candidatesFor(10).map((entry) => entry.pubkey);
  const seed = sha256Hex('unique-seed');

  const small = expectOk(drawSequence(pool, seed, 3));
  assert.equal(new Set(small).size, 3);

  const permutation = expectOk(drawSequence(pool, seed, pool.length));
  assert.equal(new Set(permutation).size, pool.length);
  assert.deepEqual(
    [...permutation].sort(compareUtf8Test),
    [...pool].sort(compareUtf8Test),
  );
});

test('eligiblePool sorts bytewise by UTF-8 pubkey bytes', () => {
  const context = makeContext({
    candidates: ['B1', 'a1', 'A1', '_1', '+1'].map((pubkey) =>
      candidate(pubkey),
    ),
  });

  const selected = expectOk(selectPool(context, 0));
  assert.deepEqual(selected.pool, ['+1', 'A1', 'B1', '_1', 'a1']);
});

test('eligiblePool enforces minDeals boundary', () => {
  const tier = makeTier({ minDeals: 2 });
  const pool = expectOk(
    eligiblePool(
      [
        candidate('a01', { completedDeals: 2 }),
        candidate('a02', { completedDeals: 1 }),
      ],
      tier,
      [],
      100 * DAY_MS,
    ),
  );
  assert.deepEqual(pool, ['a01']);
});

test('eligiblePool enforces minCounterparties boundary', () => {
  const tier = makeTier({ minCounterparties: 2 });
  const pool = expectOk(
    eligiblePool(
      [
        candidate('a01', { distinctCounterparties: 2 }),
        candidate('a02', { distinctCounterparties: 1 }),
      ],
      tier,
      [],
      100 * DAY_MS,
    ),
  );
  assert.deepEqual(pool, ['a01']);
});

test('eligiblePool handles requirePositiveBalance for zero reputation', () => {
  const positiveTier = makeTier({ requirePositiveBalance: true });
  const nonPositiveTier = makeTier({ requirePositiveBalance: false });
  const entries = [candidate('a01', { reputationSum: 0 })];

  assert.deepEqual(
    expectOk(eligiblePool(entries, positiveTier, [], 100 * DAY_MS)),
    [],
  );
  assert.deepEqual(
    expectOk(eligiblePool(entries, nonPositiveTier, [], 100 * DAY_MS)),
    ['a01'],
  );
});

test('eligiblePool enforces account age boundary inclusively', () => {
  const tier = makeTier({ minAccountAgeDays: 10 });
  const trigger = 10 * DAY_MS;

  const exactlyOld = candidate('a01', { createdAtMs: 0 });
  const oneMsTooYoung = candidate('a02', { createdAtMs: 1 });

  assert.deepEqual(
    expectOk(eligiblePool([exactlyOld, oneMsTooYoung], tier, [], trigger)),
    ['a01'],
  );
});

test('excluded parties and round 0 jurors are never in round 1 pool', () => {
  const context = makeContext({
    candidates: ['p1', 'p2', 'j0', 'a01', 'a02', 'a03', 'a04', 'a05'].map(
      (pubkey) => candidate(pubkey),
    ),
    excluded: ['p1', 'p2', 'j0'],
  });

  const selected = expectOk(selectPool(context, 1));
  assert.ok(!selected.pool.includes('p1'));
  assert.ok(!selected.pool.includes('p2'));
  assert.ok(!selected.pool.includes('j0'));
  assert.deepEqual(selected.pool, ['a01', 'a02', 'a03', 'a04', 'a05']);
});

test('fallback tiers choose first tier with large enough pool', () => {
  const context = makeContext({
    candidates: candidatesFor(5),
    rules: makeRules(
      [makeTier({ minDeals: 1 }), makeTier({ minDeals: 0 })],
      3,
      5,
    ),
  });

  const selected = expectOk(selectPool(context, 0));
  assert.equal(selected.tierIndex, 1);
});

test('fallback tiers fail closed when no tier has large enough pool', () => {
  const context = makeContext({
    candidates: candidatesFor(2),
    rules: makeRules([makeTier()], 3, 3),
  });

  expectErr(selectPool(context, 0), 'POLICY', 'policy.jury.tiers');
});

test('sufficient tier 0 remains selected', () => {
  const context = makeContext({
    candidates: candidatesFor(5),
    rules: makeRules([makeTier(), makeTier({ minDeals: 10 })], 3, 5),
  });

  const selected = expectOk(selectPool(context, 0));
  assert.equal(selected.tierIndex, 0);
});

test('selectJurors returns WINDOW when beacon receipt is missing', () => {
  const context = makeContext({
    candidates: candidatesFor(5),
    beaconReceiptHash: null,
  });

  expectErr(selectJurors(context, 0), 'WINDOW', 'beaconReceiptHash');
});

test('selectJurors rejects malformed beacon hashes', () => {
  const badLength: Hash = 'abcd';
  const badUpper: Hash = sha256Hex('x').toUpperCase();

  expectErr(
    selectJurors(
      makeContext({ candidates: candidatesFor(5), beaconReceiptHash: badLength }),
      0,
    ),
    'FIELD_FORMAT',
    'seedHex',
  );

  expectErr(
    selectJurors(
      makeContext({ candidates: candidatesFor(5), beaconReceiptHash: badUpper }),
      0,
    ),
    'FIELD_FORMAT',
    'seedHex',
  );
});

test('selectJurors selects 3 jurors in round 0 and 5 in round 1', () => {
  const context = makeContext({ candidates: candidatesFor(10) });

  const round0 = expectOk(selectJurors(context, 0));
  const round1 = expectOk(selectJurors(context, 1));

  assert.equal(round0.jurors.length, 3);
  assert.equal(round1.jurors.length, 5);
});

test('selectReplacement follows continued random stream', () => {
  const seed = sha256Hex('replacement-seed');
  const context = makeContext({
    candidates: candidatesFor(10),
    beaconReceiptHash: seed,
  });

  const pool = expectOk(selectPool(context, 0)).pool;
  const sequence = expectOk(drawSequence(pool, seed, 10));
  const initial = expectOk(selectJurors(context, 0)).jurors;

  const missing0 = initial[0];
  if (missing0 === undefined) {
    assert.fail('missing initial juror 0');
  }

  const first = expectOk(
    selectReplacement({ ...context, seatedJurors: initial }, 0, missing0),
  );
  assert.equal(first, sequence[3]);
  assert.ok(![first].includes(missing0));

  const seated2 = [...initial, first];
  const missing1 = initial[1];
  if (missing1 === undefined) {
    assert.fail('missing initial juror 1');
  }

  const second = expectOk(
    selectReplacement({ ...context, seatedJurors: seated2 }, 0, missing1),
  );
  assert.equal(second, sequence[4]);
  assert.ok(![first, second].includes(missing0));
});

test('selectReplacement rejects wrong seated prefix', () => {
  const seed = sha256Hex('wrong-prefix-seed');
  const context = makeContext({
    candidates: candidatesFor(10),
    beaconReceiptHash: seed,
  });

  const initial = expectOk(selectJurors(context, 0)).jurors;
  const badSeated: Pubkey[] = ['zzz', ...initial.slice(1)];

  expectErr(
    selectReplacement({ ...context, seatedJurors: badSeated }, 0, 'zzz'),
    'JURY_MISMATCH',
    'seatedJurors[0]',
  );
});

test('selectReplacement rejects unknown missing juror', () => {
  const context = makeContext({
    candidates: candidatesFor(10),
    beaconReceiptHash: sha256Hex('unknown-missing-seed'),
  });

  const initial = expectOk(selectJurors(context, 0)).jurors;
  expectErr(
    selectReplacement({ ...context, seatedJurors: initial }, 0, 'zzz'),
    'JURY_MISMATCH',
    'missingJuror',
  );
});

test('selectReplacement returns POLICY when pool is exhausted', () => {
  const context = makeContext({
    candidates: candidatesFor(3),
    beaconReceiptHash: sha256Hex('exhausted-seed'),
  });

  const initial = expectOk(selectJurors(context, 0)).jurors;
  const missing = initial[0];
  if (missing === undefined) {
    assert.fail('missing initial juror');
  }

  expectErr(
    selectReplacement({ ...context, seatedJurors: initial }, 0, missing),
    'POLICY',
    'policy.jury.replacement',
  );
});

test('selection is deterministic and candidate order independent', () => {
  const context = makeContext({ candidates: candidatesFor(10) });
  const reversed = makeContext({
    candidates: [...context.candidates].reverse(),
  });

  assert.deepEqual(
    expectOk(selectJurors(context, 0)),
    expectOk(selectJurors(context, 0)),
  );
  assert.deepEqual(
    expectOk(selectJurors(context, 0)),
    expectOk(selectJurors(reversed, 0)),
  );
});

test('invalid candidate numbers produce FIELD_FORMAT with path', () => {
  const tier = makeTier();

  expectErr(
    eligiblePool(
      [candidate('a01', { completedDeals: -1 })],
      tier,
      [],
      100 * DAY_MS,
    ),
    'FIELD_FORMAT',
    'candidates[0].completedDeals',
  );

  expectErr(
    eligiblePool(
      [candidate('a01', { distinctCounterparties: 1.5 })],
      tier,
      [],
      100 * DAY_MS,
    ),
    'FIELD_FORMAT',
    'candidates[0].distinctCounterparties',
  );

  expectErr(
    eligiblePool(
      [candidate('a01', { createdAtMs: Number.NaN })],
      tier,
      [],
      100 * DAY_MS,
    ),
    'FIELD_FORMAT',
    'candidates[0].createdAtMs',
  );
});

test('duplicate candidate pubkeys produce DUPLICATE', () => {
  expectErr(
    eligiblePool(
      [candidate('a01'), candidate('a01')],
      makeTier(),
      [],
      100 * DAY_MS,
    ),
    'DUPLICATE',
    'candidates[1].pubkey',
  );
});

test('empty candidate and excluded pubkeys produce FIELD_FORMAT', () => {
  expectErr(
    eligiblePool([candidate('')], makeTier(), [], 100 * DAY_MS),
    'FIELD_FORMAT',
    'candidates[0].pubkey',
  );
  expectErr(
    eligiblePool([candidate('a01')], makeTier(), [''], 100 * DAY_MS),
    'FIELD_FORMAT',
    'excluded[0]',
  );
});

test('createJuryOracle satisfies port and passes source errors through', () => {
  const context = makeContext({ candidates: candidatesFor(10) });
  const source: JuryContextSource = {
    contextFor: () => ok(context),
  };

  const oracle: JuryOracle = createJuryOracle(source);
  const selected = expectOk(selectJurors(context, 0));
  assert.deepEqual(expectOk(oracle.expectedJurors('deal-1', 0)), selected.jurors);

  const errorSource: JuryContextSource = {
    contextFor: () => err('WINDOW', 'Beacon not available', 'beacon'),
  };
  const errorOracle: JuryOracle = createJuryOracle(errorSource);
  expectErr(errorOracle.expectedJurors('deal-1', 0), 'WINDOW', 'beacon');
});

test('deeply frozen inputs are not mutated and do not throw', () => {
  const frozenCandidates: readonly JuryCandidate[] = Object.freeze(
    candidatesFor(10).map((entry) => Object.freeze({ ...entry })),
  );
  const frozenRules: JuryRules = Object.freeze({
    tiers: Object.freeze([Object.freeze(makeTier())]),
    minPoolSizeRound0: 0,
    minPoolSizeRound1: 0,
  });
  const frozenContext: JuryContext = Object.freeze({
    candidates: frozenCandidates,
    excluded: Object.freeze([]),
    triggerAcceptedAtMs: 100 * DAY_MS,
    beaconReceiptHash: sha256Hex('frozen-seed'),
    rules: frozenRules,
    seatedJurors: Object.freeze([]),
  });

  const result = selectJurors(frozenContext, 0);
  assert.equal(result.ok, true);
});

test('distribution over 2000 seeds covers every pool position', () => {
  const pool = Array.from({ length: 10 }, (_, index) =>
    `a${String(index + 1).padStart(2, '0')}`,
  );
  const seen = new Set<string>();

  for (let seedIndex = 0; seedIndex < 2000; seedIndex += 1) {
    const seed = sha256Hex(`seed${seedIndex}`);
    const drawn = expectOk(drawSequence(pool, seed, 3));
    for (const pubkey of drawn) {
      seen.add(pubkey);
    }
  }

  for (const pubkey of pool) {
    assert.ok(seen.has(pubkey), `position never selected: ${pubkey}`);
  }
});