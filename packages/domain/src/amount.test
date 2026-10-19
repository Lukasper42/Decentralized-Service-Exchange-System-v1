import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appealFee, checkedAdd, checkedMul, checkedSub, fee } from './amount.js';
import { AMOUNT_MAX, AMOUNT_MIN } from './protocol.js';

const ceilRef = (amount: number, bp: number): number => {
  const numerator = BigInt(amount) * BigInt(bp);
  return Number((numerator + 9999n) / 10000n);
};
function sample(): number[] {
  const values = new Set<number>([AMOUNT_MIN, AMOUNT_MIN + 1, 99, 100, 101, 9999, 10000, 10001, AMOUNT_MAX, AMOUNT_MAX - 1, AMOUNT_MAX - 9999]);
  let seed = 7;
  for (let i = 0; i < 5000; i += 1) {
    seed = Number((BigInt(seed) * 6364136223846793005n + 1442695040888963407n) % (2n ** 53n));
    values.add(AMOUNT_MIN + (seed % (AMOUNT_MAX - AMOUNT_MIN + 1)));
  }
  for (let k = 1; k < 200; k += 1) { values.add(k * 100); values.add(k * 100 - 1); values.add(k * 10000 + 1); }
  return [...values].filter((v) => v >= AMOUNT_MIN && v <= AMOUNT_MAX);
}

test('B2 property: fee and appealFee equal the BigInt reference across the amount range', () => {
  for (const amount of sample()) {
    const f = fee(amount); const a = appealFee(amount);
    assert.deepEqual(f, { ok: true, value: ceilRef(amount, 100) }, `fee(${amount})`);
    assert.deepEqual(a, { ok: true, value: ceilRef(amount, 1000) }, `appealFee(${amount})`);
    assert.ok(Number.isSafeInteger(a.ok ? a.value : -1));
  }
});

test('E4: fee examples, minimum fee of 1 and exact boundaries', () => {
  assert.deepEqual(fee(2), { ok: true, value: 1 });
  assert.deepEqual(fee(100), { ok: true, value: 1 });
  assert.deepEqual(fee(101), { ok: true, value: 2 });
  assert.deepEqual(fee(1000), { ok: true, value: 10 });
  assert.deepEqual(appealFee(2), { ok: true, value: 1 });
  assert.deepEqual(appealFee(1000), { ok: true, value: 100 });
  assert.deepEqual(appealFee(1001), { ok: true, value: 101 });
});

test('E4: out-of-range, non-integer and overflow inputs fail with AMOUNT', () => {
  for (const bad of [AMOUNT_MIN - 1, 0, -5, AMOUNT_MAX + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    for (const result of [fee(bad), appealFee(bad)]) { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'AMOUNT'); }
  }
  assert.equal(fee(10, -1).ok, false);
  assert.equal(fee(10, 10001).ok, false);
});

test('B2: checked arithmetic detects overflow, underflow and bad operands', () => {
  assert.deepEqual(checkedAdd(2, 3), { ok: true, value: 5 });
  assert.deepEqual(checkedSub(5, 3), { ok: true, value: 2 });
  assert.deepEqual(checkedMul(6, 7), { ok: true, value: 42 });
  const failures = [checkedAdd(Number.MAX_SAFE_INTEGER, 1), checkedSub(1, 2), checkedMul(Number.MAX_SAFE_INTEGER, 2), checkedAdd(1.5, 1), checkedAdd(-1, 1), checkedMul(Number.NaN, 1), checkedSub(-0, 0)];
  for (const result of failures) { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'AMOUNT'); }
});
