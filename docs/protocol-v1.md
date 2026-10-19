# Skill Exchange Ledger: Core Schema v1

Pre-release revision 2. This is the one permitted pre-release wire break; the version field remains integer `1`. After this revision, v1 is frozen. This document is normative and mirrors `Core Schema v1.txt`.

## 1. Frozen encoding and cryptography

The envelope fields are exactly `type`, `version`, `payload`, `signer`, `timestamp`, `prevHash`, `signature`; version is `1`. Canonical JSON sorts object keys lexicographically by UTF-16 code unit and preserves array order. Only strings, safe integers, booleans, and null are representable. Reject floats, `-0`, unsafe integers, undefined, bigint, lone surrogates, cycles, sparse arrays, non-plain objects, symbol keys, and the keys `__proto__`, `constructor`, `prototype`. Event signatures are Ed25519 over UTF-8 canonical envelope without `signature`; event hashes are lowercase SHA-256 hex over canonical complete signed events. Content hashes are lowercase SHA-256 hex over raw bytes. Attestations sign UTF-8 `skillx/v1/<kind>\n` followed by canonical body. Pubkey is strict base64 Ed25519 SPKI-DER; Sig is strict base64 of 64 bytes; Hash is 64 lowercase hex; UUID is lowercase UUIDv4; IsoUtc is exactly millisecond UTC ISO format and round-trips.

Ed25519 verification follows RFC 8032: reject S ≥ L, non-canonical encodings of R or A, and small-order public keys. Go and ABCI implementations must pass the same structural and cryptographic test-vector plan.

## 2. Types, envelope, and receipts

```ts
type Pubkey = string; type Hash = string; type Sig = string;
type Uuid = string; type Amount = number; type IsoUtc = string;
interface EventEnvelope<T extends EventType, P> {
  type: T; version: 1; payload: P; signer: Pubkey; timestamp: IsoUtc;
  prevHash: Hash | null; signature: Sig;
}
interface Receipt {
  sequence: number; eventHash: Hash; previousReceiptHash: Hash | null;
  acceptedAt: IsoUtc; keyId: Hash; signature: Sig;
}
```
`prevHash` links to the preceding event by the same signer and is null only on that signer's first event. The relay performs atomic compare-and-append against that signer tip. The sole global order is the contiguous receipt sequence and `previousReceiptHash` chain. `sequence` starts at 1 without gaps; `previousReceiptHash` is null only at sequence 1. Receipt signature is Ed25519 over UTF-8 canonical receipt without signature; receiptHash is SHA-256 hex of canonical complete receipt. `keyId` is SHA-256 hex of UTF-8 of the relay public-key Base64 SPKI string. Relay keys and their half-open validity ranges `[valid_from_sequence, valid_to_sequence)` are governed by `RelayKeyRotated`.

## 3. Event interfaces

```ts
type EventType = 'AccountCreated'|'DealCreated'|'DealConsented'|'EscrowFunded'|'DeliverableSubmitted'|'PrecheckCompleted'|'DealAccepted'|'DealRejected'|'DisputeOpened'|'JuryAssigned'|'JuryVoted'|'DisputeResolved'|'EscrowReleased'|'FeeBurned'|'ReputationEvent'|'TreasurySpend'|'CurrencyIssued'|'AccountInvited'|'KeyRotated'|'DealAutoAccepted'|'DealExpired'|'AppealOpened'|'JurorReplaced'|'AppealFeeSettled'|'EvidenceRevealed'|'RelayKeyRotated'|'PolicyUpdated';
interface Approval { signer: Pubkey; sig: Sig }
interface AccountCreated { pubkey: Pubkey; recovery_commitment: Hash; invite_ref: Hash | null }
interface AccountInvited { invitee: Pubkey; expires: IsoUtc }
interface KeyRotated { old_pubkey: Pubkey; new_pubkey: Pubkey; recovery_pubkey: Pubkey; new_recovery_commitment: Hash; sig: Sig }
interface DealCreated { deal_id: Uuid; buyer: Pubkey; seller: Pubkey; amount: Amount; criteria_hash: Hash; deadline: IsoUtc }
interface DealConsented { deal_id: Uuid; seller: Pubkey; consent_sig: Sig }
interface EscrowFunded { deal_id: Uuid; from: Pubkey; amount: Amount }
interface DeliverableSubmitted { deal_id: Uuid; content_hash: Hash; precheck_ref: Hash | null }
interface PrecheckCompleted { deal_id: Uuid; content_hash: Hash; result: 'pass'|'fail'|'inconclusive'; checker_id: Pubkey; sig: Sig }
interface DealAccepted { deal_id: Uuid; by: Pubkey }
interface DealRejected { deal_id: Uuid; by: Pubkey; reason_hash: Hash }
interface DealAutoAccepted { deal_id: Uuid; by: Pubkey }
interface DealExpired { deal_id: Uuid; by: Pubkey }
interface DisputeOpened { deal_id: Uuid; by: Pubkey }
interface JuryAssigned { deal_id: Uuid; jurors: Pubkey[]; appeal_round: 0|1 }
interface JuryVoted { deal_id: Uuid; juror: Pubkey; vote: 'buyer'|'seller'; appeal_round: 0|1; sig: Sig }
interface JurorReplaced { deal_id: Uuid; appeal_round: 0|1; missing_juror: Pubkey; replacement: Pubkey }
interface DisputeResolved { deal_id: Uuid; outcome: 'buyer'|'seller'; appeal_round: 0|1 }
interface AppealOpened { deal_id: Uuid; by: Pubkey; fee_amount: Amount }
interface AppealFeeSettled { deal_id: Uuid; outcome: 'returned'|'burned'; amount: Amount }
interface EscrowReleased { deal_id: Uuid; to: Pubkey; amount: Amount }
interface FeeBurned { deal_id: Uuid; amount: Amount }
interface ReputationEvent { account: Pubkey; counterparty: Pubkey; deal_id: Uuid; delta: -1|0|1; reason_hash: Hash }
interface EvidenceRevealed { deal_id: Uuid; by: Pubkey; kind: 'criteria'|'reason'|'purpose'|'precheck-report'; salt: string }
interface TreasurySpend { recipient: Pubkey; amount: Amount; purpose_hash: Hash; nonce: Hash; approvals: Approval[] }
interface CurrencyIssued { recipient: Pubkey; amount: Amount; policy_id: string; basis_hash: Hash; grant_kind: 'activity'|'beta-grant'; nonce: Hash; approvals: Approval[] }
interface RelayKeyRotated { key_id: Hash; pubkey: Pubkey; valid_from_sequence: number; approvals: Approval[] }
interface PolicyUpdated { policy_version: number; params_hash: Hash; activation_sequence: number; approvals: Approval[] }
```
All payload objects have exactly these fields. Amounts are safe integers. `AMOUNT_MIN=2`, `AMOUNT_MAX=floor(MAX_SAFE_INTEGER/10000)=900719925474`; all intermediate arithmetic is checked. `JuryAssigned.jurors` is exactly 3 unique keys in round 0 or 5 in round 1. Approval lists are unique and structurally 2–3 entries; L3 requires two valid approvals. `policy_id` matches `/^[a-z0-9._-]{1,64}$/`. `EvidenceRevealed.salt` is exactly 64 lowercase hex characters (32 bytes) for criteria/reason/purpose; for `precheck-report`, salt MUST be the empty string because the report reference is an unsalted raw-content hash.

## 4. Attestations and action hashes

Kinds and bodies: `deal-consent` `{deal_id,buyer,seller,amount,criteria_hash,deadline}`; `precheck` `{deal_id,content_hash,result,checker_id}`; `jury-vote` `{deal_id,juror,vote,appeal_round}`; `treasury-approval` `{action_hash,signer}`; `key-rotation` `{old_pubkey,new_pubkey,new_recovery_commitment}`; `checkpoint` `{sequence,receipt_hash,key_id}`. Reputation attestations are removed. A treasury approval `action_hash` is SHA-256 hex of canonical action object: TreasurySpend `{action:"treasury-spend",recipient,amount,purpose_hash,nonce}`; CurrencyIssued `{action:"currency-issued",recipient,amount,policy_id,basis_hash,grant_kind,nonce}`; RelayKeyRotated `{action:"relay-key-rotated",key_id,pubkey,valid_from_sequence}`; PolicyUpdated `{action:"policy-updated",policy_version,params_hash,activation_sequence}`.

## 5. Signer authority and event-specific rules

`AccountCreated`: signer=pubkey; L3 requires a valid unused invitation, except `invite_ref=null` for configured genesis accounts. `AccountInvited`: signer on active inviters list. `KeyRotated`: signer=new_pubkey; recovery attestation must verify against recovery_pubkey, whose recovery commitment equals old account commitment. `DealCreated`: buyer. `DealConsented`: seller. `EscrowFunded`: buyer. `DeliverableSubmitted`: seller. `PrecheckCompleted`: checker_id. `DealAccepted`, `DealRejected`: buyer and `by=buyer`. `DealAutoAccepted`: seller and `by=seller`. `DealExpired`: buyer or seller and `by=signer`. `DisputeOpened`: buyer or seller and `by=signer`. `JuryVoted`: juror. `JuryAssigned`, `JurorReplaced`, `DisputeResolved`, `EscrowReleased`, `FeeBurned`, `AppealFeeSettled`: any existing current account, subject to projection. `AppealOpened`: underdog from round 0 and `by=signer`. `ReputationEvent`: account. `EvidenceRevealed`: deal party; `by=signer`. TreasurySpend, CurrencyIssued, RelayKeyRotated, PolicyUpdated: event signer must be one of at least two distinct, valid approvers in the active 2-of-3 policy.

Except AccountCreated, KeyRotated, and configured genesis-account initialization, signer must have been created before the event or be the current successor of an existing account. Historical signer resolution uses receipt order. An invitation is single-use and valid iff acceptedAt < expires; each pubkey can be created once. A rotation transfers balances, reputation history, outstanding deal party roles, and juror identity to the new current pubkey; historical events retain original keys. New key chain starts with null prevHash; old key cannot sign after rotation. **ANNAHME:** rotation is effective at its receipt sequence so replay has a single boundary; a timelock remains an open choice below. Social recovery is excluded.

`EscrowReleased` for seller and `FeeBurned` are both required once; release first enters `release_pending_fee`; FeeBurned signer must equal release signer. Refunds to buyer are fee-free. **ANNAHME:** fee-free refunds preserve the entire escrow and avoid charging for seller nonperformance; abuse is a buyer and seller colluding to create nominal deals, obtain completed-deal/reputation effects or manipulate activity while using deadline refunds. Disallowing refunds or charging a cancellation fee are alternatives.

`DealAutoAccepted` is valid only after 7 days from delivery with no accept/reject. `DealAccepted` or `DealRejected` may be accepted from delivery through the 7-day boundary (acceptedAt <= delivery acceptedAt + 7 days); auto-accept requires strictly later. `DisputeOpened` follows rejection and is valid through 7 days after rejection (acceptedAt <= rejection acceptedAt + 7 days). **ANNAHME:** if no dispute is opened by then, rejection is final and buyer may refund; this makes escrow resolution finite. Alternatives are indefinite hold or automatic escalation to a neutral process.

Prechecks are informational and never change settlement. They must reference the latest submitted content hash. Only policy-listed checkers have an effective precheck; an unlisted checker event remains valid but is marked ineffective. `precheck_ref` is SHA-256 of raw local report bytes, null if absent.

Reputation: at most one event per `(deal_id, account)`; parties must be the deal's two parties and deal must be completed or decided. Dispute outcome contributes derived reputation: add +1 to the winning party and -1 to the losing party (before explicit reputation deltas); this is a projection and emits no event. reason_hash is a salted commitment.

## 6. Commitment, jury, and appeal rules

Criteria, reason, purpose commitments are SHA-256 of UTF-8 `skillx/v1/commit/<kind>\n`, then 32 salt bytes, then content bytes; `kind` is criteria, reason, or purpose. Salt stays private until EvidenceRevealed. EvidenceRevealed publishes the salt, not content; content remains in the content adapter. Deliverable must remain available through the appeal window. A missing `EvidenceRevealed` is an observable ledger fact; jury decides the evidentiary consequence, including whether unavailable evidence weighs against seller.

Jury pool snapshot is at acceptedAt of DisputeOpened (round 0) or AppealOpened (round 1): current accounts with ≥20 completed deals, ≥5 distinct counterparties, sum of reputation deltas (no decay)>0, and AccountCreated at least 60 days earlier; exclude both deal parties and, round 1, round-0 jurors. Round 0 selects 3; round 1 selects 5; quorum is all selected and binary votes ensure no tie. `BEACON_DELAY=10`. Seed is receiptHash at sequence trigger sequence + 10. Assignment is valid only once that receipt exists. A future beacon prevents the opener from choosing a known seed by timing the dispute, because the seed receipt is committed only after the trigger; it also prevents choosing among candidate juries using advance knowledge. Relay collusion can bias or predictably grind the beacon, and relay withholding can delay assignment.

Deterministic selection, with byte encoding fixed: `seedBytes` are the 32 raw bytes decoded from lowercase hex receiptHash; counter `i` is unsigned 32-bit big-endian, starting at zero. SHA-256 digest interpreted as unsigned big-endian integer. Pool is sorted by UTF-8 bytewise ascending Pubkey Base64 string. For each draw, remove selected candidate:
```text
remaining = sorted(pool); chosen = []; i = 0
while chosen.length < required:
  h = SHA256(seedBytes || uint32be(i)); i += 1
  index = unsignedBigEndian(h) mod remaining.length
  chosen.push(remaining.removeAt(index))
return chosen
```
`JuryAssigned` must equal this ordered result. Vote deadline is VOTE_WINDOW=3 days after JuryAssigned acceptedAt. **ANNAHME:** 3 days provides practical response time while bounding escrow delay. After expiry any account may submit `JurorReplaced`; replacement is the next unused candidate in the same deterministic stream, recomputed with prior selected/replacements removed. **OFFEN:** if eligible pool is too small: (1) fail closed and leave dispute unresolved; strongest Sybil resistance, poor beta liveness; (2) lower thresholds by published policy; more liveness, weaker capture resistance; (3) use a smaller jury/quorum; lowest liveness cost, weakest independence. No option is selected.

AppealOpened is once only, by round-0 loser, within 3 days after round-0 DisputeResolved; it escrows `ceil(amount*1000/10000)`. For amount x integer fee is `floor((x*1000 + 9999)/10000)`. While that 3-day appeal window is open or appeal active, release is forbidden. If no appeal by the boundary, release per round-0 result becomes eligible. Round 1 JuryAssigned follows AppealOpened; round-1 decision is final and permits immediate release. AppealFeeSettled once: returned iff round-1 outcome differs from round-0, otherwise burned; amount equals escrowed appeal fee.

## 7. Validation levels

L1 structural/stateless: exact envelope and payload fields; canonical representability; type/version; key, signature, hash, UUID, ISO shape; amounts/ranges; enums, arrays and cross-field shape; timestamp skew. Event timestamp is a signer claim and must satisfy `abs(timestamp - receipt.acceptedAt) <= TIMESTAMP_SKEW`, where TIMESTAMP_SKEW=5 minutes. DealCreated deadline must be later than its acceptedAt. No validation uses current system time.

L2 chain/account: validate event signature; same-signer prevHash; atomic compare-and-append (stale tip => CHAIN_LINK, competing append/fork => FORK); signer account existence/current-key authority; invitation/recovery; receipt signature/key validity, sequence contiguous from 1, eventHash binding, previousReceiptHash linkage; acceptedAt nondecreasing. Relay key range is `[valid_from_sequence, valid_to_sequence)`. Historical verification uses receipts only; never current time.

L3 state, accounting, policy: run deal state machine and deadline/window checks against trigger receipt.acceptedAt; apply active policy; compute jury and treasury approvals; replay uniqueness; invitation redemption; balances, escrow, reputation, appeal fee, issuance and burn. `EscrowFunded` requires buyer funds. `EscrowFunded` and `DeliverableSubmitted` require acceptedAt < deadline. Refund without delivery is valid at acceptedAt >= deadline while escrowed. Policy for event at sequence s is the document whose greatest activation_sequence ≤ s. All money calculations checked.

## 8. Deal state machine

All times below refer to receipt.acceptedAt. `D` is deal deadline, `tX` is acceptedAt of named event, `E` is escrow amount, `F=ceil(E*100/10000)`. Seller settlement sends E-F then burns F. Buyer refund sends E and has no fee.

| State | Trigger; signer | Time/guard | Ledger movement | Next |
|---|---|---|---|---|
| created | DealCreated; buyer | unique id | none | created |
| created | DealConsented; seller | valid consent attestation | none | consented |
| created/consented | DealExpired; either party | acceptedAt ≥ D; no escrow | none | expired |
| consented | EscrowFunded; buyer | acceptedAt < D; sufficient funds | buyer→escrow E | escrowed |
| escrowed | DeliverableSubmitted; seller | acceptedAt < D | none | delivered |
| escrowed | EscrowReleased; any account | acceptedAt ≥ D, no delivery | escrow→buyer E | refunded |
| delivered | PrecheckCompleted; listed checker effective, otherwise informational | content hash matches latest submission | none | delivered |
| delivered | DealAccepted; buyer | t ≤ tDelivery+7d | none | accepted |
| delivered | DealRejected; buyer | t ≤ tDelivery+7d | none | rejected |
| delivered | DealAutoAccepted; seller | t > tDelivery+7d; neither other event | none | accepted |
| rejected | DisputeOpened; either party | t ≤ tReject+7d | none | disputed |
| rejected | EscrowReleased; any account | t > tReject+7d and no dispute | escrow→buyer E | refunded |
| disputed | JuryAssigned/Voted/Replacement; any / juror / any | deterministic; vote window 3d | none | disputed |
| disputed | DisputeResolved round 0; any | all 3 valid votes | none; appeal window starts | resolved (appeal window open) |
| resolved | AppealOpened; round-0 loser | t ≤ tResolve0+3d; funds available | loser→appeal escrow A | appealed |
| resolved | EscrowReleased; any | t > tResolve0+3d, no appeal | escrow→winner (seller: E-F; buyer: E) | seller: release_pending_fee; buyer: refunded |
| appealed | JuryAssigned/Voted/Replacement; any / juror / any | round 1 deterministic; vote window 3d | none | appealed |
| appealed | DisputeResolved round 1; any | all 5 valid votes | none | resolved-final |
| resolved-final | AppealFeeSettled; any | once; reverse iff outcomes differ | appeal escrow→loser or burn | resolved-final |
| accepted/resolved/resolved-final | EscrowReleased; any | authorized settlement final | escrow→seller E-F or buyer E | seller: release_pending_fee; buyer: refunded |
| release_pending_fee | FeeBurned; same signer as release | exact F, once | burn F | completed |

Release after acceptance becomes eligible immediately. For resolution, do not release while appeal window is open or an appeal is active. `completed`, `refunded`, `expired` are terminal. Any missing/duplicate/out-of-order transition is STATE or DUPLICATE.

## 9. Accounting and supply

Each account has spendable balance; deal escrow and appeal escrow are ledger liabilities. CurrencyIssued credits recipient and increases issued supply by amount. TreasurySpend debits treasury and credits recipient equally. EscrowFunded debits buyer and credits deal escrow equally. Seller release debits escrow by E-F, credits seller E-F, then FeeBurned debits escrow F and decreases supply by F; pair must equal original escrow. Refund debits escrow E and credits buyer E. AppealOpened debits appellant and credits appeal escrow A; returned settlement debits appeal escrow and credits appellant A; burned settlement debits appeal escrow and decreases supply A. No other event moves funds.

For every event: `totalSpendable + totalEscrow + totalAppealEscrow = issuedSupply`; after a burn both sides decrease by the same amount. Treasury transfer and escrow lock/release preserve the sum; issuance increases both by amount. Reject any underflow/overflow, unauthorized negative balance, or mismatch.

## 10. Policy, relay checkpoints, errors, changeability

All changeable parameters live in versioned off-chain policy documents, identified by on-chain hash: fee and time windows; pool thresholds and age; amount/treasury limits; multisig members and threshold; inviters, genesis accounts and checkers; issuance rules. Multisig is 2 of 3 per active policy. Schema-frozen: envelope/serialization/crypto, event and payload shapes/names, 3/5 jury sizes and full quorum, integer arithmetic semantics, receipt and chain format. PolicyUpdated versions strictly increase; first policy activates at sequence 1; activation sequence is unique and validated against receipt order. Approval action hash binds all listed fields. `(action,nonce)` is unique; RelayKeyRotated key_id and PolicyUpdated policy_version are their replay keys (REPLAY).

First relay key is pinned in the genesis policy out of band; its keyId and validity begin at sequence 1. Subsequent key rotations require active multisig approval and create non-overlapping sequence ranges. Relay signs `checkpoint` attestations. Clients exchange checkpoints by an independent gossip channel and verify signatures/key ranges; same sequence with different receipt_hash values signed by the relay proves equivocation. On proof, client retains both signed checkpoints, halts trust in that relay's later receipts, shares proof with peers, and requires an independently verified recovery/governance decision before resuming.

Stable codes (each error includes JSON path): `VERSION`, `ENVELOPE`, `TIMESTAMP`, `PAYLOAD`, `SIGNATURE`, `UNKNOWN_TYPE`, `UNKNOWN_FIELD`, `MISSING_FIELD`, `FIELD_FORMAT`, `AMOUNT`, `LIMIT`, `SIGNER_AUTHORITY`, `ATTESTATION`, `CHAIN_LINK`, `FORK`, `RECEIPT_SEQUENCE`, `RECEIPT_EVENT_HASH`, `RECEIPT_LINK`, `RECEIPT_SIGNATURE`, `KEY_UNKNOWN`, `STATE`, `WINDOW`, `POLICY`, `REPLAY`, `DUPLICATE`, `INSUFFICIENT_FUNDS`, `JURY_MISMATCH`.

## 11. Change log and remaining decisions

Pre-release revision 2: replaces the pre-release v1 schema before any ledger exists; version stays 1. Subsequent v1 changes are frozen. Assumptions/open options are catalogued in `open-questions.md`; implementations must not silently vary them.

## 12. Self-review

| Check | Result |
|---|---|
| (a) No frozen element unintentionally changed | Yes |
| (b) Every deadline uses acceptedAt | Yes |
| (c) Every money movement has a booking and preserves total supply | Yes |
| (d) No rule requires system time or randomness except the defined beacon | Yes |
| (e) Every ANNAHME and OFFEN item is listed in open-questions.md | Yes |
| (f) Tables and text across the specification documents are consistent | Yes |
