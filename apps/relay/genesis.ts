// apps/relay/genesis.ts
import { relayKeyId, sha256Hex } from '../../packages/crypto/src/index.js';
import { applyIssuance, initialAccountingState } from '../../packages/domain/src/accounting.js';
import { policyParamsHash, validatePolicyParams } from '../../packages/domain/src/policy.js';
import type { PolicyDocumentSource, PolicyParams } from '../../packages/domain/src/policy.js';
import type { ProjectorConfig } from '../../packages/relay/src/projection.js';

export interface GenesisFilePort {
  readText(path: string): string;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const POLICY_HASH_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoForbiddenKeys(item);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error('forbidden genesis key');
    }
    assertNoForbiddenKeys(value[key]);
  }
}

function fieldPath(prefix: string, key: string): string {
  return prefix.length === 0 ? key : `${prefix}.${key}`;
}

function requiredField(record: Record<string, unknown>, key: string, prefix: string): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new Error(`missing genesis field: ${fieldPath(prefix, key)}`);
  }
  return record[key];
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`unknown genesis field: ${fieldPath(prefix, key)}`);
    }
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function readGenesisAccounts(policy: PolicyParams): Set<string> | null {
  const value: unknown = policy;
  if (!isRecord(value) || !Object.hasOwn(value, 'genesisAccounts')) {
    return null;
  }
  const accounts = value['genesisAccounts'];
  if (!Array.isArray(accounts)) {
    return new Set<string>();
  }
  const result = new Set<string>();
  for (const account of accounts) {
    if (typeof account === 'string') {
      result.add(account);
      continue;
    }
    if (!isRecord(account) || !Object.hasOwn(account, 'pubkey')) {
      continue;
    }
    const pubkey = account['pubkey'];
    if (typeof pubkey === 'string') {
      result.add(pubkey);
    }
  }
  return result;
}

export function loadGenesis(options: {
  path: string;
  expectedSha256: string;
  files: GenesisFilePort;
  policyDirectory: string | null;
}): ProjectorConfig {
  const text = options.files.readText(options.path);
  if (sha256Hex(text) !== options.expectedSha256) {
    throw new Error('genesis file hash mismatch');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid genesis json');
  }

  assertNoForbiddenKeys(parsed);
  if (!isRecord(parsed)) {
    throw new Error('invalid genesis root');
  }

  rejectUnknownFields(
    parsed,
    ['version', 'relayPublicKey', 'policy', 'treasury', 'grants'],
    '',
  );

  const version = requiredField(parsed, 'version', '');
  if (version !== 1) {
    throw new Error('unsupported genesis version');
  }

  const relayPublicKey = requiredField(parsed, 'relayPublicKey', '');
  if (typeof relayPublicKey !== 'string') {
    throw new Error('invalid genesis field: relayPublicKey');
  }

  const policyInput = requiredField(parsed, 'policy', '');
  const policyResult = validatePolicyParams(policyInput);
  if (!policyResult.ok) {
    throw new Error('invalid genesis policy: ' + policyResult.error.message);
  }
  const policy = policyResult.value;

  const treasury = requiredField(parsed, 'treasury', '');
  if (!isInteger(treasury)) {
    throw new Error('invalid genesis field: treasury');
  }

  const grantsInput = requiredField(parsed, 'grants', '');
  if (!Array.isArray(grantsInput)) {
    throw new Error('invalid genesis field: grants');
  }

  interface GrantInput {
    recipient: string;
    amount: number;
    nonce: string;
  }

  const grants: GrantInput[] = [];
  for (let index = 0; index < grantsInput.length; index += 1) {
    const grantPath = `grants[${index}]`;
    const grantValue: unknown = grantsInput[index];
    if (!isRecord(grantValue)) {
      throw new Error(`invalid genesis field: ${grantPath}`);
    }
    rejectUnknownFields(grantValue, ['recipient', 'amount', 'nonce'], grantPath);
    const recipient = requiredField(grantValue, 'recipient', grantPath);
    const amount = requiredField(grantValue, 'amount', grantPath);
    const nonce = requiredField(grantValue, 'nonce', grantPath);
    if (typeof recipient !== 'string') {
      throw new Error(`invalid genesis field: ${grantPath}.recipient`);
    }
    if (!isInteger(amount)) {
      throw new Error(`invalid genesis field: ${grantPath}.amount`);
    }
    if (typeof nonce !== 'string') {
      throw new Error(`invalid genesis field: ${grantPath}.nonce`);
    }
    grants.push({ recipient, amount, nonce });
  }

  const expectedKeyId = relayKeyId(relayPublicKey);
  if (
    policy.genesisRelayKey.keyId !== expectedKeyId ||
    policy.genesisRelayKey.pubkey !== relayPublicKey
  ) {
    throw new Error('genesis policy names a different relay key');
  }

  const initial = initialAccountingState({ treasury });
  if (!initial.ok) {
    throw new Error('invalid genesis treasury: ' + initial.error.message);
  }
  let accounting = initial.value;
  const allowedRecipients = readGenesisAccounts(policy);
  for (const [index, grant] of grants.entries()) {
    if (allowedRecipients !== null && !allowedRecipients.has(grant.recipient)) {
      throw new Error(`invalid genesis grant ${index}: recipient is not a genesis account`);
    }
    const applied = applyIssuance(accounting, grant);
    if (!applied.ok) {
      throw new Error(`invalid genesis grant ${index}: ${applied.error.message}`);
    }
    accounting = applied.value;
  }

  const policyDocuments: PolicyDocumentSource = {
    get(paramsHash) {
      if (options.policyDirectory === null) {
        return undefined;
      }
      const hashText = paramsHash;
      if (!POLICY_HASH_PATTERN.test(hashText)) {
        return undefined;
      }
      try {
        const path = `${options.policyDirectory}/${hashText}.json`;
        const policyText = options.files.readText(path);
        const parsedPolicy: unknown = JSON.parse(policyText);
        const result = validatePolicyParams(parsedPolicy);
        if (!result.ok) {
          return undefined;
        }
        if (policyParamsHash(result.value) !== paramsHash) {
          return undefined;
        }
        return parsedPolicy;
      } catch {
        return undefined;
      }
    },
  };

  return {
    genesisRelayKey: {
      keyId: expectedKeyId,
      pubkey: relayPublicKey,
      validFromSequence: 1,
      validToSequence: null,
    },
    genesisPolicy: policy,
    policyDocuments,
    genesisAccounting: accounting,
  };
}