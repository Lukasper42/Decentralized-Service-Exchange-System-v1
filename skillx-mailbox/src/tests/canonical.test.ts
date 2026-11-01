import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../canonical.js';
import type { JsonValue } from '../canonical.js';

test('canonical JSON sorts keys', () => {
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('canonical JSON nests arrays and objects', () => {
  assert.equal(canonical({ z: [1, true, null], a: { y: 'x' } }), '{"a":{"y":"x"},"z":[1,true,null]}');
});

test('canonical JSON rejects floating-point numbers', () => {
  assert.throws(() => canonical(1.5));
  assert.throws(() => canonical(Number.NaN));
  assert.throws(() => canonical(Number.POSITIVE_INFINITY));
});

test('canonical JSON rejects undefined', () => {
  assert.throws(() => canonical(undefined as unknown as JsonValue));
});

test('canonical JSON rejects foreign objects', () => {
  assert.throws(() => canonical(new Map<string, string>() as unknown as JsonValue));
});
