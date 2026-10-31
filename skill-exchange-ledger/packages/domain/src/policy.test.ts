import test from 'node:test';
import assert from 'node:assert/strict';

import { AMOUNT_MAX } from './protocol.js';
import type { Approval, Hash, PayloadMap, Result } from './protocol.js';
import type { ApprovalSource } from '../../crypto/src/index.js';
import {
  actionHash,
  approvalActionFor,
  createIdentity,
  hashCanonical,
  relayKeyId,
  signApproval,
} from '../../crypto/src/index.js';
import type { DealPolicyView } from './ports.js';
import {
  applyPolicyUpdated,
  canonicalizePolicyRegistry,
  checkIssuance,
  checkTreasurySpend,
  dealPolicyView,
  defaultBetaParams,
  genesisPolicyRegistry,
  isActiveInviter,
  isGenesisAccount,
  isListedChecker,
  policyParamsHash,
  resolvePolicy,
  validatePolicyParams,
  verifyApprovals,
} from './policy.js';
import type { PolicyParams, PolicyRegistry } from './policy.js';

type Identity = ReturnType<typeof createIdentity>;

const ISO_DATE = '2026-01-01T00:00:00.000Z';

const member1 = createIdentity();
const member2 = createIdentity();
const member3 = createIdentity();
const outsider = createIdentity();

function assertOk<T>(result: Result<T>): T {
  if (!result.ok) {
    assert.fail(`Expected ok, got ${result.error.code}: ${result.error.message}`);
  }

  return result.value;
}

function assertError<T>(result: Result<T>, code: string, path?: string): void {
  if (result.ok) {
    assert.fail(`Expected error ${code}`);
  }

  assert.equal(result.error.code, code);

  if (path !== undefined) {
    assert.equal(typeof result.error.path, 'string');
    assert.ok(
      result.error.path.includes(path),
      `expected path to contain ${path}, got ${result.error.path}`,
    );
  }
}

function makeBetaParams(): PolicyParams {
  const relay = createIdentity();

  return defaultBetaParams({
    policyId: 'beta.policy',
    multisigMembers: [member1.publicKey, member2.publicKey, member3.publicKey],
    inviters: [member1.publicKey, member2.publicKey],
    genesisAccounts: [member1.publicKey],
    checkers: [member1.publicKey, member3.publicKey],
    genesisRelayKey: {
      keyId: relayKeyId(relay.publicKey),
      pubkey: relay.publicKey,
    },
    issuancePolicyIds: ['beta.policy'],
    jurorPayoutPerCase: 10,
    limits: {
      maxIssuancePerEvent: 1000,
      maxTreasurySpendPerEvent: 1000,
      maxDealAmount: 1000,
    },
  });
}

function makeSource(type: ApprovalSource['type'], payload: unknown): ApprovalSource {
  return { type, payload } as ApprovalSource;
}

function approve(source: ApprovalSource, identity: Identity): Approval {
  return signApproval(
    actionHash(approvalActionFor(source)),
    identity.publicKey,
    identity.privateKey,
  );
}

function approvalsFor(
  type: ApprovalSource['type'],
  basePayload: unknown,
  signers: readonly Identity[],
): Approval[] {
  const source = makeSource(type, basePayload);
  return signers.map((identity) => approve(source, identity));
}

function policyUpdatedPayload(
  basePayload: Omit<PayloadMap['PolicyUpdated'], 'approvals'>,
  signers: readonly Identity[],
): PayloadMap['PolicyUpdated'] {
  const approvals = approvalsFor('PolicyUpdated', basePayload, signers);

  return {
    ...basePayload,
    approvals,
  };
}

function registryWithV2(): PolicyRegistry {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v2: PolicyParams = {
    ...base,
    version: 2,
    policyId: 'beta.policy.v2',
    feeBp: 200,
  };

  const paramsHash = policyParamsHash(v2);
  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v2);

  const basePayload = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const payload = policyUpdatedPayload(basePayload, [member1, member2]);

  return assertOk(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    const record = value as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      const child = record[key];
      if (child !== null && typeof child === 'object') {
        deepFreeze(child);
      }
    }
  }

  return value;
}

test('genesisPolicyRegistry accepts a valid version 1 document', () => {
  const params = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(params));

  assert.equal(registry.entries.length, 1);

  const entry = registry.entries[0];
  assert.ok(entry);
  assert.equal(entry.version, 1);
  assert.equal(entry.activationSequence, 1);
  assert.equal(entry.paramsHash, policyParamsHash(params));
});

test('genesisPolicyRegistry rejects missing genesisRelayKey', () => {
  const params = makeBetaParams();
  const { genesisRelayKey: _genesisRelayKey, ...withoutGenesisRelayKey } = params;

  assertError(
    genesisPolicyRegistry(withoutGenesisRelayKey),
    'MISSING_FIELD',
    'params.genesisRelayKey',
  );
});

test('genesisPolicyRegistry rejects mismatched relay key id', () => {
  const params = makeBetaParams();
  const invalid = {
    ...params,
    genesisRelayKey: {
      ...params.genesisRelayKey,
      keyId: hashCanonical({ wrong: true }),
    },
  };

  assertError(genesisPolicyRegistry(invalid), 'FIELD_FORMAT', 'params.genesisRelayKey.keyId');
});

test('genesisPolicyRegistry rejects version 2', () => {
  const params = { ...makeBetaParams(), version: 2 };
  assertError(genesisPolicyRegistry(params), 'POLICY', 'params.version');
});

test('genesisPolicyRegistry rejects unknown fields', () => {
  const params = { ...makeBetaParams(), extra: true };
  assertError(genesisPolicyRegistry(params), 'UNKNOWN_FIELD', 'params.extra');
});

test('genesis paramsHash equals hash of published document', () => {
  const doc = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(doc));
  const entry = registry.entries[0];
  assert.ok(entry);
  assert.equal(entry.paramsHash, policyParamsHash(doc));
});

test('defaultBetaParams sorts pubkey lists', () => {
  const params = makeBetaParams();

  const inviters = [...params.inviters];
  assert.deepEqual(inviters, [...inviters].sort());

  const genesisAccounts = [...params.genesisAccounts];
  assert.deepEqual(genesisAccounts, [...genesisAccounts].sort());

  const checkers = [...params.checkers];
  assert.deepEqual(checkers, [...checkers].sort());
});

test('validatePolicyParams rejects unsorted pubkey arrays', () => {
  const base = makeBetaParams();
  const checkers = base.checkers;
  assert.ok(checkers.length >= 2);

  const reversed = [...checkers].reverse();
  assert.notEqual(checkers[0], reversed[0]);

  const unsorted = { ...base, checkers: reversed };
  assertError(validatePolicyParams(unsorted), 'FIELD_FORMAT', 'params.checkers');
});

test('resolvePolicy selects the greatest activation sequence not above the input', () => {
  const registry = registryWithV2();

  assert.equal(assertOk(resolvePolicy(registry, 1)).version, 1);
  assert.equal(assertOk(resolvePolicy(registry, 5)).version, 1);
  assert.equal(assertOk(resolvePolicy(registry, 99)).version, 1);
  assert.equal(assertOk(resolvePolicy(registry, 100)).version, 2);
  assert.equal(assertOk(resolvePolicy(registry, 101)).version, 2);
});

test('resolvePolicy rejects invalid sequences', () => {
  const registry = registryWithV2();

  assertError(resolvePolicy(registry, 0), 'POLICY', 'sequence');
  assertError(resolvePolicy(registry, -1), 'POLICY', 'sequence');
  assertError(resolvePolicy(registry, 1.5), 'POLICY', 'sequence');
});

test('applyPolicyUpdated adds a new policy after valid approvals', () => {
  const registry = registryWithV2();

  assert.equal(registry.entries.length, 2);

  const entry = registry.entries[1];
  assert.ok(entry);
  assert.equal(entry.version, 2);
  assert.equal(entry.activationSequence, 100);
});

test('applyPolicyUpdated rejects duplicate policy versions', () => {
  const registry = registryWithV2();
  const base = makeBetaParams();

  const v2 = { ...base, version: 2, policyId: 'beta.policy.v2' };
  const paramsHash = policyParamsHash(v2);

  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v2);

  const basePayload = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 200,
  };

  const payload = policyUpdatedPayload(basePayload, [member1, member2]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 150, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'REPLAY',
    'payload.policy_version',
  );
});

test('applyPolicyUpdated rejects a version that is not strictly greater', () => {
  const registry = assertOk(genesisPolicyRegistry(makeBetaParams()));

  const basePayload = {
    policy_version: 0,
    params_hash: hashCanonical({ unrelated: true }),
    activation_sequence: 100,
  };

  const payload = policyUpdatedPayload(basePayload, [member1, member2]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: () => undefined },
    ),
    'POLICY',
    'payload.policy_version',
  );
});

test('applyPolicyUpdated rejects activation sequence at or below receipt sequence', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v2 = { ...base, version: 2, policyId: 'beta.policy.v2' };
  const paramsHash = policyParamsHash(v2);

  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v2);

  const basePayload = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 50,
  };

  const payload = policyUpdatedPayload(basePayload, [member1, member2]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'WINDOW',
    'payload.activation_sequence',
  );
});

test('applyPolicyUpdated rejects activation sequence not above existing activations', () => {
  const registry = registryWithV2();
  const v1 = assertOk(resolvePolicy(registry, 1)).params;

  const v3 = { ...v1, version: 3, policyId: 'beta.policy.v3' };
  const paramsHash = policyParamsHash(v3);

  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v3);

  const basePayload = {
    policy_version: 3,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const payload = policyUpdatedPayload(basePayload, [member1, member2]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 150, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'WINDOW',
    'payload.activation_sequence',
  );
});

test('applyPolicyUpdated rejects a missing policy document', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v2 = { ...base, version: 2, policyId: 'beta.policy.v2' };
  const paramsHash = policyParamsHash(v2);

  const basePayload = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const payload = policyUpdatedPayload(basePayload, [member1, member2]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: () => undefined },
    ),
    'POLICY',
    'payload.params_hash',
  );
});

test('applyPolicyUpdated rejects document hash mismatch', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v2 = { ...base, version: 2, policyId: 'beta.policy.v2' };
  const otherHash = hashCanonical({ other: true });

  const documents = new Map<Hash, unknown>();
  documents.set(otherHash, v2);

  const basePayload = {
    policy_version: 2,
    params_hash: otherHash,
    activation_sequence: 100,
  };

  const payload = policyUpdatedPayload(basePayload, [member1, member2]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'FIELD_FORMAT',
    'payload.params_hash',
  );
});

test('applyPolicyUpdated rejects document version mismatch', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v3 = { ...base, version: 3, policyId: 'beta.policy.v3' };
  const paramsHash = policyParamsHash(v3);

  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v3);

  const basePayload = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const payload = policyUpdatedPayload(basePayload, [member1, member2]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'POLICY',
    'payload.policy_version',
  );
});

test('applyPolicyUpdated rejects a changed genesis relay key pin', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));
  const newRelay = createIdentity();

  const v2 = {
    ...base,
    version: 2,
    policyId: 'beta.policy.v2',
    genesisRelayKey: {
      keyId: relayKeyId(newRelay.publicKey),
      pubkey: newRelay.publicKey,
    },
  };

  const paramsHash = policyParamsHash(v2);
  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v2);

  const basePayload = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const payload = policyUpdatedPayload(basePayload, [member1, member2]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'POLICY',
    'params.genesisRelayKey',
  );
});

test('applyPolicyUpdated rejects too few approvals', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v2 = { ...base, version: 2, policyId: 'beta.policy.v2' };
  const paramsHash = policyParamsHash(v2);

  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v2);

  const basePayload = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const payload = policyUpdatedPayload(basePayload, [member1]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'LIMIT',
    'payload.approvals',
  );
});

test('applyPolicyUpdated rejects duplicate approvers', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v2 = { ...base, version: 2, policyId: 'beta.policy.v2' };
  const paramsHash = policyParamsHash(v2);

  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v2);

  const basePayload: Omit<PayloadMap['PolicyUpdated'], 'approvals'> = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const source = makeSource('PolicyUpdated', basePayload);
  const approvals = [approve(source, member1), approve(source, member1)];
  const payload = {
    ...basePayload,
    approvals,
  };

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'SIGNER_AUTHORITY',
    'payload.approvals[1].signer',
  );
});

test('applyPolicyUpdated rejects an outsider approver', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v2 = { ...base, version: 2, policyId: 'beta.policy.v2' };
  const paramsHash = policyParamsHash(v2);

  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v2);

  const basePayload: Omit<PayloadMap['PolicyUpdated'], 'approvals'> = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const source = makeSource('PolicyUpdated', basePayload);
  const approvals = [approve(source, member1), approve(source, outsider)];
  const payload = {
    ...basePayload,
    approvals,
  };

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'SIGNER_AUTHORITY',
    'payload.approvals[1].signer',
  );
});

test('applyPolicyUpdated rejects an approval over a different action', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v2 = { ...base, version: 2, policyId: 'beta.policy.v2' };
  const paramsHash = policyParamsHash(v2);

  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v2);

  const basePayload: Omit<PayloadMap['PolicyUpdated'], 'approvals'> = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const source = makeSource('PolicyUpdated', basePayload);
  const wrongSource = makeSource('PolicyUpdated', {
    ...basePayload,
    activation_sequence: 999,
  });
  const approvals = [approve(wrongSource, member1), approve(source, member2)];
  const payload = {
    ...basePayload,
    approvals,
  };

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'ATTESTATION',
    'payload.approvals[0]',
  );
});

test('applyPolicyUpdated rejects an event signer who did not approve', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v2 = { ...base, version: 2, policyId: 'beta.policy.v2' };
  const paramsHash = policyParamsHash(v2);

  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v2);

  const basePayload = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const payload = policyUpdatedPayload(basePayload, [member1, member2]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      member3.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'SIGNER_AUTHORITY',
    'signer',
  );
});

test('applyPolicyUpdated does not let the new policy self-confirm', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));
  const newMember1 = createIdentity();
  const newMember2 = createIdentity();

  const v2 = {
    ...base,
    version: 2,
    policyId: 'beta.policy.v2',
    multisig: {
      members: [newMember1.publicKey, newMember2.publicKey],
      threshold: 2,
    },
  };

  const paramsHash = policyParamsHash(v2);
  const documents = new Map<Hash, unknown>();
  documents.set(paramsHash, v2);

  const basePayload = {
    policy_version: 2,
    params_hash: paramsHash,
    activation_sequence: 100,
  };

  const payload = policyUpdatedPayload(basePayload, [newMember1, newMember2]);

  assertError(
    applyPolicyUpdated(
      registry,
      payload,
      newMember1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => documents.get(hash) },
    ),
    'SIGNER_AUTHORITY',
    'payload.approvals[0].signer',
  );
});

test('policy updates are approved by the policy active at the receipt sequence', () => {
  const base = makeBetaParams();
  const registry = assertOk(genesisPolicyRegistry(base));

  const v2Member1 = createIdentity();
  const v2Member2 = createIdentity();

  const v2 = {
    ...base,
    version: 2,
    policyId: 'beta.policy.v2',
    multisig: {
      members: [v2Member1.publicKey, v2Member2.publicKey],
      threshold: 2,
    },
  };
  const v2Hash = policyParamsHash(v2);
  const v2Docs = new Map<Hash, unknown>();
  v2Docs.set(v2Hash, v2);
  const v2BasePayload = {
    policy_version: 2,
    params_hash: v2Hash,
    activation_sequence: 100,
  };
  const v2Payload = policyUpdatedPayload(v2BasePayload, [member1, member2]);
  const registry2 = assertOk(
    applyPolicyUpdated(
      registry,
      v2Payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => v2Docs.get(hash) },
    ),
  );

  const v3 = { ...base, version: 3, policyId: 'beta.policy.v3' };
  const v3Hash = policyParamsHash(v3);
  const v3Docs = new Map<Hash, unknown>();
  v3Docs.set(v3Hash, v3);
  const v3BasePayload = {
    policy_version: 3,
    params_hash: v3Hash,
    activation_sequence: 200,
  };
  const v3Payload = policyUpdatedPayload(v3BasePayload, [member1, member2]);
  assert.ok(
    applyPolicyUpdated(
      registry2,
      v3Payload,
      member1.publicKey,
      { sequence: 50, acceptedAt: ISO_DATE },
      { get: (hash) => v3Docs.get(hash) },
    ).ok,
  );

  const v4 = { ...base, version: 4, policyId: 'beta.policy.v4' };
  const v4Hash = policyParamsHash(v4);
  const v4Docs = new Map<Hash, unknown>();
  v4Docs.set(v4Hash, v4);
  const v4BasePayload = {
    policy_version: 4,
    params_hash: v4Hash,
    activation_sequence: 300,
  };
  const v4Payload = policyUpdatedPayload(v4BasePayload, [member1, member2]);
  assertError(
    applyPolicyUpdated(
      registry2,
      v4Payload,
      member1.publicKey,
      { sequence: 150, acceptedAt: ISO_DATE },
      { get: (hash) => v4Docs.get(hash) },
    ),
    'SIGNER_AUTHORITY',
  );

  const v5 = { ...base, version: 5, policyId: 'beta.policy.v5' };
  const v5Hash = policyParamsHash(v5);
  const v5Docs = new Map<Hash, unknown>();
  v5Docs.set(v5Hash, v5);
  const v5BasePayload = {
    policy_version: 5,
    params_hash: v5Hash,
    activation_sequence: 400,
  };
  const v5Payload = policyUpdatedPayload(v5BasePayload, [v2Member1, v2Member2]);
  assert.ok(
    applyPolicyUpdated(
      registry2,
      v5Payload,
      v2Member1.publicKey,
      { sequence: 150, acceptedAt: ISO_DATE },
      { get: (hash) => v5Docs.get(hash) },
    ).ok,
  );
});

test('verifyApprovals accepts all four approval source types', () => {
  const params = makeBetaParams();

  const cases: Array<{ type: ApprovalSource['type']; payload: Record<string, unknown> }> = [
    {
      type: 'TreasurySpend',
      payload: {
        recipient: member3.publicKey,
        amount: 10,
        purpose_hash: hashCanonical({ purpose: 'test' }),
        nonce: hashCanonical({ nonce: 1 }),
      },
    },
    {
      type: 'CurrencyIssued',
      payload: {
        recipient: member3.publicKey,
        amount: 10,
        policy_id: 'beta.policy',
        basis_hash: hashCanonical({ basis: 'test' }),
        grant_kind: 'activity',
        nonce: hashCanonical({ nonce: 1 }),
      },
    },
    {
      type: 'RelayKeyRotated',
      payload: {
        key_id: hashCanonical({ key: 1 }),
        pubkey: member3.publicKey,
        valid_from_sequence: 100,
      },
    },
    {
      type: 'PolicyUpdated',
      payload: {
        policy_version: 2,
        params_hash: hashCanonical({ policy: 1 }),
        activation_sequence: 100,
      },
    },
  ];

  for (const item of cases) {
    const baseSource = makeSource(item.type, item.payload);
    const approvals = [approve(baseSource, member1), approve(baseSource, member2)];
    const source = makeSource(item.type, { ...item.payload, approvals });

    assert.ok(verifyApprovals(params, source, member1.publicKey).ok);
  }
});

test('verifyApprovals returns PAYLOAD for an incomplete payload without throwing', () => {
  const params = makeBetaParams();

  const fullPayload = {
    recipient: member3.publicKey,
    amount: 10,
    purpose_hash: hashCanonical({ purpose: 'test' }),
    nonce: hashCanonical({ nonce: 1 }),
  };
  const fullSource = makeSource('TreasurySpend', fullPayload);
  const approvals = [approve(fullSource, member1), approve(fullSource, member2)];

  const incompleteSource = makeSource('TreasurySpend', { approvals });

  assertError(verifyApprovals(params, incompleteSource, member1.publicKey), 'PAYLOAD');
});

test('validatePolicyParams rejects invalid fields with JSON paths', () => {
  const base = makeBetaParams();
  const tier0 = base.jury.tiers[0];
  assert.ok(tier0);

  const { feeBp: _feeBp, ...missingFeeBp } = base;

  const cases: Array<{ value: unknown; code: string; path: string }> = [
    { value: { ...base, version: '1' }, code: 'FIELD_FORMAT', path: 'params.version' },
    { value: { ...base, version: 0 }, code: 'LIMIT', path: 'params.version' },
    {
      value: { ...base, version: Number.MAX_SAFE_INTEGER + 1 },
      code: 'FIELD_FORMAT',
      path: 'params.version',
    },
    { value: { ...base, policyId: 'INVALID' }, code: 'FIELD_FORMAT', path: 'params.policyId' },
    { value: { ...base, feeBp: -1 }, code: 'LIMIT', path: 'params.feeBp' },
    { value: { ...base, appealFeeBp: 10001 }, code: 'LIMIT', path: 'params.appealFeeBp' },
    { value: { ...base, autoAcceptWindowMs: 0 }, code: 'LIMIT', path: 'params.autoAcceptWindowMs' },
    {
      value: { ...base, disputeWindowMs: 1.5 },
      code: 'FIELD_FORMAT',
      path: 'params.disputeWindowMs',
    },
    {
      value: { ...base, appealWindowMs: 365 * 24 * 60 * 60 * 1000 + 1 },
      code: 'LIMIT',
      path: 'params.appealWindowMs',
    },
    { value: { ...base, voteWindowMs: -1 }, code: 'LIMIT', path: 'params.voteWindowMs' },
    { value: { ...base, keyRotationDelayMs: 0 }, code: 'LIMIT', path: 'params.keyRotationDelayMs' },
    {
      value: { ...base, jury: { ...base.jury, tiers: [] } },
      code: 'FIELD_FORMAT',
      path: 'params.jury.tiers',
    },
    {
      value: { ...base, jury: { ...base.jury, tiers: [{ ...tier0, minDeals: -1 }] } },
      code: 'LIMIT',
      path: 'params.jury.tiers[0].minDeals',
    },
    {
      value: {
        ...base,
        jury: {
          ...base.jury,
          tiers: [tier0, { ...tier0, minDeals: tier0.minDeals + 1 }],
        },
      },
      code: 'FIELD_FORMAT',
      path: 'params.jury.tiers[1].minDeals',
    },
    {
      value: {
        ...base,
        jury: {
          ...base.jury,
          tiers: [
            { ...tier0, requirePositiveBalance: false },
            { ...tier0, requirePositiveBalance: true },
          ],
        },
      },
      code: 'FIELD_FORMAT',
      path: 'params.jury.tiers[1].requirePositiveBalance',
    },
    {
      value: { ...base, jury: { ...base.jury, minPoolSizeRound0: 2 } },
      code: 'LIMIT',
      path: 'params.jury.minPoolSizeRound0',
    },
    {
      value: { ...base, jury: { ...base.jury, minPoolSizeRound1: 4 } },
      code: 'LIMIT',
      path: 'params.jury.minPoolSizeRound1',
    },
    {
      value: { ...base, jury: { ...base.jury, payoutPerCase: -1 } },
      code: 'LIMIT',
      path: 'params.jury.payoutPerCase',
    },
    {
      value: { ...base, jury: { ...base.jury, payoutPerCase: 1.5 } },
      code: 'FIELD_FORMAT',
      path: 'params.jury.payoutPerCase',
    },
    {
      value: { ...base, jury: { ...base.jury, payoutPerCase: AMOUNT_MAX + 1 } },
      code: 'LIMIT',
      path: 'params.jury.payoutPerCase',
    },
    {
      value: {
        ...base,
        jury: { tiers: base.jury.tiers, minPoolSizeRound0: 3, minPoolSizeRound1: 5 },
      },
      code: 'MISSING_FIELD',
      path: 'params.jury.payoutPerCase',
    },
    {
      value: { ...base, reputation: { ...base.reputation, activeWindowDays: 0 } },
      code: 'LIMIT',
      path: 'params.reputation.activeWindowDays',
    },
    {
      value: { ...base, reputation: { ...base.reputation, decayHalfLifeDays: -1 } },
      code: 'LIMIT',
      path: 'params.reputation.decayHalfLifeDays',
    },
    {
      value: { ...base, limits: { ...base.limits, maxIssuancePerEvent: 1 } },
      code: 'LIMIT',
      path: 'params.limits.maxIssuancePerEvent',
    },
    {
      value: { ...base, limits: { ...base.limits, maxTreasurySpendPerEvent: 1 } },
      code: 'LIMIT',
      path: 'params.limits.maxTreasurySpendPerEvent',
    },
    {
      value: { ...base, limits: { ...base.limits, maxDealAmount: 1 } },
      code: 'LIMIT',
      path: 'params.limits.maxDealAmount',
    },
    {
      value: { ...base, issuance: { ...base.issuance, allowedGrantKinds: [] } },
      code: 'FIELD_FORMAT',
      path: 'params.issuance.allowedGrantKinds',
    },
    {
      value: {
        ...base,
        issuance: { ...base.issuance, allowedGrantKinds: ['activity', 'activity'] },
      },
      code: 'DUPLICATE',
      path: 'params.issuance.allowedGrantKinds[1]',
    },
    {
      value: {
        ...base,
        issuance: { ...base.issuance, allowedGrantKinds: ['activity', 'other'] },
      },
      code: 'FIELD_FORMAT',
      path: 'params.issuance.allowedGrantKinds[1]',
    },
    {
      value: {
        ...base,
        issuance: { ...base.issuance, allowedPolicyIds: ['BAD ID'] },
      },
      code: 'FIELD_FORMAT',
      path: 'params.issuance.allowedPolicyIds[0]',
    },
    {
      value: {
        ...base,
        issuance: { ...base.issuance, allowedPolicyIds: ['beta.policy', 'beta.policy'] },
      },
      code: 'DUPLICATE',
      path: 'params.issuance.allowedPolicyIds[1]',
    },
    {
      value: {
        ...base,
        multisig: {
          members: [member1.publicKey, member2.publicKey, member3.publicKey, outsider.publicKey],
          threshold: 2,
        },
      },
      code: 'LIMIT',
      path: 'params.multisig.members',
    },
    {
      value: {
        ...base,
        multisig: { members: [member1.publicKey, member1.publicKey], threshold: 2 },
      },
      code: 'DUPLICATE',
      path: 'params.multisig.members[1]',
    },
    {
      value: { ...base, multisig: { ...base.multisig, threshold: 1 } },
      code: 'LIMIT',
      path: 'params.multisig.threshold',
    },
    {
      value: { ...base, multisig: { ...base.multisig, threshold: 4 } },
      code: 'LIMIT',
      path: 'params.multisig.threshold',
    },
    {
      value: { ...base, inviters: [member1.publicKey, member1.publicKey] },
      code: 'DUPLICATE',
      path: 'params.inviters[1]',
    },
    {
      value: { ...base, genesisAccounts: [1] },
      code: 'FIELD_FORMAT',
      path: 'params.genesisAccounts[0]',
    },
    {
      value: { ...base, checkers: [member1.publicKey, member1.publicKey] },
      code: 'DUPLICATE',
      path: 'params.checkers[1]',
    },
    {
      value: {
        ...base,
        genesisRelayKey: {
          ...base.genesisRelayKey,
          keyId: hashCanonical({ wrong: true }),
        },
      },
      code: 'FIELD_FORMAT',
      path: 'params.genesisRelayKey.keyId',
    },
    { value: { ...base, extra: true }, code: 'UNKNOWN_FIELD', path: 'params.extra' },
    { value: missingFeeBp, code: 'MISSING_FIELD', path: 'params.feeBp' },
  ];

  for (const item of cases) {
    assertError(validatePolicyParams(item.value), item.code, item.path);
  }
});

test('validatePolicyParams never throws for non-objects', () => {
  for (const value of [null, 123, [], 'x']) {
    assertError(validatePolicyParams(value), 'FIELD_FORMAT', 'params');
  }
});

test('checkIssuance enforces policy and amount limits', () => {
  const params = makeBetaParams();

  const okPayload: PayloadMap['CurrencyIssued'] = {
    recipient: member3.publicKey,
    amount: 1000,
    policy_id: 'beta.policy',
    basis_hash: hashCanonical({ basis: 1 }),
    grant_kind: 'activity',
    nonce: hashCanonical({ nonce: 1 }),
    approvals: [],
  };

  assert.ok(checkIssuance(params, okPayload).ok);

  const overLimit = {
    ...okPayload,
    amount: 1001,
  };

  assertError(checkIssuance(params, overLimit), 'LIMIT', 'payload.amount');

  const badPolicy = {
    ...okPayload,
    policy_id: 'other.policy',
  };

  assertError(checkIssuance(params, badPolicy), 'POLICY', 'payload.policy_id');

  const badKind = {
    ...okPayload,
    grant_kind: 'other',
  } as unknown as PayloadMap['CurrencyIssued'];

  assertError(checkIssuance(params, badKind), 'POLICY', 'payload.grant_kind');
});

test('checkTreasurySpend enforces amount limits', () => {
  const params = makeBetaParams();

  const okPayload: PayloadMap['TreasurySpend'] = {
    recipient: member3.publicKey,
    amount: 1000,
    purpose_hash: hashCanonical({ purpose: 1 }),
    nonce: hashCanonical({ nonce: 1 }),
    approvals: [],
  };
  assert.ok(checkTreasurySpend(params, okPayload).ok);

  const overLimit = {
    ...okPayload,
    amount: 1001,
  };
  assertError(checkTreasurySpend(params, overLimit), 'LIMIT', 'payload.amount');
});

test('membership helpers use policy lists', () => {
  const params = makeBetaParams();

  assert.equal(isActiveInviter(params, member1.publicKey), true);
  assert.equal(isGenesisAccount(params, member1.publicKey), true);
  assert.equal(isListedChecker(params, member3.publicKey), true);
  assert.equal(isListedChecker(params, outsider.publicKey), false);
});

test('dealPolicyView maps fields and checker predicate', () => {
  const params = makeBetaParams();
  const view: DealPolicyView = dealPolicyView(params);

  assert.equal(view.jurorPayoutAmount, params.jury.payoutPerCase);
  assert.equal(view.feeBp, params.feeBp);
  assert.equal(view.appealFeeBp, params.appealFeeBp);
  assert.equal(view.autoAcceptWindowMs, params.autoAcceptWindowMs);
  assert.equal(view.disputeWindowMs, params.disputeWindowMs);
  assert.equal(view.appealWindowMs, params.appealWindowMs);
  assert.equal(view.voteWindowMs, params.voteWindowMs);
  assert.equal(view.isEffectiveChecker(member1.publicKey), true);
  assert.equal(view.isEffectiveChecker(outsider.publicKey), false);
});

test('canonicalizePolicyRegistry is independent of entry order', () => {
  const params = makeBetaParams();
  const entry1 = {
    version: 1,
    activationSequence: 1,
    paramsHash: policyParamsHash(params),
    params,
  };

  const params2 = { ...params, version: 2, policyId: 'beta.policy.v2' };
  const entry2 = {
    version: 2,
    activationSequence: 100,
    paramsHash: policyParamsHash(params2),
    params: params2,
  };

  const registryA: PolicyRegistry = { entries: [entry1, entry2] };
  const registryB: PolicyRegistry = { entries: [entry2, entry1] };

  const a = assertOk(canonicalizePolicyRegistry(registryA));
  const b = assertOk(canonicalizePolicyRegistry(registryB));
  assert.equal(a, b);
});

test('policyParamsHash is independent of object key order', () => {
  const a = makeBetaParams();
  const b: PolicyParams = {
    checkers: a.checkers,
    genesisAccounts: a.genesisAccounts,
    inviters: a.inviters,
    multisig: a.multisig,
    issuance: a.issuance,
    limits: a.limits,
    reputation: a.reputation,
    jury: a.jury,
    keyRotationDelayMs: a.keyRotationDelayMs,
    voteWindowMs: a.voteWindowMs,
    appealWindowMs: a.appealWindowMs,
    disputeWindowMs: a.disputeWindowMs,
    autoAcceptWindowMs: a.autoAcceptWindowMs,
    appealFeeBp: a.appealFeeBp,
    feeBp: a.feeBp,
    policyId: a.policyId,
    version: a.version,
    genesisRelayKey: a.genesisRelayKey,
  };

  assert.equal(policyParamsHash(a), policyParamsHash(b));
});

test('deeply frozen inputs are not mutated and do not throw', () => {
  const params = deepFreeze(makeBetaParams());
  const before = JSON.stringify(params);

  const registry = assertOk(genesisPolicyRegistry(params));
  assert.equal(registry.entries.length, 1);

  const view = dealPolicyView(params);
  assert.equal(view.feeBp, params.feeBp);

  assert.equal(JSON.stringify(params), before);
});
