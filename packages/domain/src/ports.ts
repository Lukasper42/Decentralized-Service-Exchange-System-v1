import type { Hash, IsoUtc, Pubkey, Result } from './protocol.js';

/** What the deal machine needs to know about the receipt of the event being applied. */
export interface ReceiptMeta { sequence: number; acceptedAt: IsoUtc }

/** Policy values in force at the receipt sequence. Windows are in milliseconds. */
export interface DealPolicyView {
  readonly feeBp: number;
  readonly appealFeeBp: number;
  readonly autoAcceptWindowMs: number;
  readonly disputeWindowMs: number;
  readonly appealWindowMs: number;
  readonly voteWindowMs: number;
  /** True iff the pubkey is a policy-listed checker whose precheck is effective. */
  isEffectiveChecker(pubkey: Pubkey): boolean;
}

/** Spendable balance projection. */
export interface FundsView { spendable(account: Pubkey): number }

/**
 * Deterministic jury selection computed elsewhere (spec section 6).
 * May fail with JURY_MISMATCH, WINDOW (beacon receipt not yet available) or POLICY (pool too small).
 */
export interface JuryOracle {
  expectedJurors(dealId: string, appealRound: 0 | 1): Result<readonly Pubkey[]>;
  expectedReplacement(dealId: string, appealRound: 0 | 1, missingJuror: Pubkey): Result<Pubkey>;
}

export interface DealContext { policy: DealPolicyView; funds: FundsView; jury: JuryOracle }

/** Every ledger effect of a deal event, so the accounting module never re-derives it. */
export type Movement =
  | { kind: 'escrow_lock'; dealId: string; from: Pubkey; amount: number }
  | { kind: 'escrow_release_to_seller'; dealId: string; to: Pubkey; amount: number }
  | { kind: 'escrow_refund_to_buyer'; dealId: string; to: Pubkey; amount: number }
  | { kind: 'fee_burn'; dealId: string; amount: number }
  | { kind: 'appeal_escrow_lock'; dealId: string; from: Pubkey; amount: number }
  | { kind: 'appeal_fee_return'; dealId: string; to: Pubkey; amount: number }
  | { kind: 'appeal_fee_burn'; dealId: string; amount: number };

/** Account projection port used by L2 chain verification. */
export interface SignerResolver { resolve(pubkey: Pubkey, sequence: number): Result<true> }

/** Relay key validity range [validFromSequence, validToSequence); null means open-ended. */
export interface RelayKeyRange { keyId: Hash; pubkey: Pubkey; validFromSequence: number; validToSequence: number | null }
