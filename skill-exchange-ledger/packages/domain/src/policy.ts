/**
 * Policy registry and validation. This module verifies approvals only against the
 * supplied policy parameters; it does not verify approvals against time or state
 * outside the policy. Jury selection and reputation formulas live in jury.ts or
 * later modules.
 */

import type { Approval, Hash, PayloadMap, Pubkey, Result } from './protocol.js';
import { AMOUNT_MAX, AMOUNT_MIN, err, ok } from './protocol.js';
import type { DealPolicyView, ReceiptMeta } from './ports.js';
import type { ApprovalSource } from '../../crypto/src/index.js';
import {
  actionHash,
  approvalActionFor,
  canonical,
  hashCanonical,
  relayKeyId,
  verifyApproval,
} from '../../crypto/src/index.js';

const POLICY_ID_RE = /^[a-z0-9._-]{1,64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 365 * DAY_MS;
const MIN_LIMIT = AMOUNT_MIN;
const MAX_PUBKEY_LENGTH = 64;

export interface PolicyTier {
  readonly minDeals: number;
  readonly minCounterparties: number;
  readonly minAccountAgeDays: number;
  readonly requirePositiveBalance: boolean;
}

export interface PolicyParams {
  readonly version: number;
  readonly policyId: string;
  readonly feeBp: number;
  readonly appealFeeBp: number;
  readonly autoAcceptWindowMs: number;
  readonly disputeWindowMs: number;
  readonly appealWindowMs: number;
  readonly voteWindowMs: number;
  /** Time between a recovery-signed KeyRotated and the new key taking over; the old key is frozen meanwhile. */
  readonly keyRotationDelayMs: number;
  readonly jury: {
    readonly tiers: readonly PolicyTier[];
    readonly minPoolSizeRound0: number;
    readonly minPoolSizeRound1: number;
    /** Fixed juror pay per case in coins; 0 disables payment. */
    readonly payoutPerCase: number;
  };
  readonly reputation: {
    readonly activeWindowDays: number;
    readonly decayHalfLifeDays: number;
  };
  readonly limits: {
    readonly maxIssuancePerEvent: number;
    readonly maxTreasurySpendPerEvent: number;
    readonly maxDealAmount: number;
  };
  readonly issuance: {
    readonly allowedGrantKinds: readonly ('activity' | 'beta-grant')[];
    readonly allowedPolicyIds: readonly string[];
  };
  readonly multisig: {
    readonly members: readonly Pubkey[];
    readonly threshold: number;
  };
  readonly inviters: readonly Pubkey[];
  readonly genesisAccounts: readonly Pubkey[];
  readonly checkers: readonly Pubkey[];
  readonly genesisRelayKey: {
    readonly keyId: Hash;
    readonly pubkey: Pubkey;
  };
}

export interface PolicyEntry {
  readonly version: number;
  readonly activationSequence: number;
  readonly paramsHash: Hash;
  readonly params: PolicyParams;
}

export interface PolicyRegistry {
  readonly entries: readonly PolicyEntry[];
}

export interface PolicyDocumentSource {
  get(paramsHash: Hash): unknown;
}

export interface DefaultBetaParamsInput {
  readonly policyId: string;
  readonly multisigMembers: readonly Pubkey[];
  readonly inviters: readonly Pubkey[];
  readonly genesisAccounts: readonly Pubkey[];
  readonly checkers: readonly Pubkey[];
  readonly genesisRelayKey: {
    readonly keyId: Hash;
    readonly pubkey: Pubkey;
  };
  readonly issuancePolicyIds: readonly string[];
  readonly jurorPayoutPerCase: number;
  readonly limits: {
    readonly maxIssuancePerEvent: number;
    readonly maxTreasurySpendPerEvent: number;
    readonly maxDealAmount: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(obj, key);
}

function checkExactFields(
  obj: Record<string, unknown>,
  required: readonly string[],
  path: string,
): Result<true> {
  for (const key of required) {
    if (!hasOwn(obj, key)) {
      return err('MISSING_FIELD', `Missing field ${key}`, `${path}.${key}`);
    }
  }

  for (const key of Object.keys(obj)) {
    if (!required.includes(key)) {
      return err('UNKNOWN_FIELD', `Unknown field ${key}`, `${path}.${key}`);
    }
  }

  return ok(true);
}

function validateExactRecord(
  value: unknown,
  fields: readonly string[],
  path: string,
): Result<Record<string, unknown>> {
  if (!isRecord(value)) {
    return err('FIELD_FORMAT', `${path} must be an object`, path);
  }

  const exact = checkExactFields(value, fields, path);
  if (!exact.ok) {
    return exact;
  }

  return ok(value);
}

function readString(value: unknown, path: string): Result<string> {
  if (typeof value !== 'string') {
    return err('FIELD_FORMAT', `${path} must be a string`, path);
  }

  return ok(value);
}

function readInteger(value: unknown, path: string): Result<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return err('FIELD_FORMAT', `${path} must be a safe integer`, path);
  }

  return ok(value);
}

function readIntegerInRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
): Result<number> {
  const integer = readInteger(value, path);
  if (!integer.ok) {
    return integer;
  }

  if (integer.value < min || integer.value > max) {
    return err('LIMIT', `${path} must be between ${min} and ${max}`, path);
  }

  return integer;
}

function readPositiveInteger(value: unknown, path: string): Result<number> {
  const integer = readInteger(value, path);
  if (!integer.ok) {
    return integer;
  }

  if (integer.value <= 0) {
    return err('LIMIT', `${path} must be positive`, path);
  }

  return integer;
}

function readPositiveIntegerMax(
  value: unknown,
  path: string,
  max: number,
): Result<number> {
  const integer = readInteger(value, path);
  if (!integer.ok) {
    return integer;
  }

  if (integer.value <= 0 || integer.value > max) {
    return err('LIMIT', `${path} must be between 1 and ${max}`, path);
  }

  return integer;
}

function readNonNegativeInteger(value: unknown, path: string): Result<number> {
  const integer = readInteger(value, path);
  if (!integer.ok) {
    return integer;
  }

  if (integer.value < 0) {
    return err('LIMIT', `${path} must not be negative`, path);
  }

  return integer;
}

function isValidPubkey(value: unknown): value is Pubkey {
  if (typeof value !== 'string') {
    return false;
  }

  if (value.length === 0 || value.length > MAX_PUBKEY_LENGTH) {
    return false;
  }

  if (/\s/.test(value)) {
    return false;
  }

  return true;
}

function validatePubkeyArray(
  value: unknown,
  path: string,
  requireSorted: boolean,
): Result<readonly Pubkey[]> {
  if (!Array.isArray(value)) {
    return err('FIELD_FORMAT', `${path} must be an array`, path);
  }

  const seen = new Set<string>();
  const out: Pubkey[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];

    if (!isValidPubkey(item)) {
      return err('FIELD_FORMAT', `${path}[${i}] has invalid pubkey format`, `${path}[${i}]`);
    }

    if (seen.has(item)) {
      return err('DUPLICATE', `Duplicate value at ${path}[${i}]`, `${path}[${i}]`);
    }

    if (requireSorted && i > 0) {
      const prev = out[i - 1];
      if (prev !== undefined && !(prev < item)) {
        return err(
          'FIELD_FORMAT',
          `${path} must be strictly ascending`,
          `${path}[${i}]`,
        );
      }
    }

    seen.add(item);
    out.push(item);
  }

  return ok(out);
}

function validateGrantKinds(
  value: unknown,
  path: string,
): Result<readonly ('activity' | 'beta-grant')[]> {
  if (!Array.isArray(value)) {
    return err('FIELD_FORMAT', `${path} must be an array`, path);
  }

  if (value.length === 0) {
    return err('FIELD_FORMAT', `${path} must not be empty`, path);
  }

  const seen = new Set<string>();
  const out: ('activity' | 'beta-grant')[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];
    if (item !== 'activity' && item !== 'beta-grant') {
      return err('FIELD_FORMAT', `${path}[${i}] must be activity or beta-grant`, `${path}[${i}]`);
    }

    if (seen.has(item)) {
      return err('DUPLICATE', `Duplicate value at ${path}[${i}]`, `${path}[${i}]`);
    }

    seen.add(item);
    out.push(item);
  }

  return ok(out);
}

function validatePolicyIdArray(value: unknown, path: string): Result<readonly string[]> {
  if (!Array.isArray(value)) {
    return err('FIELD_FORMAT', `${path} must be an array`, path);
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];

    if (typeof item !== 'string' || !POLICY_ID_RE.test(item)) {
      return err('FIELD_FORMAT', `${path}[${i}] has invalid policy id`, `${path}[${i}]`);
    }

    if (seen.has(item)) {
      return err('DUPLICATE', `Duplicate value at ${path}[${i}]`, `${path}[${i}]`);
    }

    seen.add(item);
    out.push(item);
  }

  return ok(out);
}

function sameRelayKey(
  a: { readonly keyId: Hash; readonly pubkey: Pubkey },
  b: { readonly keyId: Hash; readonly pubkey: Pubkey },
): boolean {
  return a.keyId === b.keyId && a.pubkey === b.pubkey;
}

function isApproval(value: unknown): value is Approval {
  return isRecord(value) && typeof value.signer === 'string';
}

export function validatePolicyParams(input: unknown): Result<PolicyParams> {
  if (!isRecord(input)) {
    return err('FIELD_FORMAT', 'Policy params must be an object', 'params');
  }

  const fields = [
    'version',
    'policyId',
    'feeBp',
    'appealFeeBp',
    'autoAcceptWindowMs',
    'disputeWindowMs',
    'appealWindowMs',
    'voteWindowMs',
    'keyRotationDelayMs',
    'jury',
    'reputation',
    'limits',
    'issuance',
    'multisig',
    'inviters',
    'genesisAccounts',
    'checkers',
    'genesisRelayKey',
  ] as const;

  const exact = checkExactFields(input, fields, 'params');
  if (!exact.ok) {
    return exact;
  }

  const version = readInteger(input.version, 'params.version');
  if (!version.ok) {
    return version;
  }
  if (version.value < 1) {
    return err('LIMIT', 'params.version must be at least 1', 'params.version');
  }

  const policyId = input.policyId;
  if (typeof policyId !== 'string' || !POLICY_ID_RE.test(policyId)) {
    return err('FIELD_FORMAT', 'params.policyId has invalid format', 'params.policyId');
  }

  const feeBp = readIntegerInRange(input.feeBp, 'params.feeBp', 0, 10_000);
  if (!feeBp.ok) {
    return feeBp;
  }

  const appealFeeBp = readIntegerInRange(input.appealFeeBp, 'params.appealFeeBp', 0, 10_000);
  if (!appealFeeBp.ok) {
    return appealFeeBp;
  }

  const autoAcceptWindowMs = readPositiveIntegerMax(
    input.autoAcceptWindowMs,
    'params.autoAcceptWindowMs',
    MAX_WINDOW_MS,
  );
  if (!autoAcceptWindowMs.ok) {
    return autoAcceptWindowMs;
  }

  const disputeWindowMs = readPositiveIntegerMax(
    input.disputeWindowMs,
    'params.disputeWindowMs',
    MAX_WINDOW_MS,
  );
  if (!disputeWindowMs.ok) {
    return disputeWindowMs;
  }

  const appealWindowMs = readPositiveIntegerMax(
    input.appealWindowMs,
    'params.appealWindowMs',
    MAX_WINDOW_MS,
  );
  if (!appealWindowMs.ok) {
    return appealWindowMs;
  }

  const voteWindowMs = readPositiveIntegerMax(
    input.voteWindowMs,
    'params.voteWindowMs',
    MAX_WINDOW_MS,
  );
  if (!voteWindowMs.ok) {
    return voteWindowMs;
  }

  const keyRotationDelayMs = readPositiveIntegerMax(
    input.keyRotationDelayMs,
    'params.keyRotationDelayMs',
    MAX_WINDOW_MS,
  );
  if (!keyRotationDelayMs.ok) {
    return keyRotationDelayMs;
  }

  const jury = validateExactRecord(
    input.jury,
    ['tiers', 'minPoolSizeRound0', 'minPoolSizeRound1', 'payoutPerCase'],
    'params.jury',
  );
  if (!jury.ok) {
    return jury;
  }

  const tiersValue = jury.value.tiers;
  if (!Array.isArray(tiersValue) || tiersValue.length === 0) {
    return err('FIELD_FORMAT', 'params.jury.tiers must be a non-empty array', 'params.jury.tiers');
  }

  const tiers: PolicyTier[] = [];
  for (let i = 0; i < tiersValue.length; i += 1) {
    const tierPath = `params.jury.tiers[${i}]`;
    const tierRecord = validateExactRecord(
      tiersValue[i],
      ['minDeals', 'minCounterparties', 'minAccountAgeDays', 'requirePositiveBalance'],
      tierPath,
    );
    if (!tierRecord.ok) {
      return tierRecord;
    }

    const minDeals = readNonNegativeInteger(tierRecord.value.minDeals, `${tierPath}.minDeals`);
    if (!minDeals.ok) {
      return minDeals;
    }

    const minCounterparties = readNonNegativeInteger(
      tierRecord.value.minCounterparties,
      `${tierPath}.minCounterparties`,
    );
    if (!minCounterparties.ok) {
      return minCounterparties;
    }

    const minAccountAgeDays = readNonNegativeInteger(
      tierRecord.value.minAccountAgeDays,
      `${tierPath}.minAccountAgeDays`,
    );
    if (!minAccountAgeDays.ok) {
      return minAccountAgeDays;
    }

    const requirePositiveBalance = tierRecord.value.requirePositiveBalance;
    if (typeof requirePositiveBalance !== 'boolean') {
      return err(
        'FIELD_FORMAT',
        `${tierPath}.requirePositiveBalance must be a boolean`,
        `${tierPath}.requirePositiveBalance`,
      );
    }

    if (i > 0) {
      const previous = tiers[i - 1];
      if (previous !== undefined) {
        if (minDeals.value > previous.minDeals) {
          return err(
            'FIELD_FORMAT',
            `${tierPath}.minDeals must not be stricter than the previous tier`,
            `${tierPath}.minDeals`,
          );
        }

        if (minCounterparties.value > previous.minCounterparties) {
          return err(
            'FIELD_FORMAT',
            `${tierPath}.minCounterparties must not be stricter than the previous tier`,
            `${tierPath}.minCounterparties`,
          );
        }

        if (minAccountAgeDays.value > previous.minAccountAgeDays) {
          return err(
            'FIELD_FORMAT',
            `${tierPath}.minAccountAgeDays must not be stricter than the previous tier`,
            `${tierPath}.minAccountAgeDays`,
          );
        }

        if (!previous.requirePositiveBalance && requirePositiveBalance) {
          return err(
            'FIELD_FORMAT',
            `${tierPath}.requirePositiveBalance must not be stricter than the previous tier`,
            `${tierPath}.requirePositiveBalance`,
          );
        }
      }
    }

    tiers.push({
      minDeals: minDeals.value,
      minCounterparties: minCounterparties.value,
      minAccountAgeDays: minAccountAgeDays.value,
      requirePositiveBalance,
    });
  }

  const minPoolSizeRound0 = readInteger(
    jury.value.minPoolSizeRound0,
    'params.jury.minPoolSizeRound0',
  );
  if (!minPoolSizeRound0.ok) {
    return minPoolSizeRound0;
  }
  if (minPoolSizeRound0.value < 3) {
    return err(
      'LIMIT',
      'params.jury.minPoolSizeRound0 must be at least 3',
      'params.jury.minPoolSizeRound0',
    );
  }

  const minPoolSizeRound1 = readInteger(
    jury.value.minPoolSizeRound1,
    'params.jury.minPoolSizeRound1',
  );
  if (!minPoolSizeRound1.ok) {
    return minPoolSizeRound1;
  }
  if (minPoolSizeRound1.value < 5) {
    return err(
      'LIMIT',
      'params.jury.minPoolSizeRound1 must be at least 5',
      'params.jury.minPoolSizeRound1',
    );
  }

  const payoutPerCase = readIntegerInRange(
    jury.value.payoutPerCase,
    'params.jury.payoutPerCase',
    0,
    AMOUNT_MAX,
  );
  if (!payoutPerCase.ok) {
    return payoutPerCase;
  }

  const reputation = validateExactRecord(
    input.reputation,
    ['activeWindowDays', 'decayHalfLifeDays'],
    'params.reputation',
  );
  if (!reputation.ok) {
    return reputation;
  }

  const activeWindowDays = readPositiveInteger(
    reputation.value.activeWindowDays,
    'params.reputation.activeWindowDays',
  );
  if (!activeWindowDays.ok) {
    return activeWindowDays;
  }

  const decayHalfLifeDays = readPositiveInteger(
    reputation.value.decayHalfLifeDays,
    'params.reputation.decayHalfLifeDays',
  );
  if (!decayHalfLifeDays.ok) {
    return decayHalfLifeDays;
  }

  const limits = validateExactRecord(
    input.limits,
    ['maxIssuancePerEvent', 'maxTreasurySpendPerEvent', 'maxDealAmount'],
    'params.limits',
  );
  if (!limits.ok) {
    return limits;
  }

  const maxIssuancePerEvent = readIntegerInRange(
    limits.value.maxIssuancePerEvent,
    'params.limits.maxIssuancePerEvent',
    MIN_LIMIT,
    AMOUNT_MAX,
  );
  if (!maxIssuancePerEvent.ok) {
    return maxIssuancePerEvent;
  }

  const maxTreasurySpendPerEvent = readIntegerInRange(
    limits.value.maxTreasurySpendPerEvent,
    'params.limits.maxTreasurySpendPerEvent',
    MIN_LIMIT,
    AMOUNT_MAX,
  );
  if (!maxTreasurySpendPerEvent.ok) {
    return maxTreasurySpendPerEvent;
  }

  const maxDealAmount = readIntegerInRange(
    limits.value.maxDealAmount,
    'params.limits.maxDealAmount',
    MIN_LIMIT,
    AMOUNT_MAX,
  );
  if (!maxDealAmount.ok) {
    return maxDealAmount;
  }

  const issuance = validateExactRecord(
    input.issuance,
    ['allowedGrantKinds', 'allowedPolicyIds'],
    'params.issuance',
  );
  if (!issuance.ok) {
    return issuance;
  }

  const allowedGrantKinds = validateGrantKinds(
    issuance.value.allowedGrantKinds,
    'params.issuance.allowedGrantKinds',
  );
  if (!allowedGrantKinds.ok) {
    return allowedGrantKinds;
  }

  const allowedPolicyIds = validatePolicyIdArray(
    issuance.value.allowedPolicyIds,
    'params.issuance.allowedPolicyIds',
  );
  if (!allowedPolicyIds.ok) {
    return allowedPolicyIds;
  }

  const multisig = validateExactRecord(
    input.multisig,
    ['members', 'threshold'],
    'params.multisig',
  );
  if (!multisig.ok) {
    return multisig;
  }

  const members = validatePubkeyArray(
    multisig.value.members,
    'params.multisig.members',
    false,
  );
  if (!members.ok) {
    return members;
  }

  if (members.value.length < 2 || members.value.length > 3) {
    return err(
      'LIMIT',
      'params.multisig.members must contain 2 to 3 entries',
      'params.multisig.members',
    );
  }

  const threshold = readInteger(multisig.value.threshold, 'params.multisig.threshold');
  if (!threshold.ok) {
    return threshold;
  }

  if (threshold.value < 2 || threshold.value > members.value.length) {
    return err(
      'LIMIT',
      'params.multisig.threshold must be at least 2 and at most members.length',
      'params.multisig.threshold',
    );
  }

  const inviters = validatePubkeyArray(input.inviters, 'params.inviters', true);
  if (!inviters.ok) {
    return inviters;
  }

  const genesisAccounts = validatePubkeyArray(
    input.genesisAccounts,
    'params.genesisAccounts',
    true,
  );
  if (!genesisAccounts.ok) {
    return genesisAccounts;
  }

  const checkers = validatePubkeyArray(input.checkers, 'params.checkers', true);
  if (!checkers.ok) {
    return checkers;
  }

  const genesisRelayKey = validateExactRecord(
    input.genesisRelayKey,
    ['keyId', 'pubkey'],
    'params.genesisRelayKey',
  );
  if (!genesisRelayKey.ok) {
    return genesisRelayKey;
  }

  const keyId = readString(genesisRelayKey.value.keyId, 'params.genesisRelayKey.keyId');
  if (!keyId.ok) {
    return keyId;
  }

  const relayPubkey = readString(
    genesisRelayKey.value.pubkey,
    'params.genesisRelayKey.pubkey',
  );
  if (!relayPubkey.ok) {
    return relayPubkey;
  }

  if (keyId.value !== relayKeyId(relayPubkey.value)) {
    return err(
      'FIELD_FORMAT',
      'params.genesisRelayKey.keyId must equal relayKeyId(pubkey)',
      'params.genesisRelayKey.keyId',
    );
  }

  return ok({
    version: version.value,
    policyId,
    feeBp: feeBp.value,
    appealFeeBp: appealFeeBp.value,
    autoAcceptWindowMs: autoAcceptWindowMs.value,
    disputeWindowMs: disputeWindowMs.value,
    appealWindowMs: appealWindowMs.value,
    voteWindowMs: voteWindowMs.value,
    keyRotationDelayMs: keyRotationDelayMs.value,
    jury: {
      tiers,
      minPoolSizeRound0: minPoolSizeRound0.value,
      minPoolSizeRound1: minPoolSizeRound1.value,
      payoutPerCase: payoutPerCase.value,
    },
    reputation: {
      activeWindowDays: activeWindowDays.value,
      decayHalfLifeDays: decayHalfLifeDays.value,
    },
    limits: {
      maxIssuancePerEvent: maxIssuancePerEvent.value,
      maxTreasurySpendPerEvent: maxTreasurySpendPerEvent.value,
      maxDealAmount: maxDealAmount.value,
    },
    issuance: {
      allowedGrantKinds: allowedGrantKinds.value,
      allowedPolicyIds: allowedPolicyIds.value,
    },
    multisig: {
      members: members.value,
      threshold: threshold.value,
    },
    inviters: inviters.value,
    genesisAccounts: genesisAccounts.value,
    checkers: checkers.value,
    genesisRelayKey: {
      keyId: keyId.value,
      pubkey: relayPubkey.value,
    },
  });
}

export function policyParamsHash(params: PolicyParams): Hash {
  return hashCanonical(params);
}

export function genesisPolicyRegistry(params: unknown): Result<PolicyRegistry> {
  const validated = validatePolicyParams(params);
  if (!validated.ok) {
    return validated;
  }

  if (validated.value.version !== 1) {
    return err('POLICY', 'Genesis policy must have version 1', 'params.version');
  }

  const entry: PolicyEntry = {
    version: 1,
    activationSequence: 1,
    paramsHash: policyParamsHash(validated.value),
    params: validated.value,
  };

  return ok({ entries: [entry] });
}

export function resolvePolicy(
  registry: PolicyRegistry,
  sequence: number,
): Result<PolicyEntry> {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    return err('POLICY', 'Sequence must be a positive integer', 'sequence');
  }

  let best: PolicyEntry | undefined;

  for (const entry of registry.entries) {
    if (entry.activationSequence <= sequence) {
      if (best === undefined || entry.activationSequence > best.activationSequence) {
        best = entry;
      }
    }
  }

  if (best === undefined) {
    return err('POLICY', 'No policy is active at the requested sequence', 'sequence');
  }

  return ok(best);
}

export function applyPolicyUpdated(
  registry: PolicyRegistry,
  payload: PayloadMap['PolicyUpdated'],
  signer: Pubkey,
  meta: ReceiptMeta,
  documents: PolicyDocumentSource,
): Result<PolicyRegistry> {
  const policyVersion = readInteger(payload.policy_version, 'payload.policy_version');
  if (!policyVersion.ok) {
    return policyVersion;
  }

  if (registry.entries.some((entry) => entry.version === policyVersion.value)) {
    return err('REPLAY', 'Policy version already exists', 'payload.policy_version');
  }

  let highestVersion = 0;
  for (const entry of registry.entries) {
    highestVersion = Math.max(highestVersion, entry.version);
  }

  if (policyVersion.value <= highestVersion) {
    return err(
      'POLICY',
      'Policy version must be strictly greater than the highest existing version',
      'payload.policy_version',
    );
  }

  const activationSequence = readInteger(
    payload.activation_sequence,
    'payload.activation_sequence',
  );
  if (!activationSequence.ok) {
    return activationSequence;
  }

  if (activationSequence.value <= meta.sequence) {
    return err(
      'WINDOW',
      'Activation sequence must be strictly greater than the receipt sequence',
      'payload.activation_sequence',
    );
  }

  for (const entry of registry.entries) {
    if (activationSequence.value <= entry.activationSequence) {
      return err(
        'WINDOW',
        'Activation sequence must be strictly greater than every existing activation sequence',
        'payload.activation_sequence',
      );
    }
  }

  const paramsHash = readString(payload.params_hash, 'payload.params_hash');
  if (!paramsHash.ok) {
    return paramsHash;
  }

  const document = documents.get(paramsHash.value);
  if (document === undefined) {
    return err('POLICY', 'Policy document not found', 'payload.params_hash');
  }

  const validatedDocument = validatePolicyParams(document);
  if (!validatedDocument.ok) {
    return validatedDocument;
  }

  const documentParams = validatedDocument.value;

  if (policyParamsHash(documentParams) !== paramsHash.value) {
    return err('FIELD_FORMAT', 'Policy document hash mismatch', 'payload.params_hash');
  }

  if (documentParams.version !== policyVersion.value) {
    return err('POLICY', 'Policy document version mismatch', 'payload.policy_version');
  }

  const genesisEntry = registry.entries.find((entry) => entry.version === 1);
  if (genesisEntry === undefined) {
    return err('POLICY', 'Genesis policy entry is missing', 'registry.entries');
  }

  if (!sameRelayKey(documentParams.genesisRelayKey, genesisEntry.params.genesisRelayKey)) {
    return err(
      'POLICY',
      'Genesis relay key pin must not change',
      'params.genesisRelayKey',
    );
  }

  const active = resolvePolicy(registry, meta.sequence);
  if (!active.ok) {
    return active;
  }

  const source: ApprovalSource = { type: 'PolicyUpdated', payload };
  const approvals = verifyApprovals(active.value.params, source, signer);
  if (!approvals.ok) {
    return approvals;
  }

  const entry: PolicyEntry = {
    version: policyVersion.value,
    activationSequence: activationSequence.value,
    paramsHash: paramsHash.value,
    params: documentParams,
  };

  const entries = [...registry.entries, entry].sort(
    (a, b) => a.activationSequence - b.activationSequence,
  );

  return ok({ entries });
}

export function verifyApprovals(
  params: PolicyParams,
  source: ApprovalSource,
  signer: Pubkey,
): Result<true> {
  const payload: unknown = source.payload;
  if (!isRecord(payload)) {
    return err('FIELD_FORMAT', 'Approval source payload must be an object', 'payload');
  }

  const approvalsValue = payload.approvals;
  if (!Array.isArray(approvalsValue)) {
    return err('MISSING_FIELD', 'Missing approvals', 'payload.approvals');
  }

  if (approvalsValue.length < 2 || approvalsValue.length > 3) {
    return err('LIMIT', 'Approvals must contain 2 to 3 entries', 'payload.approvals');
  }

  let action: Hash;
  try {
    action = actionHash(approvalActionFor(source));
  } catch {
    return err('PAYLOAD', 'Approval action cannot be canonicalized', 'payload');
  }

  const members = params.multisig.members;
  const seen = new Set<string>();
  const validSigners: Pubkey[] = [];

  for (let i = 0; i < approvalsValue.length; i += 1) {
    const item: unknown = approvalsValue[i];
    if (!isApproval(item)) {
      return err('ATTESTATION', 'Malformed approval', `payload.approvals[${i}]`);
    }

    const approver = item.signer;

    if (!members.includes(approver)) {
      return err(
        'SIGNER_AUTHORITY',
        'Approver is not a multisig member',
        `payload.approvals[${i}].signer`,
      );
    }

    if (seen.has(approver)) {
      return err(
        'SIGNER_AUTHORITY',
        'Duplicate approver',
        `payload.approvals[${i}].signer`,
      );
    }

    seen.add(approver);

    let valid: boolean;
    try {
      valid = verifyApproval(action, item);
    } catch {
      return err(
        'PAYLOAD',
        'Approval cannot be verified',
        `payload.approvals[${i}]`,
      );
    }

    if (!valid) {
      return err('ATTESTATION', 'Invalid approval signature', `payload.approvals[${i}]`);
    }

    validSigners.push(approver);
  }

  if (validSigners.length < params.multisig.threshold) {
    return err('LIMIT', 'Not enough valid approvals', 'payload.approvals');
  }

  if (!validSigners.includes(signer)) {
    return err('SIGNER_AUTHORITY', 'Event signer is not a valid approver', 'signer');
  }

  return ok(true);
}

export function checkIssuance(
  params: PolicyParams,
  payload: PayloadMap['CurrencyIssued'],
): Result<true> {
  const policyId = payload.policy_id;

  if (!params.issuance.allowedPolicyIds.includes(policyId)) {
    return err('POLICY', 'Issuance policy is not allowed', 'payload.policy_id');
  }

  const grantKind = payload.grant_kind;
  if (grantKind !== 'activity' && grantKind !== 'beta-grant') {
    return err('POLICY', 'Grant kind is not allowed', 'payload.grant_kind');
  }

  if (!params.issuance.allowedGrantKinds.includes(grantKind)) {
    return err('POLICY', 'Grant kind is not allowed', 'payload.grant_kind');
  }

  const amount = readInteger(payload.amount, 'payload.amount');
  if (!amount.ok) {
    return amount;
  }

  if (amount.value > params.limits.maxIssuancePerEvent) {
    return err('LIMIT', 'Issuance amount exceeds policy limit', 'payload.amount');
  }

  return ok(true);
}

export function checkTreasurySpend(
  params: PolicyParams,
  payload: PayloadMap['TreasurySpend'],
): Result<true> {
  const amount = readInteger(payload.amount, 'payload.amount');
  if (!amount.ok) {
    return amount;
  }

  if (amount.value > params.limits.maxTreasurySpendPerEvent) {
    return err('LIMIT', 'Treasury spend amount exceeds policy limit', 'payload.amount');
  }

  return ok(true);
}

export function isActiveInviter(params: PolicyParams, pubkey: Pubkey): boolean {
  return params.inviters.includes(pubkey);
}

export function isGenesisAccount(params: PolicyParams, pubkey: Pubkey): boolean {
  return params.genesisAccounts.includes(pubkey);
}

export function isListedChecker(params: PolicyParams, pubkey: Pubkey): boolean {
  return params.checkers.includes(pubkey);
}

export function dealPolicyView(params: PolicyParams): DealPolicyView {
  return {
    feeBp: params.feeBp,
    appealFeeBp: params.appealFeeBp,
    autoAcceptWindowMs: params.autoAcceptWindowMs,
    disputeWindowMs: params.disputeWindowMs,
    appealWindowMs: params.appealWindowMs,
    voteWindowMs: params.voteWindowMs,
    jurorPayoutAmount: params.jury.payoutPerCase,
    isEffectiveChecker: (pubkey: Pubkey) => isListedChecker(params, pubkey),
  };
}

export function canonicalizePolicyRegistry(registry: PolicyRegistry): Result<string> {
  const entries = [...registry.entries].sort(
    (a, b) => a.activationSequence - b.activationSequence,
  );

  try {
    return ok(canonical({ entries }));
  } catch {
    return err('PAYLOAD', 'Policy registry cannot be canonicalized', 'registry');
  }
}

export function defaultBetaParams(input: DefaultBetaParamsInput): PolicyParams {
  return {
    version: 1,
    policyId: input.policyId,
    feeBp: 100,
    appealFeeBp: 1000,
    autoAcceptWindowMs: 7 * DAY_MS,
    disputeWindowMs: 7 * DAY_MS,
    appealWindowMs: 3 * DAY_MS,
    voteWindowMs: 3 * DAY_MS,
    keyRotationDelayMs: 3 * DAY_MS,
    jury: {
      tiers: [
        {
          minDeals: 20,
          minCounterparties: 5,
          minAccountAgeDays: 60,
          requirePositiveBalance: true,
        },
      ],
      minPoolSizeRound0: 3,
      minPoolSizeRound1: 5,
      payoutPerCase: input.jurorPayoutPerCase,
    },
    reputation: {
      activeWindowDays: 30,
      decayHalfLifeDays: 180,
    },
    limits: {
      maxIssuancePerEvent: input.limits.maxIssuancePerEvent,
      maxTreasurySpendPerEvent: input.limits.maxTreasurySpendPerEvent,
      maxDealAmount: input.limits.maxDealAmount,
    },
    issuance: {
      allowedGrantKinds: ['activity', 'beta-grant'],
      allowedPolicyIds: [...input.issuancePolicyIds],
    },
    multisig: {
      members: [...input.multisigMembers],
      threshold: 2,
    },
    inviters: [...input.inviters].sort(),
    genesisAccounts: [...input.genesisAccounts].sort(),
    checkers: [...input.checkers].sort(),
    genesisRelayKey: {
      keyId: input.genesisRelayKey.keyId,
      pubkey: input.genesisRelayKey.pubkey,
    },
  };
}