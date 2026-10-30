import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../canonical.js';
import type { JsonValue } from '../canonical.js';

test('kanonisches JSON sortiert Schlüssel', () => {
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('kanonisches JSON verschachtelt Arrays und Objekte', () => {
  assert.equal(canonical({ z: [1, true, null], a: { y: 'x' } }), '{"a":{"y":"x"},"z":[1,true,null]}');
});

test('kanonisches JSON lehnt Fließkommazahlen ab', () => {
  assert.throws(() => canonical(1.5));
  assert.throws(() => canonical(Number.NaN));
  assert.throws(() => canonical(Number.POSITIVE_INFINITY));
});

test('kanonisches JSON lehnt undefined ab', () => {
  assert.throws(() => canonical(undefined as unknown as JsonValue));
});

test('kanonisches JSON lehnt fremde Objekte ab', () => {
  assert.throws(() => canonical(new Map<string, string>() as unknown as JsonValue));
});
