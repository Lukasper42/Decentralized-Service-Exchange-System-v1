// apps/relay/admin.ts
import { relayKeyId, sha256Hex } from '../../packages/crypto/src/index.js';
import { defaultBetaParams } from '../../packages/domain/src/policy.js';
import { loadGenesis } from './genesis.js';

export interface AdminFilePort {
  exists(path: string): boolean;
  writeTextExclusive(path: string, text: string, mode: number): void;
  readText(path: string): string;
}

export interface GenesisConfig {
  policyId: string;
  multisigMembers: string[];
  inviters: string[];
  genesisAccounts: string[];
  checkers: string[];
  issuancePolicyIds: string[];
  jurorPayoutPerCase: number;
  limits: {
    maxIssuancePerEvent: number;
    maxTreasurySpendPerEvent: number;
    maxDealAmount: number;
  };
  treasury: number;
  grants: Array<{ recipient: string; amount: number; nonce: string }>;
}

const ROOT_FIELDS = [
  'policyId',
  'multisigMembers',
  'inviters',
  'genesisAccounts',
  'checkers',
  'issuancePolicyIds',
  'jurorPayoutPerCase',
  'limits',
  'treasury',
  'grants'
] as const;

const LIMIT_FIELDS = [
  'maxIssuancePerEvent',
  'maxTreasurySpendPerEvent',
  'maxDealAmount'
] as const;

const GRANT_FIELDS = ['recipient', 'amount', 'nonce'] as const;

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ed25519 SPKI in canonical Base64 (44 DER bytes). A typo here would make a multisig member or account unusable. */
function isPubkey(value: string): boolean {
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 44 && bytes.toString('base64') === value;
}

function joinPath(parent: string, field: string): string {
  return parent.length === 0 ? field : `${parent}.${field}`;
}

function assertNoForbiddenKeys(value: Record<string, unknown>): void {
  for (const key of FORBIDDEN_KEYS) {
    if (Object.hasOwn(value, key)) {
      throw new Error('forbidden config key');
    }
  }
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`unknown config field: ${joinPath(path, key)}`);
    }
  }
}

function assertRequiredFields(
  value: Record<string, unknown>,
  required: readonly string[],
  path: string
): void {
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`missing config field: ${joinPath(path, field)}`);
    }
  }
}

function readString(
  value: Record<string, unknown>,
  field: string,
  path: string
): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'string') {
    throw new Error(`invalid config field: ${joinPath(path, field)}`);
  }
  return fieldValue;
}

function readPubkey(
  value: Record<string, unknown>,
  field: string,
  path: string
): string {
  const fieldValue = readString(value, field, path);
  if (!isPubkey(fieldValue)) {
    throw new Error(`invalid config field: ${joinPath(path, field)}`);
  }
  return fieldValue;
}

function readPubkeyArray(
  value: Record<string, unknown>,
  field: string,
  path: string
): string[] {
  const keys = readStringArray(value, field, path);
  const fieldPath = joinPath(path, field);
  const seen = new Set<string>();
  for (const [index, key] of keys.entries()) {
    if (!isPubkey(key) || seen.has(key)) {
      throw new Error(`invalid config field: ${fieldPath}[${index}]`);
    }
    seen.add(key);
  }
  return keys;
}

function readNumber(
  value: Record<string, unknown>,
  field: string,
  path: string
): number {
  const fieldValue = value[field];
  if (
    typeof fieldValue !== 'number' ||
    !Number.isInteger(fieldValue) ||
    fieldValue < 0 ||
    !Number.isSafeInteger(fieldValue)
  ) {
    throw new Error(`invalid config field: ${joinPath(path, field)}`);
  }
  return fieldValue;
}

function readStringArray(
  value: Record<string, unknown>,
  field: string,
  path: string
): string[] {
  const fieldValue = value[field];
  const fieldPath = joinPath(path, field);
  if (!Array.isArray(fieldValue)) {
    throw new Error(`invalid config field: ${fieldPath}`);
  }
  const array: readonly unknown[] = fieldValue;
  const result: string[] = [];
  for (let index = 0; index < array.length; index += 1) {
    const element = array[index];
    if (typeof element !== 'string') {
      throw new Error(`invalid config field: ${fieldPath}[${index}]`);
    }
    result.push(element);
  }
  return result;
}

export function generateRelayKey(options: {
  outPath: string;
  files: AdminFilePort;
  newIdentity: () => { privateKey: string; publicKey: string };
}): { publicKey: string; keyId: string } {
  if (options.files.exists(options.outPath)) {
    throw new Error('refusing to overwrite an existing file');
  }
  const identity = options.newIdentity();
  options.files.writeTextExclusive(
    options.outPath,
    identity.privateKey + '\n',
    0o600
  );
  return {
    publicKey: identity.publicKey,
    keyId: relayKeyId(identity.publicKey)
  };
}

export function parseGenesisConfig(text: string): GenesisConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid config: not valid JSON');
  }

  if (!isRecord(parsed)) {
    throw new Error('invalid config field: root');
  }

  assertNoForbiddenKeys(parsed);
  assertKnownFields(parsed, ROOT_FIELDS, '');
  assertRequiredFields(parsed, ROOT_FIELDS, '');

  const limitsValue = parsed.limits;
  if (!isRecord(limitsValue)) {
    throw new Error('invalid config field: limits');
  }
  assertNoForbiddenKeys(limitsValue);
  assertKnownFields(limitsValue, LIMIT_FIELDS, 'limits');
  assertRequiredFields(limitsValue, LIMIT_FIELDS, 'limits');

  const grantsValue = parsed.grants;
  if (!Array.isArray(grantsValue)) {
    throw new Error('invalid config field: grants');
  }
  const grantsArray: readonly unknown[] = grantsValue;
  const grants: Array<{ recipient: string; amount: number; nonce: string }> = [];
  for (let index = 0; index < grantsArray.length; index += 1) {
    const grantValue = grantsArray[index];
    const grantPath = `grants[${index}]`;
    if (!isRecord(grantValue)) {
      throw new Error(`invalid config field: ${grantPath}`);
    }
    assertNoForbiddenKeys(grantValue);
    assertKnownFields(grantValue, GRANT_FIELDS, grantPath);
    assertRequiredFields(grantValue, GRANT_FIELDS, grantPath);
    grants.push({
      recipient: readPubkey(grantValue, 'recipient', grantPath),
      amount: readNumber(grantValue, 'amount', grantPath),
      nonce: readString(grantValue, 'nonce', grantPath)
    });
  }

  return {
    policyId: readString(parsed, 'policyId', ''),
    multisigMembers: readPubkeyArray(parsed, 'multisigMembers', ''),
    inviters: readPubkeyArray(parsed, 'inviters', ''),
    genesisAccounts: readPubkeyArray(parsed, 'genesisAccounts', ''),
    checkers: readPubkeyArray(parsed, 'checkers', ''),
    issuancePolicyIds: readStringArray(parsed, 'issuancePolicyIds', ''),
    jurorPayoutPerCase: readNumber(parsed, 'jurorPayoutPerCase', ''),
    limits: {
      maxIssuancePerEvent: readNumber(
        limitsValue,
        'maxIssuancePerEvent',
        'limits'
      ),
      maxTreasurySpendPerEvent: readNumber(
        limitsValue,
        'maxTreasurySpendPerEvent',
        'limits'
      ),
      maxDealAmount: readNumber(limitsValue, 'maxDealAmount', 'limits')
    },
    treasury: readNumber(parsed, 'treasury', ''),
    grants
  };
}

export function buildGenesis(options: {
  config: GenesisConfig;
  relayPublicKey: string;
}): { text: string; sha256: string } {
  if (!isPubkey(options.relayPublicKey)) {
    throw new Error('invalid relay public key');
  }
  const policy = defaultBetaParams({
    policyId: options.config.policyId,
    multisigMembers: options.config.multisigMembers,
    inviters: options.config.inviters,
    genesisAccounts: options.config.genesisAccounts,
    checkers: options.config.checkers,
    genesisRelayKey: {
      keyId: relayKeyId(options.relayPublicKey),
      pubkey: options.relayPublicKey
    },
    issuancePolicyIds: options.config.issuancePolicyIds,
    jurorPayoutPerCase: options.config.jurorPayoutPerCase,
    limits: options.config.limits
  });

  const doc = {
    version: 1,
    relayPublicKey: options.relayPublicKey,
    policy,
    treasury: options.config.treasury,
    grants: options.config.grants
  };

  const text = JSON.stringify(doc, null, 2) + '\n';
  const sha256 = sha256Hex(text);

  try {
    loadGenesis({
      path: 'genesis.json',
      expectedSha256: sha256,
      files: { readText: () => text },
      policyDirectory: null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error('generated genesis is invalid: ' + message, { cause: error });
  }

  return { text, sha256 };
}

export function describeGenesis(options: {
  path: string;
  files: AdminFilePort;
}): {
  sha256: string;
  relayKeyId: string;
  treasury: number;
  grantCount: number;
  genesisAccountCount: number;
} {
  const text = options.files.readText(options.path);
  const sha256 = sha256Hex(text);

  try {
    loadGenesis({
      path: options.path,
      expectedSha256: sha256,
      files: { readText: () => text },
      policyDirectory: null
    });
  } catch {
    throw new Error('not a genesis file');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('not a genesis file');
  }

  if (!isRecord(parsed)) {
    throw new Error('not a genesis file');
  }

  const version = parsed.version;
  const relayPublicKey = parsed.relayPublicKey;
  const treasury = parsed.treasury;
  const grantsValue = parsed.grants;
  const policyValue = parsed.policy;

  if (
    version !== 1 ||
    typeof relayPublicKey !== 'string' ||
    typeof treasury !== 'number' ||
    !Number.isInteger(treasury) ||
    treasury < 0 ||
    !Number.isSafeInteger(treasury) ||
    !Array.isArray(grantsValue) ||
    !isRecord(policyValue)
  ) {
    throw new Error('not a genesis file');
  }

  const genesisAccountsValue = policyValue.genesisAccounts;
  const genesisRelayKeyValue = policyValue.genesisRelayKey;

  if (
    !Array.isArray(genesisAccountsValue) ||
    !isRecord(genesisRelayKeyValue)
  ) {
    throw new Error('not a genesis file');
  }

  const keyId = genesisRelayKeyValue.keyId;
  if (typeof keyId !== 'string' || keyId !== relayKeyId(relayPublicKey)) {
    throw new Error('not a genesis file');
  }

  const accounts: readonly unknown[] = genesisAccountsValue;
  for (const account of accounts) {
    if (typeof account !== 'string') {
      throw new Error('not a genesis file');
    }
  }

  return {
    sha256,
    relayKeyId: keyId,
    treasury,
    grantCount: grantsValue.length,
    genesisAccountCount: accounts.length
  };
}