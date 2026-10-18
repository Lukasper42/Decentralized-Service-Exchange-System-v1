import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, signEvent } from '../../crypto/src/index.js';
import type { EventCore } from '../../domain/src/protocol.js';
import { validateEvent } from './index.js';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');

test('validates a schema-conforming signed account event', () => {
  const identity = createIdentity();
  const core: EventCore<'AccountCreated'> = {
    type: 'AccountCreated', version: 1,
    payload: { pubkey: identity.publicKey, recovery_commitment: 'a'.repeat(64) },
    signer: identity.publicKey, timestamp: new Date(NOW).toISOString(), prevHash: null,
  };
  assert.equal(validateEvent(signEvent(core, identity.privateKey), NOW).ok, true);
});

test('rejects extra fields and an invalid signer before accepting an event', () => {
  const identity = createIdentity();
  const core: EventCore<'AccountCreated'> = {
    type: 'AccountCreated', version: 1,
    payload: { pubkey: identity.publicKey, recovery_commitment: 'a'.repeat(64) },
    signer: identity.publicKey, timestamp: new Date(NOW).toISOString(), prevHash: null,
  };
  const event = signEvent(core, identity.privateKey);
  assert.equal(validateEvent({ ...event, payload: { ...event.payload, extra: true } }, NOW).ok, false);
  assert.equal(validateEvent({ ...event, signer: 'not-a-key' }, NOW).ok, false);
});
