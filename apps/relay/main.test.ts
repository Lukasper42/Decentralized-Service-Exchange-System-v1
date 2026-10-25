// apps/relay/main.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from './main.js';

const base = { GENESIS_FILE: 'genesis.json', GENESIS_SHA256: 'pin', RELAY_KEY_FILE: 'relay.key' };

test('readConfig applies defaults', () => {
  const config = readConfig(base);
  assert.equal(config.port, 3000);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.mode, 'memory');
  assert.equal(config.policyDirectory, null);
  assert.equal(config.allowedOrigin, null);
  assert.equal(config.maxBodyBytes, 65536);
  assert.equal(config.checkpointEvery, 100);
  assert.deepEqual(config.trustedProxies, []);
});

test('readConfig reads overrides and trims values', () => {
  const config = readConfig({ ...base, PORT: ' 8080 ', HOST: '0.0.0.0', RELAY_MODE: 'postgres', POLICY_DIR: 'policies', ALLOWED_ORIGIN: 'https://app.example', MAX_PAGE: '10', TRUSTED_PROXIES: ' 10.0.0.1, ::1 ,,' });
  assert.equal(config.port, 8080);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.mode, 'postgres');
  assert.equal(config.policyDirectory, 'policies');
  assert.equal(config.allowedOrigin, 'https://app.example');
  assert.equal(config.maxPage, 10);
  assert.deepEqual(config.trustedProxies, ['10.0.0.1', '::1']);
});

test('readConfig rejects missing required variables by name', () => {
  for (const name of Object.keys(base)) {
    const env: Record<string, string | undefined> = { ...base };
    delete env[name];
    assert.throws(() => readConfig(env), new RegExp(`${name} is required`));
  }
  assert.throws(() => readConfig({ ...base, GENESIS_FILE: '  ' }), /GENESIS_FILE is required/);
});

test('readConfig rejects bad numbers and modes without echoing the value', () => {
  for (const value of ['0', '-1', '1.5', 'abc', '70000']) {
    assert.throws(() => readConfig({ ...base, PORT: value }), (error: unknown) => error instanceof Error && /PORT/.test(error.message) && !error.message.includes(value));
  }
  assert.throws(() => readConfig({ ...base, RATE_PER_IP: '0' }), /RATE_PER_IP/);
  assert.throws(() => readConfig({ ...base, RELAY_MODE: 'sqlite' }), /RELAY_MODE must be memory or postgres/);
});
