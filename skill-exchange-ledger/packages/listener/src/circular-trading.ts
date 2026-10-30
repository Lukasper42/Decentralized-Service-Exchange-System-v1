import type { Hash, IsoUtc, Pubkey, Result } from '../../domain/src/protocol.js';
import { err, ok } from '../../domain/src/protocol.js';
import { eventHash, hashCanonical } from '../../crypto/src/index.js';
import type { LedgerEntry } from '../../chain-verifier/src/index.js';

/**
 * Circular-trading detector (read side only). It works on ledger entries that a client or relay has already verified
 * (chain-verifier) and never writes to the ledger: protocol v1 has no risk event, so a finding is evidence, not state.
 *
 * Money flow between two accounts is a release of escrow to the seller of a deal: buyer -> seller. Funding is not a
 * transfer between accounts (it moves coins into escrow) and a refund goes back to the buyer, so neither is an edge.
 */
export interface TransferEdge {
  readonly dealId: string;
  readonly from: Pubkey;
  readonly to: Pubkey;
  readonly amount: number;
  /** Relay time of the release (receipt.acceptedAt), not the signer's own timestamp. */
  readonly acceptedAt: IsoUtc;
  readonly sequence: number;
  readonly releaseEventHash: Hash;
}

export interface CircularTradingFinding {
  readonly ruleId: 'circular-trading-pair';
  /** The pair in canonical order (accountA < accountB), so a pair has exactly one finding. */
  readonly accountA: Pubkey;
  readonly accountB: Pubkey;
  /** Earliest release accountA -> accountB and earliest release accountB -> accountA. */
  readonly forward: TransferEdge;
  readonly reverse: TransferEdge;
}

const isPositiveSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && !Object.is(value, -0);

/** Follow KeyRotated events: a rotated account keeps its identity under its newest key. */
function resolver(rotations: ReadonlyMap<Pubkey, Pubkey>): (key: Pubkey) => Pubkey {
  return (key) => {
    let current = key;
    for (let hops = 0; hops < 1024; hops += 1) {
      const next = rotations.get(current);
      if (next === undefined) return current;
      current = next;
    }
    return current;
  };
}

/**
 * Build the transfer edges of a verified ledger prefix. Entries must be in receipt order with contiguous sequences.
 * Accounts are reported under their newest key (KeyRotated is followed).
 */
export function transferEdges(entries: readonly LedgerEntry[]): Result<readonly TransferEdge[]> {
  const deals = new Map<string, { buyer: Pubkey; seller: Pubkey }>();
  const rotations = new Map<Pubkey, Pubkey>();
  const raw: TransferEdge[] = [];
  let previous: number | null = null;
  for (const [index, entry] of entries.entries()) {
    const sequence = entry.receipt.sequence;
    if (previous !== null && sequence !== previous + 1) return err('RECEIPT_SEQUENCE', 'Entries are not contiguous', `entries[${index}].receipt.sequence`);
    previous = sequence;
    const event = entry.event;
    if (event.type === 'DealCreated') deals.set(event.payload.deal_id, { buyer: event.payload.buyer, seller: event.payload.seller });
    else if (event.type === 'KeyRotated') rotations.set(event.payload.old_pubkey, event.payload.new_pubkey);
    else if (event.type === 'EscrowReleased') {
      const deal = deals.get(event.payload.deal_id);
      if (deal === undefined) return err('STATE', 'EscrowReleased for a deal that was never created', `entries[${index}].event.payload.deal_id`);
      if (!isPositiveSafeInteger(event.payload.amount)) return err('AMOUNT', 'amount must be a positive safe integer', `entries[${index}].event.payload.amount`);
      // Settlement to the seller is a trade; a refund to the buyer is not. Compare through rotations, because the
      // release names the party's key at that time.
      const resolve = resolver(rotations);
      if (resolve(event.payload.to) === resolve(deal.seller)) {
        raw.push({ dealId: event.payload.deal_id, from: deal.buyer, to: event.payload.to, amount: event.payload.amount, acceptedAt: entry.receipt.acceptedAt, sequence, releaseEventHash: eventHash(event) });
      }
    }
  }
  const resolve = resolver(rotations);
  return ok(raw.map((edge) => ({ ...edge, from: resolve(edge.from), to: resolve(edge.to) })));
}

const compareKeys = (a: Pubkey, b: Pubkey): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function findingFor(edges: readonly TransferEdge[], a: Pubkey, b: Pubkey): CircularTradingFinding | null {
  const [accountA, accountB] = compareKeys(a, b) <= 0 ? [a, b] : [b, a];
  if (accountA === accountB) return null;
  const forward = edges.find((edge) => edge.from === accountA && edge.to === accountB);
  const reverse = edges.find((edge) => edge.from === accountB && edge.to === accountA);
  return forward === undefined || reverse === undefined ? null : { ruleId: 'circular-trading-pair', accountA, accountB, forward, reverse };
}

/** The finding for one pair, or null when money only ever flowed one way. */
export function detectCircularTradingBetweenPair(edges: readonly TransferEdge[], a: Pubkey, b: Pubkey): CircularTradingFinding | null {
  return findingFor(edges, a, b);
}

/** Every pair with releases in both directions, ordered by the sequence of the later of its two releases, then by pair. */
export function findCircularTradingPairs(edges: readonly TransferEdge[]): readonly CircularTradingFinding[] {
  const seen = new Set<string>();
  const found: CircularTradingFinding[] = [];
  for (const edge of edges) {
    const [a, b] = compareKeys(edge.from, edge.to) <= 0 ? [edge.from, edge.to] : [edge.to, edge.from];
    const key = `${a}\n${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const finding = findingFor(edges, a, b);
    if (finding !== null) found.push(finding);
  }
  const closes = (f: CircularTradingFinding): number => Math.max(f.forward.sequence, f.reverse.sequence);
  return found.sort((x, y) => closes(x) - closes(y) || compareKeys(x.accountA, y.accountA) || compareKeys(x.accountB, y.accountB));
}

/** The evidence a verifier needs, referencing ledger events by hash instead of copying them. */
export function attestationBody(finding: CircularTradingFinding, throughSequence: number): Readonly<Record<string, unknown>> {
  const ref = (edge: TransferEdge): Record<string, unknown> => ({ deal_id: edge.dealId, release_event_hash: edge.releaseEventHash, sequence: edge.sequence, amount: edge.amount, accepted_at: edge.acceptedAt });
  return { rule_id: finding.ruleId, account_a: finding.accountA, account_b: finding.accountB, forward: ref(finding.forward), reverse: ref(finding.reverse), through_sequence: throughSequence };
}

/** Stable identifier of a finding: the hash of its canonical attestation body. */
export function findingHash(finding: CircularTradingFinding, throughSequence: number): Hash {
  return hashCanonical(attestationBody(finding, throughSequence));
}
