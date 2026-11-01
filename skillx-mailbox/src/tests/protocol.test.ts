import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidIso } from '../protocol.js';

test('isValidIso checks month lengths and leap years', () => {
  assert.equal(isValidIso('2026-02-28T00:00:00.000Z'), true);
  assert.equal(isValidIso('2026-02-29T00:00:00.000Z'), false);
  assert.equal(isValidIso('2028-02-29T00:00:00.000Z'), true);
  assert.equal(isValidIso('2026-04-31T00:00:00.000Z'), false);
  assert.equal(isValidIso('2026-13-01T00:00:00.000Z'), false);
  assert.equal(isValidIso('2026-01-01T24:00:00.000Z'), false);
  assert.equal(isValidIso('2026-01-01 00:00:00.000Z'), false);
});
