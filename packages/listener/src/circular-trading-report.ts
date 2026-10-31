import type { Hash, IsoUtc, Pubkey } from '../../domain/src/protocol.js';
import { canonical, hashCanonical, signBytes } from '../../crypto/src/index.js';
import type { CircularTradingFinding } from './circular-trading.js';

export const REPORT_VERSION = 1;
export const REPORT_DOMAIN = 'skillx/v1/listener-report\n';

export interface TransferReference {
  readonly deal_id: string;
  readonly release_event_hash: Hash;
  readonly sequence: number;
  readonly amount: number;
  readonly accepted_at: IsoUtc;
}

export interface CircularTradingReport {
  readonly report_version: typeof REPORT_VERSION;
  readonly rule_id: 'circular-trading-pair';
  readonly account_a: Pubkey;
  readonly account_b: Pubkey;
  readonly forward: TransferReference;
  readonly reverse: TransferReference;
  readonly through_sequence: number;
  readonly through_receipt_hash: Hash;
  readonly finding_id: Hash;
  readonly listener_pubkey: Pubkey;
  readonly created_at: IsoUtc;
  readonly signature: string;
}

export type UnsignedCircularTradingReport = Omit<CircularTradingReport, 'signature'>;

/**
 * Stable identity of a finding: rule, canonical account pair, and both release hashes. It deliberately excludes
 * through_sequence, so later detections of the same historical finding keep the same identity.
 */
export function stableFindingId(finding: CircularTradingFinding): Hash {
  return hashCanonical({
    rule_id: finding.ruleId,
    account_a: finding.accountA,
    account_b: finding.accountB,
    forward_release_event_hash: finding.forward.releaseEventHash,
    reverse_release_event_hash: finding.reverse.releaseEventHash,
  });
}

/** Domain-separated canonical payload. The signature field is never part of the signed bytes. */
export function reportSigningPayload(report: UnsignedCircularTradingReport): string {
  return REPORT_DOMAIN + canonical(report);
}

const reference = (edge: CircularTradingFinding['forward']): TransferReference => ({
  deal_id: edge.dealId,
  release_event_hash: edge.releaseEventHash,
  sequence: edge.sequence,
  amount: edge.amount,
  accepted_at: edge.acceptedAt,
});

/** Build and sign an off-ledger report from a detected finding. References and hashes only; no ledger events are copied. */
export function circularTradingReport(
  finding: CircularTradingFinding,
  throughSequence: number,
  throughReceiptHash: Hash,
  listenerPubkey: Pubkey,
  createdAt: IsoUtc,
  listenerPrivateKey: string,
): CircularTradingReport {
  const unsigned: UnsignedCircularTradingReport = {
    report_version: REPORT_VERSION,
    rule_id: finding.ruleId,
    account_a: finding.accountA,
    account_b: finding.accountB,
    forward: reference(finding.forward),
    reverse: reference(finding.reverse),
    through_sequence: throughSequence,
    through_receipt_hash: throughReceiptHash,
    finding_id: stableFindingId(finding),
    listener_pubkey: listenerPubkey,
    created_at: createdAt,
  };
  const signature = signBytes(Buffer.from(reportSigningPayload(unsigned), 'utf8'), listenerPrivateKey);
  return { ...unsigned, signature };
}
