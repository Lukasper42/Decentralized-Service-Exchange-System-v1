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

test('formatAmount: Überlauf bleibt Überlauf', () => {
  assert.equal(formatAmount('Überlauf'), 'Überlauf');
});

test('formatAmount: 0', () => {
  assert.equal(formatAmount(0), '0 Einheiten');
});

test('formatAmount: 999', () => {
  assert.equal(formatAmount(999), '999 Einheiten');
});

test('formatAmount: 1000', () => {
  assert.equal(formatAmount(1000), '1 000 Einheiten');
});

test('formatAmount: 1234567', () => {
  assert.equal(formatAmount(1234567), '1 234 567 Einheiten');
});

test('formatAmount: negative ganze Zahl', () => {
  assert.equal(formatAmount(-1234), '-1 234 Einheiten');
});

test('formatAmount: 1_000_000_000 behält die Ziffern', () => {
  const n = 1_000_000_000;
  const formatted = formatAmount(n);
  const suffix = ' Einheiten';

  assert.equal(formatted.endsWith(suffix), true);

  const digits = formatted.slice(0, formatted.length - suffix.length).replaceAll(' ', '');
  assert.equal(digits, String(n));
});

test('formatAmount: Number.MAX_SAFE_INTEGER behält die Ziffern', () => {
  const n = Number.MAX_SAFE_INTEGER;
  const formatted = formatAmount(n);
  const suffix = ' Einheiten';

  assert.equal(formatted.endsWith(suffix), true);

  const digits = formatted.slice(0, formatted.length - suffix.length).replaceAll(' ', '');
  assert.equal(digits, String(n));
});

test('formatIso: exaktes ISO-Format wird formatiert', () => {
  assert.equal(
    formatIso('2026-03-07T04:05:06.789Z'),
    '07.03.2026 04:05:06 UTC',
  );
});

test('formatIso: ungültige oder abweichende Eingaben bleiben unverändert', () => {
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

test('shortPubkey: Länge <= 16 bleibt unverändert', () => {
  assert.equal(shortPubkey('abcdefghijklmnop'), 'abcdefghijklmnop');
  assert.equal(shortPubkey('abc'), 'abc');
});

test('shortPubkey: Länge 17 wird gekürzt', () => {
  assert.equal(shortPubkey('abcdefghijklmnopq'), 'abcdefgh…jklmnopq');
});

test('shortHash: Länge <= 16 bleibt unverändert', () => {
  assert.equal(shortHash('0123456789abcdef'), '0123456789abcdef');
});

test('shortHash: Länge 17 wird gekürzt', () => {
  assert.equal(shortHash('0123456789abcdefg'), '0123456789…789abcdefg');
});

test('formatError: formatiert Code, Nachricht und Pfad', () => {
  assert.equal(
    formatError({ code: 'STATE', message: 'x', path: '$.a' }),
    '[STATE] x ($.a)',
  );
});

test('asErrorCode: alle bekannten Codes bleiben identisch', () => {
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

test('asErrorCode: unbekannte Eingaben werden BAD_REQUEST', () => {
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

test('bundleLookupMessage: NOT_FOUND erklärt das fehlende Schlüsselbündel, andere Codes bleiben sichtbar', () => {
  assert.match(bundleLookupMessage('NOT_FOUND'), /noch kein Schlüsselbündel/);
  assert.equal(bundleLookupMessage('LIMIT'), 'Empfänger-Schlüssel: LIMIT');
});
