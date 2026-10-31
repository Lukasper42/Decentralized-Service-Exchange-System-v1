/**
 * Deterministic jury selection for the Skill Exchange Ledger.
 *
 * This module implements the pure selection rules from spec section 6 and an
 * adapter that satisfies the `JuryOracle` port. It is intentionally free of
 * clocks, randomness, and I/O.
 *
 * Pool data (`completedDeals`, `distinctCounterparties`, `reputationSum`,
 * `createdAtMs`) is supplied by the projection. `reputationSum` represents the
 * quality of work from feedback, not coin balance. Juror compensation is not
 * handled in this module.
 */

import { Buffer } from 'node:buffer';

import { sha256Hex } from '../../crypto/src/index.js';
import type { PolicyTier } from './policy.js';
import type { JuryOracle } from './ports.js';
import {
  BEACON_DELAY,
  err,
  ok,
  type Hash,
  type Pubkey,
  type Result,
} from './protocol.js';

export interface JuryCandidate {
  readonly pubkey: Pubkey;
  readonly createdAtMs: number;
  readonly completedDeals: number;
  readonly distinctCounterparties: number;
  readonly reputationSum: number;
}

export interface JuryRules {
  readonly tiers: readonly PolicyTier[];
  readonly minPoolSizeRound0: number;
  readonly minPoolSizeRound1: number;
}

export interface JuryContext {
  readonly candidates: readonly JuryCandidate[];
  readonly excluded: readonly Pubkey[];
  readonly triggerAcceptedAtMs: number;
  readonly beaconReceiptHash: Hash | null;
  readonly rules: JuryRules;
  readonly seatedJurors: readonly Pubkey[];
}

export interface JuryContextSource {
  contextFor(dealId: string, appealRound: 0 | 1): Result<JuryContext>;
}

const MS_PER_DAY = 86_400_000;

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function compareUtf8(a: Pubkey, b: Pubkey): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function requiredJurors(appealRound: 0 | 1): number {
  switch (appealRound) {
    case 0:
      return 3;
    case 1:
      return 5;
    default: {
      const _x: never = appealRound;
      return _x;
    }
  }
}

function minPoolSizeForRound(rules: JuryRules, appealRound: 0 | 1): number {
  return appealRound === 0 ? rules.minPoolSizeRound0 : rules.minPoolSizeRound1;
}

function decodeSeed(seedHex: Hash): Uint8Array | null {
  if (typeof seedHex !== 'string') {
    return null;
  }
  if (seedHex.length !== 64 || !/^[0-9a-f]{64}$/.test(seedHex)) {
    return null;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    const byte = Number.parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      return null;
    }
    out[i] = byte;
  }
  return out;
}

function uint32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

export function beaconSequence(triggerSequence: number): Result<number> {
  if (!Number.isSafeInteger(triggerSequence) || triggerSequence <= 0) {
    return err('LIMIT', 'triggerSequence must be a positive safe integer whose beacon sequence is safe', 'triggerSequence');
  }

  const sequence = triggerSequence + BEACON_DELAY;
  if (!Number.isSafeInteger(sequence)) {
    return err('LIMIT', 'triggerSequence must be a positive safe integer whose beacon sequence is safe', 'triggerSequence');
  }

  return ok(sequence);
}

export function eligiblePool(
  candidates: readonly JuryCandidate[],
  tier: PolicyTier,
  excluded: readonly Pubkey[],
  triggerAcceptedAtMs: number,
): Result<readonly Pubkey[]> {
  if (!isSafeNonNegativeInteger(triggerAcceptedAtMs)) {
    return err('FIELD_FORMAT', 'triggerAcceptedAtMs must be a non-negative safe integer', 'triggerAcceptedAtMs');
  }
  if (!isSafeNonNegativeInteger(tier.minDeals)) {
    return err('FIELD_FORMAT', 'tier.minDeals must be a non-negative safe integer', 'tier.minDeals');
  }
  if (!isSafeNonNegativeInteger(tier.minCounterparties)) {
    return err('FIELD_FORMAT', 'tier.minCounterparties must be a non-negative safe integer', 'tier.minCounterparties');
  }
  if (!isSafeNonNegativeInteger(tier.minAccountAgeDays)) {
    return err('FIELD_FORMAT', 'tier.minAccountAgeDays must be a non-negative safe integer', 'tier.minAccountAgeDays');
  }

  const seen = new Map<Pubkey, number>();
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate === undefined) {
      return err('FIELD_FORMAT', 'Candidate entry is missing', `candidates[${i}]`);
    }

    if (!isSafeNonNegativeInteger(candidate.completedDeals)) {
      return err('FIELD_FORMAT', 'completedDeals must be a non-negative safe integer', `candidates[${i}].completedDeals`);
    }
    if (!isSafeNonNegativeInteger(candidate.distinctCounterparties)) {
      return err('FIELD_FORMAT', 'distinctCounterparties must be a non-negative safe integer', `candidates[${i}].distinctCounterparties`);
    }
    if (!Number.isSafeInteger(candidate.reputationSum)) {
      return err('FIELD_FORMAT', 'reputationSum must be a safe integer', `candidates[${i}].reputationSum`);
    }
    if (!isSafeNonNegativeInteger(candidate.createdAtMs)) {
      return err('FIELD_FORMAT', 'createdAtMs must be a non-negative safe integer', `candidates[${i}].createdAtMs`);
    }

    if (typeof candidate.pubkey !== 'string' || candidate.pubkey.length === 0) {
      return err('FIELD_FORMAT', 'Candidate pubkey must be a non-empty string', `candidates[${i}].pubkey`);
    }

    const firstIndex = seen.get(candidate.pubkey);
    if (firstIndex !== undefined) {
      return err('DUPLICATE', 'Duplicate candidate pubkey', `candidates[${i}].pubkey`);
    }
    seen.set(candidate.pubkey, i);
  }

  for (let i = 0; i < excluded.length; i += 1) {
    const entry = excluded[i];
    if (typeof entry !== 'string' || entry.length === 0) {
      return err('FIELD_FORMAT', 'Excluded pubkey must be a non-empty string', `excluded[${i}]`);
    }
  }

  const excludedSet = new Set<Pubkey>(excluded);
  const minAgeMs = BigInt(tier.minAccountAgeDays) * BigInt(MS_PER_DAY);
  const eligible: Pubkey[] = [];

  for (const candidate of candidates) {
    if (excludedSet.has(candidate.pubkey)) {
      continue;
    }
    if (candidate.completedDeals < tier.minDeals) {
      continue;
    }
    if (candidate.distinctCounterparties < tier.minCounterparties) {
      continue;
    }
    if (tier.requirePositiveBalance && candidate.reputationSum <= 0) {
      continue;
    }

    const ageMs = BigInt(triggerAcceptedAtMs) - BigInt(candidate.createdAtMs);
    if (ageMs < minAgeMs) {
      continue;
    }

    eligible.push(candidate.pubkey);
  }

  eligible.sort(compareUtf8);
  return ok(eligible);
}

export function selectPool(
  context: JuryContext,
  appealRound: 0 | 1,
): Result<{ tierIndex: number; pool: readonly Pubkey[] }> {
  if (!isSafeNonNegativeInteger(context.triggerAcceptedAtMs)) {
    return err('FIELD_FORMAT', 'triggerAcceptedAtMs must be a non-negative safe integer', 'triggerAcceptedAtMs');
  }
  if (!isSafeNonNegativeInteger(context.rules.minPoolSizeRound0)) {
    return err('FIELD_FORMAT', 'minPoolSizeRound0 must be a non-negative safe integer', 'rules.minPoolSizeRound0');
  }
  if (!isSafeNonNegativeInteger(context.rules.minPoolSizeRound1)) {
    return err('FIELD_FORMAT', 'minPoolSizeRound1 must be a non-negative safe integer', 'rules.minPoolSizeRound1');
  }

  const required = requiredJurors(appealRound);
  const minPoolSize = minPoolSizeForRound(context.rules, appealRound);
  const threshold = Math.max(minPoolSize, required);

  for (let i = 0; i < context.rules.tiers.length; i += 1) {
    const tier = context.rules.tiers[i];
    if (tier === undefined) {
      return err('FIELD_FORMAT', 'Jury tier entry is missing', `rules.tiers[${i}]`);
    }

    const poolResult = eligiblePool(
      context.candidates,
      tier,
      context.excluded,
      context.triggerAcceptedAtMs,
    );
    if (!poolResult.ok) {
      return poolResult;
    }

    if (poolResult.value.length >= threshold) {
      return ok({ tierIndex: i, pool: poolResult.value });
    }
  }

  return err('POLICY', 'No jury tier yields a large enough pool', 'policy.jury.tiers');
}

export function drawSequence(
  pool: readonly Pubkey[],
  seedHex: Hash,
  count: number,
): Result<readonly Pubkey[]> {
  if (!isSafeNonNegativeInteger(count)) {
    return err('FIELD_FORMAT', 'count must be a non-negative safe integer', 'count');
  }
  if (count > pool.length) {
    return err('POLICY', 'Cannot draw more jurors than the pool holds', 'drawSequence.count');
  }

  const seedBytes = decodeSeed(seedHex);
  if (seedBytes === null) {
    return err('FIELD_FORMAT', 'Seed must be 64 lowercase hex characters', 'seedHex');
  }

  const remaining = [...pool].sort(compareUtf8);
  const chosen: Pubkey[] = [];

  for (let i = 0; i < count; i += 1) {
    const input = new Uint8Array(36);
    input.set(seedBytes, 0);
    input.set(uint32be(i), 32);

    const hashHex = sha256Hex(input);
    const indexBig = BigInt(`0x${hashHex}`) % BigInt(remaining.length);
    const index = Number(indexBig);

    const removed = remaining.splice(index, 1)[0];
    if (removed === undefined) {
      return err('POLICY', 'Pool ran out during the draw', 'drawSequence.pool');
    }
    chosen.push(removed);
  }

  return ok(chosen);
}

export function selectJurors(
  context: JuryContext,
  appealRound: 0 | 1,
): Result<{ tierIndex: number; jurors: readonly Pubkey[] }> {
  if (context.beaconReceiptHash === null) {
    return err('WINDOW', 'Beacon receipt is not available yet', 'beaconReceiptHash');
  }

  const poolResult = selectPool(context, appealRound);
  if (!poolResult.ok) {
    return poolResult;
  }

  const required = requiredJurors(appealRound);
  const drawn = drawSequence(
    poolResult.value.pool,
    context.beaconReceiptHash,
    required,
  );
  if (!drawn.ok) {
    return drawn;
  }

  return ok({
    tierIndex: poolResult.value.tierIndex,
    jurors: drawn.value,
  });
}

export function selectReplacement(
  context: JuryContext,
  appealRound: 0 | 1,
  missingJuror: Pubkey,
): Result<Pubkey> {
  if (context.beaconReceiptHash === null) {
    return err('WINDOW', 'Beacon receipt is not available yet', 'beaconReceiptHash');
  }

  const poolResult = selectPool(context, appealRound);
  if (!poolResult.ok) {
    return poolResult;
  }

  if (!context.seatedJurors.includes(missingJuror)) {
    return err('JURY_MISMATCH', 'Missing juror is not among the seated jurors', 'missingJuror');
  }

  const needed = context.seatedJurors.length + 1;
  if (!Number.isSafeInteger(needed) || needed < 0) {
    return err('FIELD_FORMAT', 'seatedJurors length is invalid', 'seatedJurors');
  }
  if (needed > poolResult.value.pool.length) {
    return err('POLICY', 'Pool has no further replacement candidate', 'policy.jury.replacement');
  }

  const drawn = drawSequence(
    poolResult.value.pool,
    context.beaconReceiptHash,
    needed,
  );
  if (!drawn.ok) {
    return drawn;
  }

  for (let i = 0; i < context.seatedJurors.length; i += 1) {
    if (drawn.value[i] !== context.seatedJurors[i]) {
      return err('JURY_MISMATCH', 'Seated jurors do not match the deterministic draw', `seatedJurors[${i}]`);
    }
  }

  const replacement = drawn.value[context.seatedJurors.length];
  if (replacement === undefined) {
    return err('POLICY', 'Pool has no further replacement candidate', 'policy.jury.replacement');
  }

  return ok(replacement);
}

export function createJuryOracle(source: JuryContextSource): JuryOracle {
  return {
    expectedJurors(dealId: string, appealRound: 0 | 1): Result<readonly Pubkey[]> {
      const contextResult = source.contextFor(dealId, appealRound);
      if (!contextResult.ok) {
        return contextResult;
      }

      const selected = selectJurors(contextResult.value, appealRound);
      if (!selected.ok) {
        return selected;
      }

      return ok(selected.value.jurors);
    },

    expectedReplacement(
      dealId: string,
      appealRound: 0 | 1,
      missingJuror: Pubkey,
    ): Result<Pubkey> {
      const contextResult = source.contextFor(dealId, appealRound);
      if (!contextResult.ok) {
        return contextResult;
      }

      return selectReplacement(
        contextResult.value,
        appealRound,
        missingJuror,
      );
    },
  };
}