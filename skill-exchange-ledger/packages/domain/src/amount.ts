import type { Result } from './protocol.js';
import { AMOUNT_MAX, AMOUNT_MIN, err, ok } from './protocol.js';

/** All amount arithmetic is integer-only and checked; failures use the stable code AMOUNT. */
function operand(value: number, name: string): Result<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    return err('AMOUNT', `${name} must be a non-negative safe integer`, name);
  }
  return ok(value);
}

export function checkedAdd(a: number, b: number): Result<number> {
  const x = operand(a, 'a'); if (!x.ok) return x;
  const y = operand(b, 'b'); if (!y.ok) return y;
  const sum = a + b;
  return Number.isSafeInteger(sum) ? ok(sum) : err('AMOUNT', 'Addition overflows the safe integer range', 'result');
}

export function checkedSub(a: number, b: number): Result<number> {
  const x = operand(a, 'a'); if (!x.ok) return x;
  const y = operand(b, 'b'); if (!y.ok) return y;
  return a >= b ? ok(a - b) : err('AMOUNT', 'Subtraction underflows below zero', 'result');
}

export function checkedMul(a: number, b: number): Result<number> {
  const x = operand(a, 'a'); if (!x.ok) return x;
  const y = operand(b, 'b'); if (!y.ok) return y;
  const product = a * b;
  return Number.isSafeInteger(product) ? ok(product) : err('AMOUNT', 'Multiplication overflows the safe integer range', 'result');
}

/** floor(x / 10000) without floating-point division. */
function floorDiv10000(x: number): number { return (x - (x % 10000)) / 10000; }

/** ceil(amount * bp / 10000) as floor((amount*bp + 9999) / 10000), spec section 6. */
function basisPointFee(amount: number, bp: number): Result<number> {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < AMOUNT_MIN || amount > AMOUNT_MAX) {
    return err('AMOUNT', `Amount must be an integer in [${AMOUNT_MIN}, ${AMOUNT_MAX}]`, 'amount');
  }
  if (typeof bp !== 'number' || !Number.isSafeInteger(bp) || bp < 0 || bp > 10000) return err('AMOUNT', 'Basis points must be an integer in [0, 10000]', 'bp');
  const scaled = checkedMul(amount, bp); if (!scaled.ok) return scaled;
  const rounded = checkedAdd(scaled.value, 9999); if (!rounded.ok) return rounded;
  return ok(floorDiv10000(rounded.value));
}

/** Settlement fee F = ceil(E * 100 / 10000); `bp` is the policy value (default 100). */
export function fee(escrow: number, bp = 100): Result<number> { return basisPointFee(escrow, bp); }
/** Appeal fee = ceil(E * 1000 / 10000); `bp` is the policy value (default 1000). */
export function appealFee(escrow: number, bp = 1000): Result<number> { return basisPointFee(escrow, bp); }
