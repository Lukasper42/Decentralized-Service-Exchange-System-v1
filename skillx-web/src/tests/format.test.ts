import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAmount,
  formatIso,
  shortPubkey,
  shortHash,
  formatError,
  asErrorCode,
  bundleLookupMessage,
} from '../format.js';

test('formatAmount: overflow stays overflow', () => {
  assert.equal(formatAmount('overflow'), 'overflow');
});

test('formatAmount: 0', () => {
  assert.equal(formatAmount(0), '0 units');
});

test('formatAmount: 999', () => {
  assert.equal(formatAmount(999), '999 units');
});

test('formatAmount: 1000', () => {
  assert.equal(formatAmount(1000), '1 000 units');
});

test('formatAmount: 1234567', () => {
  assert.equal(formatAmount(1234567), '1 234 567 units');
});

test('formatAmount: negative integer', () => {
  assert.equal(formatAmount(-1234), '-1 234 units');
});

test('formatAmount: 1_000_000_000 keeps the digits', () => {
  const n = 1_000_000_000;
  const formatted = formatAmount(n);
  const suffix = ' units';

  assert.equal(formatted.endsWith(suffix), true);

  const digits = formatted.slice(0, formatted.length - suffix.length).replaceAll(' ', '');
  assert.equal(digits, String(n));
});

test('formatAmount: Number.MAX_SAFE_INTEGER keeps the digits', () => {
  const n = Number.MAX_SAFE_INTEGER;
  const formatted = formatAmount(n);
  const suffix = ' units';

  assert.equal(formatted.endsWith(suffix), true);

  const digits = formatted.slice(0, formatted.length - suffix.length).replaceAll(' ', '');
  assert.equal(digits, String(n));
});

test('formatIso: exact ISO format is formatted', () => {
  assert.equal(
    formatIso('2026-03-07T04:05:06.789Z'),
    '2026-03-07 04:05:06 UTC',
  );
});

test('formatIso: invalid or deviating inputs stay unchanged', () => {
  const inputs = [
    '2026-03-07',
    '2026-03-07T04:05:06Z',
    '',
    'abc',
    ' 2026-03-07T04:05:06.789Z',
  ] as const;

  for (const input of inputs) {
    assert.equal(formatIso(input), input);
  }
});

test('shortPubkey: length <= 16 stays unchanged', () => {
  assert.equal(shortPubkey('abcdefghijklmnop'), 'abcdefghijklmnop');
  assert.equal(shortPubkey('abc'), 'abc');
});

test('shortPubkey: length 17 is shortened', () => {
  assert.equal(shortPubkey('abcdefghijklmnopq'), 'abcdefgh…jklmnopq');
});

test('shortHash: length <= 16 stays unchanged', () => {
  assert.equal(shortHash('0123456789abcdef'), '0123456789abcdef');
});

test('shortHash: length 17 is shortened', () => {
  assert.equal(shortHash('0123456789abcdefg'), '0123456789…789abcdefg');
});

test('formatError: formats code, message and path', () => {
  assert.equal(
    formatError({ code: 'STATE', message: 'x', path: '$.a' }),
    '[STATE] x ($.a)',
  );
});

test('asErrorCode: all known codes stay identical', () => {
  const codes = [
    'VERSION',
    'ENVELOPE',
    'TIMESTAMP',
    'PAYLOAD',
    'SIGNATURE',
    'UNKNOWN_TYPE',
    'UNKNOWN_FIELD',
    'MISSING_FIELD',
    'FIELD_FORMAT',
    'AMOUNT',
    'LIMIT',
    'SIGNER_AUTHORITY',
    'ATTESTATION',
    'CHAIN_LINK',
    'FORK',
    'RECEIPT_SEQUENCE',
    'RECEIPT_EVENT_HASH',
    'RECEIPT_LINK',
    'RECEIPT_SIGNATURE',
    'KEY_UNKNOWN',
    'STATE',
    'WINDOW',
    'POLICY',
    'REPLAY',
    'DUPLICATE',
    'INSUFFICIENT_FUNDS',
    'JURY_MISMATCH',
    'READ_ONLY',
    'RATE_LIMITED',
    'NOT_FOUND',
    'BAD_REQUEST',
    'TOO_LARGE',
    'STORE_FAILURE',
    'TRANSPORT',
    'DIVERGENCE',
    'SIGNING',
  ] as const;

  for (const code of codes) {
    assert.equal(asErrorCode(code), code);
  }
});

test('asErrorCode: unknown inputs become BAD_REQUEST', () => {
  const unknownInputs = [
    '',
    'unknown',
    'state',
    'toString',
    '__proto__',
    'STATE ',
  ] as const;

  for (const input of unknownInputs) {
    assert.equal(asErrorCode(input), 'BAD_REQUEST');
  }
});

test('bundleLookupMessage: NOT_FOUND explains the missing key bundle, other codes stay visible', () => {
  assert.match(bundleLookupMessage('NOT_FOUND'), /not published a key bundle yet/);
  assert.equal(bundleLookupMessage('LIMIT'), 'Recipient key: LIMIT');
});
