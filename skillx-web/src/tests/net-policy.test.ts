import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRelayUrl } from '../net-policy.js';

test('https wird akzeptiert, Slash am Ende entfernt', () => {
  const r = checkRelayUrl('https://relay.example.org/');
  assert.deepEqual(r, { ok: true, url: 'https://relay.example.org', onion: false });
});

test('http nur für .onion und localhost', () => {
  assert.equal(checkRelayUrl('http://abcdefghij.onion').ok, true);
  assert.equal(checkRelayUrl('http://localhost:8080').ok, true);
  assert.equal(checkRelayUrl('http://127.0.0.1:8080').ok, true);
  assert.equal(checkRelayUrl('http://relay.example.org').ok, false);
});

test('onion wird erkannt', () => {
  const r = checkRelayUrl('http://abcdefghij.onion');
  assert.equal(r.ok && r.onion, true);
});

test('Zugangsdaten, Query und Fragment werden abgelehnt', () => {
  assert.equal(checkRelayUrl('https://u:p@relay.example.org').ok, false);
  assert.equal(checkRelayUrl('https://relay.example.org/?a=1').ok, false);
  assert.equal(checkRelayUrl('https://relay.example.org/#x').ok, false);
});

test('Ungültige und fremde Schemata werden abgelehnt', () => {
  assert.equal(checkRelayUrl('nicht-eine-url').ok, false);
  assert.equal(checkRelayUrl('ftp://relay.example.org').ok, false);
  assert.equal(checkRelayUrl('javascript:alert(1)').ok, false);
});
