// apps/relay/admin.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, relayKeyId } from '../../packages/crypto/src/index.js';
import { Projector } from '../../packages/relay/src/projection.js';
import {
  buildGenesis,
  describeGenesis,
  generateRelayKey,
  parseGenesisConfig,
  type AdminFilePort,
  type GenesisConfig
} from './admin.js';
import { parseArgs } from './admin-cli.js';
import { loadGenesis } from './genesis.js';
import { loadRelayKeySource } from './key-file.js';

class MemoryFiles implements AdminFilePort {
  private readonly entries = new Map<string, { text: string; mode: number }>();

  exists(path: string): boolean {
    return this.entries.has(path);
  }

  writeTextExclusive(path: string, text: string, mode: number): void {
    if (this.entries.has(path)) {
      throw new Error('file exists');
    }
    this.entries.set(path, { text, mode });
  }

  readText(path: string): string {
    const entry = this.entries.get(path);
    if (entry === undefined) {
      throw new Error('file not found');
    }
    return entry.text;
  }

  get(path: string): { text: string; mode: number } | undefined {
    return this.entries.get(path);
  }

  set(path: string, text: string, mode = 0o644): void {
    this.entries.set(path, { text, mode });
  }
}

function makeConfig(): GenesisConfig {
  const key = (): string => createIdentity().publicKey;
  const accounts = [key(), key()];
  return {
    policyId: 'policy-1',
    multisigMembers: [key(), key(), key()],
    inviters: [key(), key()],
    genesisAccounts: accounts,
    checkers: [key(), key()],
    issuancePolicyIds: ['issuance-1'],
    jurorPayoutPerCase: 10,
    limits: {
      maxIssuancePerEvent: 1000,
      maxTreasurySpendPerEvent: 2000,
      maxDealAmount: 3000
    },
    treasury: 5000,
    grants: [{ recipient: accounts[0] ?? '', amount: 100, nonce: 'nonce-1' }]
  };
}

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomValue(random: () => number): unknown {
  const kind = Math.floor(random() * 6);
  if (kind === 0) {
    return 'mutated';
  }
  if (kind === 1) {
    return -1;
  }
  if (kind === 2) {
    return null;
  }
  if (kind === 3) {
    return [];
  }
  if (kind === 4) {
    return {};
  }
  return 1;
}

test('generateRelayKey writes mode 0600 without exposing private key', () => {
  const files = new MemoryFiles();
  const identity = createIdentity();

  const result = generateRelayKey({
    outPath: 'relay.key',
    files,
    newIdentity: () => identity
  });

  const entry = files.get('relay.key');
  assert.ok(entry);
  assert.equal(entry.mode, 0o600);
  assert.equal(entry.text, identity.privateKey + '\n');
  assert.equal(JSON.stringify(result).includes(identity.privateKey), false);

  assert.throws(
    () =>
      generateRelayKey({
        outPath: 'relay.key',
        files,
        newIdentity: createIdentity
      }),
    /refusing to overwrite an existing file/
  );
});

test('buildGenesis creates loadable deterministic genesis', () => {
  const config = makeConfig();
  const identity = createIdentity();

  const built = buildGenesis({ config, relayPublicKey: identity.publicKey });
  const loaded = loadGenesis({
    path: 'genesis.json',
    expectedSha256: built.sha256,
    files: { readText: () => built.text },
    policyDirectory: null
  });

  assert.doesNotThrow(() => new Projector(loaded));

  const changed = buildGenesis({
    config: { ...config, treasury: config.treasury + 1 },
    relayPublicKey: identity.publicKey
  });
  assert.notEqual(changed.sha256, built.sha256);

  const again = buildGenesis({ config, relayPublicKey: identity.publicKey });
  assert.equal(again.text, built.text);
  assert.equal(again.sha256, built.sha256);
});

test('buildGenesis rejects grants outside genesis accounts', () => {
  const config = makeConfig();
  const identity = createIdentity();
  const invalid: GenesisConfig = {
    ...config,
    grants: [{ recipient: createIdentity().publicKey, amount: 1, nonce: 'nonce-2' }]
  };

  assert.throws(
    () => buildGenesis({ config: invalid, relayPublicKey: identity.publicKey }),
    /generated genesis is invalid/
  );
});

test('buildGenesis rejects a malformed relay public key', () => {
  const identity = createIdentity();
  for (const bad of ['', 'relay', identity.publicKey.slice(0, -1), `${identity.publicKey}x`]) {
    assert.throws(
      () => buildGenesis({ config: makeConfig(), relayPublicKey: bad }),
      /invalid relay public key/
    );
  }
});

test('parseGenesisConfig validates strictly', () => {
  const config = makeConfig();
  assert.deepEqual(parseGenesisConfig(JSON.stringify(config)), config);

  assert.throws(
    () => parseGenesisConfig(JSON.stringify({ ...config, extra: true })),
    /unknown config field: extra/
  );

  const grant = config.grants[0];
  assert.ok(grant);
  assert.throws(
    () =>
      parseGenesisConfig(
        JSON.stringify({ ...config, grants: [{ ...grant, extra: true }] })
      ),
    /unknown config field: grants\[0\]\.extra/
  );

  const missing: Record<string, unknown> = { ...config };
  delete missing.treasury;
  assert.throws(
    () => parseGenesisConfig(JSON.stringify(missing)),
    /missing config field: treasury/
  );

  assert.throws(
    () => parseGenesisConfig(JSON.stringify({ ...config, treasury: '5000' })),
    /invalid config field: treasury/
  );

  assert.throws(
    () =>
      parseGenesisConfig(
        JSON.stringify({ ...config, jurorPayoutPerCase: -1 })
      ),
    /invalid config field: jurorPayoutPerCase/
  );

  const typo = { ...config, genesisAccounts: ['account-a'] };
  assert.throws(
    () => parseGenesisConfig(JSON.stringify(typo)),
    /invalid config field: genesisAccounts\[0\]/
  );
  const duplicate = { ...config, multisigMembers: [config.multisigMembers[0], config.multisigMembers[0], config.multisigMembers[1]] };
  assert.throws(
    () => parseGenesisConfig(JSON.stringify(duplicate)),
    /invalid config field: multisigMembers\[1\]/
  );
  const badRecipient = { ...config, grants: [{ recipient: 'nobody', amount: 1, nonce: 'n' }] };
  assert.throws(
    () => parseGenesisConfig(JSON.stringify(badRecipient)),
    /invalid config field: grants\[0\]\.recipient/
  );

  const protoConfig: Record<string, unknown> = { ...config };
  Object.defineProperty(protoConfig, '__proto__', {
    value: {},
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(
    () => parseGenesisConfig(JSON.stringify(protoConfig)),
    /forbidden config key/
  );

  const prototypeRecord: Record<string, unknown> = Object.prototype as Record<
    string,
    unknown
  >;
  assert.equal(prototypeRecord.polluted, undefined);
  assert.throws(() => parseGenesisConfig('{'), /not valid JSON/);
});

test('describeGenesis extracts metrics and rejects non-genesis', () => {
  const config = makeConfig();
  const identity = createIdentity();
  const built = buildGenesis({ config, relayPublicKey: identity.publicKey });

  const files = new MemoryFiles();
  files.set('genesis.json', built.text);

  const info = describeGenesis({ path: 'genesis.json', files });
  assert.equal(info.sha256, built.sha256);
  assert.equal(info.relayKeyId, relayKeyId(identity.publicKey));
  assert.equal(info.treasury, config.treasury);
  assert.equal(info.grantCount, config.grants.length);
  assert.equal(info.genesisAccountCount, config.genesisAccounts.length);

  const badFiles = new MemoryFiles();
  badFiles.set('bad.json', JSON.stringify({ version: 1 }));
  assert.throws(
    () => describeGenesis({ path: 'bad.json', files: badFiles }),
    /not a genesis file/
  );
});

test('generated relay key works with generated genesis', () => {
  const files = new MemoryFiles();
  const key = generateRelayKey({
    outPath: 'relay.key',
    files,
    newIdentity: createIdentity
  });

  const config = makeConfig();
  buildGenesis({ config, relayPublicKey: key.publicKey });

  const source = loadRelayKeySource({
    path: 'relay.key',
    files: {
      statMode: (path: string) => {
        const entry = files.get(path);
        if (entry === undefined) {
          throw new Error('file not found');
        }
        return entry.mode;
      },
      readText: (path: string) => files.readText(path)
    },
    expectedKeyId: key.keyId,
    expectedPublicKey: key.publicKey,
    platform: 'linux'
  });

  assert.ok(source);
  assert.equal(key.keyId, relayKeyId(key.publicKey));
});

test('parseArgs handles commands and flags', () => {
  assert.deepEqual(parseArgs(['keygen', '--out', 'relay.key']), {
    command: 'keygen',
    outPath: 'relay.key'
  });

  assert.deepEqual(
    parseArgs([
      'genesis',
      'build',
      '--config',
      'config.json',
      '--relay-public-key',
      'public',
      '--out',
      'genesis.json'
    ]),
    {
      command: 'genesis build',
      configPath: 'config.json',
      relayPublicKey: 'public',
      outPath: 'genesis.json'
    }
  );

  assert.deepEqual(parseArgs(['genesis', 'hash', '--file', 'genesis.json']), {
    command: 'genesis hash',
    filePath: 'genesis.json'
  });

  assert.throws(
    () => parseArgs(['keygen', '--out', 'a', '--out', 'b']),
    /duplicate flag/
  );
  assert.throws(() => parseArgs(['keygen', '--bad', 'a']), /unknown flag/);
  assert.throws(() => parseArgs(['keygen', '--out']), /missing value/);
  assert.throws(() => parseArgs([]), /missing command/);
  assert.throws(() => parseArgs(['keygen']), /missing flag/);
});

test('randomly mutated configurations only produce values or Errors', () => {
  const random = makeLcg(123456789);
  const identity = createIdentity();
  const baseConfig = makeConfig();

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const parsed: unknown = JSON.parse(JSON.stringify(baseConfig));
    assert.ok(
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    );
    const mutated = parsed as Record<string, unknown>;

    const keys = Object.keys(mutated);
    assert.ok(keys.length > 0);
    const key = keys[Math.floor(random() * keys.length)];
    assert.ok(key !== undefined);
    mutated[key] = randomValue(random);

    try {
      const config = parseGenesisConfig(JSON.stringify(mutated));
      buildGenesis({ config, relayPublicKey: identity.publicKey });
    } catch (error) {
      assert.ok(
        error instanceof Error,
        `unexpected thrown value: ${String(error)}`
      );
    }
  }
});