import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, createIdentity, eventHash, signEvent, verifyEvent } from './index.js';
import type { EventCore } from '../../domain/src/protocol.js';

test('canonical JSON sorts object keys and preserves arrays', () => {
  assert.equal(canonical({ z: 1, a: [2, 1] }), '{"a":[2,1],"z":1}');
});

test('signed event verifies, and payload tampering is detected', () => {
  const identity = createIdentity();
  const core: EventCore<'AccountCreated'> = { type: 'AccountCreated', version: 1, payload: { pubkey: identity.publicKey, recovery_commitment: 'a'.repeat(64) }, signer: identity.publicKey, timestamp: '2026-10-17T00:00:00.000Z', prevHash: null };
  const event = signEvent(core, identity.privateKey);
  assert.equal(verifyEvent(event), true);
  assert.equal(eventHash(event).length, 64);
  assert.equal(verifyEvent({ ...event, payload: { ...event.payload, recovery_commitment: 'b'.repeat(64) } }), false);
});
