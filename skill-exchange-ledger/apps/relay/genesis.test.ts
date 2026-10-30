// apps/relay/genesis.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, relayKeyId, sha256Hex } from '../../packages/crypto/src/index.js';
import { defaultBetaParams, policyParamsHash } from '../../packages/domain/src/policy.js';
import type { PolicyParams } from '../../packages/domain/src/policy.js';
import { Projector } from '../../packages/relay/src/projection.js';
import { loadGenesis } from './genesis.js';
import type { GenesisFilePort } from './genesis.js';

type Identity = ReturnType<typeof createIdentity>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makePolicy(relay: Identity, recipient: string): PolicyParams {
  const member = createIdentity().publicKey;
  return defaultBetaParams({
    policyId: 'genesis-test',
    multisigMembers: [member, createIdentity().publicKey, createIdentity().publicKey].sort(),
    inviters: [member],
    genesisAccounts: [recipient],
    checkers: [],
    genesisRelayKey: { keyId: relayKeyId(relay.publicKey), pubkey: relay.publicKey },
    issuancePolicyIds: ['test-grant'],
    jurorPayoutPerCase: 0,
    limits: { maxIssuancePerEvent: 1_000_000, maxTreasurySpendPerEvent: 1_000_000, maxDealAmount: 1_000_000 },
  });
}

function makeGenesis(
  relay: Identity,
  policy: PolicyParams,
  recipient: string,
): Record<string, unknown> {
  return {
    version: 1,
    relayPublicKey: relay.publicKey,
    policy,
    treasury: 1000,
    grants: [
      {
        recipient,
        amount: 10,
        nonce: sha256Hex('grant-1'),
      },
    ],
  };
}

class MemoryGenesisFiles implements GenesisFilePort {
  public readCount = 0;
  private readonly files: Map<string, string>;

  public constructor(files: Record<string, string> = {}) {
    this.files = new Map(Object.entries(files));
  }

  public readText(path: string): string {
    this.readCount += 1;
    const text = this.files.get(path);
    if (text === undefined) {
      throw new Error('missing test file');
    }
    return text;
  }
}

function loadObject(
  value: unknown,
  policyDirectory: string | null = null,
  extraFiles: Record<string, string> = {},
) {
  const text = JSON.stringify(value);
  const files = new MemoryGenesisFiles({ 'genesis.json': text, ...extraFiles });
  return loadGenesis({
    path: 'genesis.json',
    expectedSha256: sha256Hex(text),
    files,
    policyDirectory,
  });
}

function cloneRecord(value: unknown): Record<string, unknown> {
  const clone: unknown = JSON.parse(JSON.stringify(value));
  assert.ok(isRecord(clone));
  return clone;
}

function grantsOf(root: Record<string, unknown>): unknown[] {
  const value = root['grants'];
  assert.ok(Array.isArray(value));
  return value;
}

function grantAt(root: Record<string, unknown>, index: number): Record<string, unknown> {
  const grants = grantsOf(root);
  const grant = grants[index];
  assert.ok(isRecord(grant));
  return grant;
}

test('valid genesis loads and can construct Projector', () => {
  const relay = createIdentity();
  const recipient = createIdentity();
  const policy = makePolicy(relay, recipient.publicKey);
  const genesis = makeGenesis(relay, policy, recipient.publicKey);

  const config = loadObject(genesis);
  const projector = new Projector(config);
  assert.ok(projector);
});

test('genesis hash mismatch is rejected', () => {
  const relay = createIdentity();
  const recipient = createIdentity();
  const policy = makePolicy(relay, recipient.publicKey);
  const genesis = makeGenesis(relay, policy, recipient.publicKey);
  const text = JSON.stringify(genesis);

  assert.throws(
    () =>
      loadGenesis({
        path: 'genesis.json',
        expectedSha256: sha256Hex(text + 'x'),
        files: new MemoryGenesisFiles({ 'genesis.json': text }),
        policyDirectory: null,
      }),
    /hash mismatch/,
  );

  const changedText = text + ' ';
  assert.throws(
    () =>
      loadGenesis({
        path: 'genesis.json',
        expectedSha256: sha256Hex(text),
        files: new MemoryGenesisFiles({ 'genesis.json': changedText }),
        policyDirectory: null,
      }),
    /hash mismatch/,
  );
});

test('unknown, missing and unsupported fields are rejected', () => {
  const relay = createIdentity();
  const recipient = createIdentity();
  const policy = makePolicy(relay, recipient.publicKey);
  const genesis = makeGenesis(relay, policy, recipient.publicKey);

  assert.throws(() => loadObject({ ...genesis, extra: true }), /unknown genesis field: extra/);

  const withUnknownGrant = cloneRecord(genesis);
  grantAt(withUnknownGrant, 0)['extra'] = true;
  assert.throws(
    () => loadObject(withUnknownGrant),
    /unknown genesis field: grants\[0\]\.extra/,
  );

  const missing = cloneRecord(genesis);
  delete missing['treasury'];
  assert.throws(() => loadObject(missing), /missing genesis field: treasury/);

  const version = cloneRecord(genesis);
  version['version'] = 2;
  assert.throws(() => loadObject(version), /version/);
});

test('policy naming a different relay key is rejected', () => {
  const relay = createIdentity();
  const otherRelay = createIdentity();
  const recipient = createIdentity();
  const policy = makePolicy(otherRelay, recipient.publicKey);
  const genesis = makeGenesis(relay, policy, recipient.publicKey);

  assert.throws(() => loadObject(genesis), /different relay key/);
});

test('invalid grants are rejected', () => {
  const relay = createIdentity();
  const recipient = createIdentity();
  const policy = makePolicy(relay, recipient.publicKey);
  const genesis = makeGenesis(relay, policy, recipient.publicKey);

  const negative = cloneRecord(genesis);
  grantAt(negative, 0)['amount'] = -1;
  assert.throws(() => loadObject(negative), /invalid genesis grant 0:/);

  const duplicate = cloneRecord(genesis);
  const first = grantAt(duplicate, 0);
  grantsOf(duplicate).push({
    recipient: first['recipient'],
    amount: 1,
    nonce: first['nonce'],
  });
  assert.throws(() => loadObject(duplicate), /invalid genesis grant 1:/);
});

test('__proto__ key is rejected without prototype pollution', () => {
  const relay = createIdentity();
  const recipient = createIdentity();
  const policy = makePolicy(relay, recipient.publicKey);
  const genesis = makeGenesis(relay, policy, recipient.publicKey);
  const polluted = cloneRecord(genesis);

  Object.defineProperty(polluted, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });

  assert.throws(() => loadObject(polluted), /forbidden genesis key/);
  assert.ok(!Object.hasOwn(Object.prototype, 'polluted'));
});

test('policyDocuments reads only safe matching documents', () => {
  const relay = createIdentity();
  const recipient = createIdentity();
  const otherRecipient = createIdentity();
  const policy = makePolicy(relay, recipient.publicKey);
  const genesis = makeGenesis(relay, policy, recipient.publicKey);
  const genesisText = JSON.stringify(genesis);
  const hash = policyParamsHash(policy);

  const files = new MemoryGenesisFiles({
    'genesis.json': genesisText,
    [`policies/${hash}.json`]: JSON.stringify(policy),
  });
  const config = loadGenesis({
    path: 'genesis.json',
    expectedSha256: sha256Hex(genesisText),
    files,
    policyDirectory: 'policies',
  });
  assert.notEqual(config.policyDocuments.get(hash), undefined);

  const nullConfig = loadGenesis({
    path: 'genesis.json',
    expectedSha256: sha256Hex(genesisText),
    files: new MemoryGenesisFiles({ 'genesis.json': genesisText }),
    policyDirectory: null,
  });
  assert.equal(nullConfig.policyDocuments.get(hash), undefined);

  const otherPolicy = makePolicy(relay, otherRecipient.publicKey);
  const invalidFiles = new MemoryGenesisFiles({
    'genesis.json': genesisText,
    [`policies/${hash}.json`]: JSON.stringify(otherPolicy),
  });
  const invalidConfig = loadGenesis({
    path: 'genesis.json',
    expectedSha256: sha256Hex(genesisText),
    files: invalidFiles,
    policyDirectory: 'policies',
  });
  assert.equal(invalidConfig.policyDocuments.get(hash), undefined);

  const traversalFiles = new MemoryGenesisFiles({ 'genesis.json': genesisText });
  const traversalConfig = loadGenesis({
    path: 'genesis.json',
    expectedSha256: sha256Hex(genesisText),
    files: traversalFiles,
    policyDirectory: 'policies',
  });
  traversalFiles.readCount = 0;
  assert.equal(traversalConfig.policyDocuments.get('../x'), undefined);
  assert.equal(traversalFiles.readCount, 0);
});

test('seeded mutations never crash', () => {
  const relay = createIdentity();
  const recipient = createIdentity();
  const policy = makePolicy(relay, recipient.publicKey);
  const genesis = makeGenesis(relay, policy, recipient.publicKey);
  const base = cloneRecord(genesis);
  const topKeys = Object.keys(base);

  let seed = 0x12345678;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let index = 0; index < 100; index += 1) {
    const mutated = cloneRecord(base);
    const action = Math.floor(next() * 3);
    if (action === 0) {
      const key = topKeys[Math.floor(next() * topKeys.length)] ?? 'version';
      delete mutated[key];
    } else if (action === 1) {
      mutated[`extra${index}`] = index;
    } else {
      const key = topKeys[Math.floor(next() * topKeys.length)] ?? 'version';
      mutated[key] = { changed: index };
    }

    try {
      const config = loadObject(mutated);
      assert.ok(config);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }
});