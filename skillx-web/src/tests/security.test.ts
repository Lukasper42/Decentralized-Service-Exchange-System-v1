import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CryptoPort, StoragePort } from '../ports.js';
import type { LedgerEntry } from '../types.js';
import { derivePublicKey, generateKeyPair, signAttestationWithKey, verifyAttestation, importNonExtractablePrivate } from '../crypto.js';
import { MAX_PBKDF2_ITERATIONS, PBKDF2_ITERATIONS, createVault, importFile, exportFile, unlockSigner } from '../vault.js';
import { checkAndUpdatePin, clearPin, loadPin, PIN_STORAGE_KEY } from '../pin.js';
import { MAX_RESPONSE_BYTES, readCappedText } from '../net-limits.js';

const port: CryptoPort = { subtle: globalThis.crypto.subtle };
const random = { bytes: (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n)) };
const clock = { nowMs: (): number => 0, nowIso: (): string => '2026-01-01T00:00:00.000Z' };

function memStorage(): StoragePort & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

function entry(seq: number, tag: string): LedgerEntry {
  return {
    receipt: {
      sequence: seq,
      eventHash: tag.padEnd(64, '0'),
      previousReceiptHash: null,
      acceptedAt: '2026-01-01T00:00:00.000Z',
      keyId: 'b'.repeat(64),
      signature: 'sig',
    },
  } as unknown as LedgerEntry;
}

test('derivePublicKey matches the generated public key', async () => {
  const pair = await generateKeyPair(port);
  assert.equal(await derivePublicKey(port, pair.privateKeyPkcs8), pair.publicKey);
});

test('signAttestationWithKey is verifiable with the public key', async () => {
  const pair = await generateKeyPair(port);
  const key = await importNonExtractablePrivate(port, pair.privateKeyPkcs8);
  const body = { deal_id: 'd1' };
  const sig = await signAttestationWithKey(port, key, 'jury-vote', body);
  assert.equal(await verifyAttestation(port, pair.publicKey, 'jury-vote', body, sig), true);
  await assert.rejects(port.subtle.exportKey('pkcs8', key));
});

test('unlockSigner: roundtrip, wrong public key, wrong password', async () => {
  const pw = 'a-long-enough-passphrase';
  const created = await createVault(port, random, clock, pw);
  assert.ok(created.ok);
  const vault = created.value.vault;
  const good = await unlockSigner(port, vault, pw);
  assert.ok(good.ok);
  assert.equal(good.value.publicKey, vault.publicKey);
  const other = await generateKeyPair(port);
  const tampered = await unlockSigner(port, { publicKey: other.publicKey, file: vault.file }, pw);
  assert.equal(tampered.ok, false);
  const wrong = await unlockSigner(port, vault, 'another-long-wrong-passphrase');
  assert.equal(wrong.ok, false);
  const imported = await unlockSigner(port, { publicKey: '', file: vault.file }, pw);
  assert.ok(imported.ok);
  assert.equal(imported.value.publicKey, vault.publicKey);
});

test('importFile: iteration limits', async () => {
  const created = await createVault(port, random, clock, 'a-long-enough-passphrase');
  assert.ok(created.ok);
  const base = JSON.parse(exportFile(created.value.vault)) as Record<string, unknown>;
  assert.equal(importFile(JSON.stringify(base)).ok, true);
  for (const iterations of [1000, PBKDF2_ITERATIONS - 1, MAX_PBKDF2_ITERATIONS + 1]) {
    assert.equal(importFile(JSON.stringify({ ...base, iterations })).ok, false);
  }
});

test('Pin: progress, rollback, fork, reset', async () => {
  const st = memStorage();
  const relay = 'relay-key';
  const chain = [entry(1, 'a'), entry(2, 'b'), entry(3, 'c')];
  assert.equal(await checkAndUpdatePin(port, st, relay, chain), null);
  assert.equal(loadPin(st)?.length, 3);
  const rollback = await checkAndUpdatePin(port, st, relay, chain.slice(0, 2));
  assert.equal(rollback?.code, 'DIVERGENCE');
  const fork = await checkAndUpdatePin(port, st, relay, [entry(1, 'a'), entry(2, 'b'), entry(3, 'x')]);
  assert.equal(fork?.code, 'DIVERGENCE');
  assert.equal(await checkAndUpdatePin(port, st, relay, [...chain, entry(4, 'd')]), null);
  assert.equal(loadPin(st)?.length, 4);
  assert.equal(await checkAndUpdatePin(port, st, 'other-relay', chain.slice(0, 1)), null);
  clearPin(st);
  assert.equal(st.map.has(PIN_STORAGE_KEY), false);
});

test('Pin: broken stored content is ignored', async () => {
  const st = memStorage();
  st.set(PIN_STORAGE_KEY, '{"relayPubkey":1}');
  assert.equal(loadPin(st), null);
});

test('readCappedText: limit is enforced', async () => {
  assert.equal(await readCappedText(new Response('hallo'), 100), 'hallo');
  await assert.rejects(readCappedText(new Response('x'.repeat(200)), 100));
  assert.ok(MAX_RESPONSE_BYTES >= 1024 * 1024);
});
