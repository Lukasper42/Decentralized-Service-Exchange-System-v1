// packages/domain/src/jury-draws.ts
import { ok, err } from './protocol.js';
import type { Result, Pubkey, Hash } from './protocol.js';
import { eligiblePool, beaconSequence } from './jury.js';
import type {
  JuryCandidate,
  JuryRules,
  JuryContext,
  JuryContextSource,
} from './jury.js';

export interface JuryDraw {
  readonly triggerSequence: number;
  readonly triggerAcceptedAtMs: number;
  readonly candidates: readonly JuryCandidate[];
  readonly excluded: readonly Pubkey[];
  readonly rules: JuryRules;
  readonly beaconReceiptHash: Hash | null;
}

export type JuryDraws = Readonly<Record<string, JuryDraw>>;

export interface OpenDrawInput {
  readonly triggerSequence: number;
  readonly triggerAcceptedAtMs: number;
  readonly candidates: readonly JuryCandidate[];
  readonly excluded: readonly Pubkey[];
  readonly rules: JuryRules;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function comparePubkeys(a: Pubkey, b: Pubkey): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function sortUniquePubkeys(values: readonly Pubkey[]): Pubkey[] {
  const sorted = [...values].sort(comparePubkeys);
  const unique: Pubkey[] = [];
  for (const value of sorted) {
    const last = unique[unique.length - 1];
    if (last === undefined || last !== value) {
      unique.push(value);
    }
  }
  return unique;
}

function cloneDraws(draws: JuryDraws): Record<string, JuryDraw> {
  const next = Object.create(null) as Record<string, JuryDraw>;
  for (const key of Object.keys(draws)) {
    if (Object.hasOwn(draws, key)) {
      const entry = draws[key];
      if (entry !== undefined) {
        next[key] = entry;
      }
    }
  }
  return next;
}

function isDrawKey(key: string): boolean {
  const colon = key.lastIndexOf(':');
  if (colon <= 0) {
    return false;
  }
  const round = key.slice(colon + 1);
  return round === '0' || round === '1';
}

function isLowerHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function initialJuryDraws(): JuryDraws {
  const draws = Object.create(null) as Record<string, JuryDraw>;
  return draws;
}

export function drawKey(dealId: string, appealRound: 0 | 1): string {
  return `${dealId}:${appealRound}`;
}

export function openDraw(
  draws: JuryDraws,
  dealId: string,
  appealRound: 0 | 1,
  input: OpenDrawInput,
): Result<JuryDraws> {
  if (dealId.length === 0) {
    return err('FIELD_FORMAT', 'Deal id must be non-empty', 'dealId');
  }

  if (!isPositiveSafeInteger(input.triggerSequence)) {
    return err(
      'FIELD_FORMAT',
      'Trigger sequence must be a positive safe integer',
      'input.triggerSequence',
    );
  }

  if (!isNonNegativeSafeInteger(input.triggerAcceptedAtMs)) {
    return err(
      'FIELD_FORMAT',
      'Trigger accepted time must be a non-negative safe integer',
      'input.triggerAcceptedAtMs',
    );
  }

  const seenCandidates = new Set<Pubkey>();
  for (let i = 0; i < input.candidates.length; i += 1) {
    const candidate = input.candidates[i];
    if (candidate === undefined) {
      return err(
        'FIELD_FORMAT',
        'Candidate is missing',
        `input.candidates[${i}].pubkey`,
      );
    }
    if (candidate.pubkey.length === 0) {
      return err(
        'FIELD_FORMAT',
        'Candidate pubkey must be non-empty',
        `input.candidates[${i}].pubkey`,
      );
    }
    if (seenCandidates.has(candidate.pubkey)) {
      return err(
        'FIELD_FORMAT',
        'Candidate pubkey must be unique',
        `input.candidates[${i}].pubkey`,
      );
    }
    seenCandidates.add(candidate.pubkey);
  }

  for (let i = 0; i < input.excluded.length; i += 1) {
    const pubkey = input.excluded[i];
    if (pubkey === undefined || pubkey.length === 0) {
      return err(
        'FIELD_FORMAT',
        'Excluded pubkey must be non-empty',
        `input.excluded[${i}]`,
      );
    }
  }

  if (!isNonNegativeSafeInteger(input.rules.minPoolSizeRound0)) {
    return err(
      'FIELD_FORMAT',
      'Minimum pool size for round 0 must be a non-negative safe integer',
      'input.rules.minPoolSizeRound0',
    );
  }

  if (!isNonNegativeSafeInteger(input.rules.minPoolSizeRound1)) {
    return err(
      'FIELD_FORMAT',
      'Minimum pool size for round 1 must be a non-negative safe integer',
      'input.rules.minPoolSizeRound1',
    );
  }

  if (input.rules.tiers.length === 0) {
    return err(
      'FIELD_FORMAT',
      'Policy tiers must not be empty',
      'input.rules.tiers',
    );
  }

  const key = drawKey(dealId, appealRound);
  if (Object.hasOwn(draws, key)) {
    return err('DUPLICATE', 'Jury draw already exists for this deal round', 'dealId');
  }

  const excluded = sortUniquePubkeys(input.excluded);
  const union = new Set<Pubkey>();

  for (const tier of input.rules.tiers) {
    const poolResult = eligiblePool(
      input.candidates,
      tier,
      excluded,
      input.triggerAcceptedAtMs,
    );
    if (!poolResult.ok) {
      return poolResult;
    }
    for (const pubkey of poolResult.value) {
      union.add(pubkey);
    }
  }

  const frozenCandidates = input.candidates
    .filter((candidate) => union.has(candidate.pubkey))
    .sort((a, b) => comparePubkeys(a.pubkey, b.pubkey))
    .map((candidate) => ({ ...candidate }));

  const draw: JuryDraw = {
    triggerSequence: input.triggerSequence,
    triggerAcceptedAtMs: input.triggerAcceptedAtMs,
    candidates: frozenCandidates,
    excluded,
    rules: structuredClone(input.rules),
    beaconReceiptHash: null,
  };

  const next = cloneDraws(draws);
  next[key] = draw;
  return ok(next);
}

export function recordBeacon(
  draws: JuryDraws,
  sequence: number,
  previousReceiptHash: Hash | null,
): Result<JuryDraws> {
  if (!isPositiveSafeInteger(sequence)) {
    return err(
      'FIELD_FORMAT',
      'Sequence must be a positive safe integer',
      'sequence',
    );
  }

  let next: Record<string, JuryDraw> | undefined;

  for (const key of Object.keys(draws)) {
    if (!Object.hasOwn(draws, key)) {
      continue;
    }
    const entry = draws[key];
    if (entry === undefined) {
      continue;
    }
    if (entry.beaconReceiptHash !== null) {
      continue;
    }

    const expectedResult = beaconSequence(entry.triggerSequence);
    if (!expectedResult.ok) {
      return expectedResult;
    }

    const expectedSequence = expectedResult.value;
    if (expectedSequence === sequence - 1) {
      if (previousReceiptHash === null) {
        return err(
          'STATE',
          'Beacon receipt hash is required for this sequence',
          'previousReceiptHash',
        );
      }
      if (next === undefined) {
        next = cloneDraws(draws);
      }
      next[key] = { ...entry, beaconReceiptHash: previousReceiptHash };
    } else if (expectedSequence < sequence - 1) {
      return err(
        'STATE',
        'Beacon window passed without receipt hash',
        `draws.${key}.beaconReceiptHash`,
      );
    }
  }

  if (next === undefined) {
    return ok(draws);
  }
  return ok(next);
}

export function closeDraws(draws: JuryDraws, dealId: string): JuryDraws {
  const key0 = drawKey(dealId, 0);
  const key1 = drawKey(dealId, 1);
  const has0 = Object.hasOwn(draws, key0);
  const has1 = Object.hasOwn(draws, key1);

  if (!has0 && !has1) {
    return draws;
  }

  const next = Object.create(null) as Record<string, JuryDraw>;
  for (const key of Object.keys(draws)) {
    if (Object.hasOwn(draws, key)) {
      const entry = draws[key];
      if (entry !== undefined && key !== key0 && key !== key1) {
        next[key] = entry;
      }
    }
  }
  return next;
}

export function juryContextSource(
  draws: JuryDraws,
  seatedFor: (dealId: string, appealRound: 0 | 1) => readonly Pubkey[],
): JuryContextSource {
  return {
    contextFor(dealId: string, appealRound: 0 | 1): Result<JuryContext> {
      const key = drawKey(dealId, appealRound);
      if (!Object.hasOwn(draws, key)) {
        return err(
          'STATE',
          'No jury draw snapshot for this deal round',
          'dealId',
        );
      }
      const draw = draws[key];
      if (draw === undefined) {
        return err(
          'STATE',
          'No jury draw snapshot for this deal round',
          'dealId',
        );
      }

      const context: JuryContext = {
        candidates: draw.candidates,
        excluded: draw.excluded,
        triggerAcceptedAtMs: draw.triggerAcceptedAtMs,
        beaconReceiptHash: draw.beaconReceiptHash,
        rules: draw.rules,
        seatedJurors: seatedFor(dealId, appealRound),
      };
      return ok(context);
    },
  };
}

export function canonicalizeJuryDraws(draws: JuryDraws): JuryDraws {
  const next = Object.create(null) as Record<string, JuryDraw>;
  const keys = Object.keys(draws).sort();

  for (const key of keys) {
    if (!Object.hasOwn(draws, key)) {
      continue;
    }
    const entry = draws[key];
    if (entry === undefined) {
      continue;
    }

    const candidates = [...entry.candidates].sort((a, b) =>
      comparePubkeys(a.pubkey, b.pubkey),
    );
    const excluded = [...entry.excluded].sort(comparePubkeys);

    next[key] = { ...entry, candidates, excluded };
  }

  return next;
}

export function assertJuryDrawInvariants(draws: JuryDraws): Result<true> {
  for (const key of Object.keys(draws)) {
    if (!Object.hasOwn(draws, key)) {
      continue;
    }
    const entry = draws[key];
    if (entry === undefined) {
      return err('STATE', 'Missing jury draw entry', `draws.${key}`);
    }

    if (!Number.isSafeInteger(entry.triggerSequence)) {
      return err(
        'STATE',
        'Trigger sequence must be a safe integer',
        `draws.${key}.triggerSequence`,
      );
    }

    if (!Number.isSafeInteger(entry.triggerAcceptedAtMs)) {
      return err(
        'STATE',
        'Trigger accepted time must be a safe integer',
        `draws.${key}.triggerAcceptedAtMs`,
      );
    }

    if (!isDrawKey(key)) {
      return err('STATE', 'Invalid jury draw key', `draws.${key}`);
    }

    for (let i = 1; i < entry.candidates.length; i += 1) {
      const previous = entry.candidates[i - 1];
      const current = entry.candidates[i];
      if (previous === undefined || current === undefined) {
        return err(
          'STATE',
          'Invalid candidate ordering',
          `draws.${key}.candidates`,
        );
      }
      if (comparePubkeys(previous.pubkey, current.pubkey) >= 0) {
        return err(
          'STATE',
          'Candidates must be strictly ascending by pubkey',
          `draws.${key}.candidates`,
        );
      }
    }

    for (let i = 1; i < entry.excluded.length; i += 1) {
      const previous = entry.excluded[i - 1];
      const current = entry.excluded[i];
      if (previous === undefined || current === undefined) {
        return err(
          'STATE',
          'Invalid exclusion ordering',
          `draws.${key}.excluded`,
        );
      }
      if (comparePubkeys(previous, current) >= 0) {
        return err(
          'STATE',
          'Excluded pubkeys must be strictly ascending',
          `draws.${key}.excluded`,
        );
      }
    }

    const excludedSet = new Set(entry.excluded);
    for (const candidate of entry.candidates) {
      if (excludedSet.has(candidate.pubkey)) {
        return err(
          'STATE',
          'Candidate must not be excluded',
          `draws.${key}.candidates`,
        );
      }
    }

    if (
      entry.beaconReceiptHash !== null &&
      !isLowerHex64(entry.beaconReceiptHash)
    ) {
      return err(
        'STATE',
        'Beacon receipt hash must be null or a 64-character lowercase hex string',
        `draws.${key}.beaconReceiptHash`,
      );
    }
  }

  return ok(true);
}