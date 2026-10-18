# Skill Exchange Ledger: Core Schema v1

This document mirrors `Core Schema v1.txt`. The schema is the wire contract. A field, event name, signature preimage, or hash rule must not be changed in v1. New event types may be added without changing existing events. Parameters behind policies remain changeable.

## 1. Envelope and serialization

An event has exactly these fields: `type`, `version`, `payload`, `signer`, `timestamp`, `prevHash`, and `signature`. `version` is the integer `1`. `signer` and all public keys use strict base64 Ed25519 SPKI-DER. `signature` is strict base64 for exactly 64 bytes. `prevHash` is null only for the first event in the global ordered ledger.

Canonical JSON sorts object keys lexicographically by UTF-16 code unit and preserves array order. Values may be strings, safe integers, booleans, or null. Floats, negative zero, unsafe integers, undefined, bigint, lone surrogates, cycles, sparse arrays, and non-plain objects are rejected. Event signatures cover UTF-8 bytes of the canonical envelope without `signature`. Event hashes are lowercase SHA-256 hex of canonical complete signed events. Content hashes are lowercase SHA-256 hex of raw content bytes.

Timestamps use exactly `YYYY-MM-DDTHH:mm:ss.sssZ` and round-trip through UTC date parsing. Validation receives `now` as an input; the shared validator does not read the system clock.

Attestations sign UTF-8 bytes of `skillx/v1/<kind>\n` followed by canonical JSON of the specified body. Attestation signatures are separate from the event envelope signature.

## 2. Types

`Hash` is `/^[a-f0-9]{64}$/`; `Uuid` is lowercase UUIDv4; `Amount` is a positive safe integer in the smallest currency unit. Amount arithmetic must reject overflow. Pubkeys must round-trip strict base64 and have the Ed25519 SPKI OID and exact encoding length.

## 3. Event catalog

| Event | Payload fields | Required event signer |
| --- | --- | --- |
| `AccountCreated` | `pubkey`, `recovery_commitment` | `pubkey` |
| `DealCreated` | `deal_id`, `buyer`, `seller`, `amount`, `criteria_hash`, `deadline` | `buyer` |
| `DealConsented` | `deal_id`, `seller`, `consent_sig` | `seller` |
| `EscrowFunded` | `deal_id`, `from`, `amount` | `from` (buyer) |
| `DeliverableSubmitted` | `deal_id`, `content_hash`, `precheck_ref` | seller |
| `PrecheckCompleted` | `deal_id`, `content_hash`, `result`, `checker_id`, `sig` | `checker_id` |
| `DealAccepted` | `deal_id`, `by` | buyer |
| `DealRejected` | `deal_id`, `by`, `reason_hash` | buyer |
| `DisputeOpened` | `deal_id`, `by` | buyer or seller |
| `JuryAssigned` | `deal_id`, `jurors`, `appeal_round` | any account; assignment must be deterministically recomputed |
| `JuryVoted` | `deal_id`, `juror`, `vote`, `appeal_round`, `sig` | `juror` |
| `DisputeResolved` | `deal_id`, `outcome`, `appeal_round` | any account; outcome must be recomputed |
| `EscrowReleased` | `deal_id`, `to`, `amount` | buyer after acceptance/refund, or any account after resolution |
| `FeeBurned` | `deal_id`, `amount` | same signer as matching release |
| `ReputationEvent` | `account`, `counterparty`, `deal_id`, `delta`, `reason_hash`, `both_sigs` | `account` |
| `TreasurySpend` | `recipient`, `amount`, `purpose_hash`, `nonce`, `approvals` | one listed policy approver |
| `CurrencyIssued` | `recipient`, `amount`, `policy_id`, `basis_hash`, `grant_kind`, `approvals` | one listed policy approver |

The exact payload field names and nested shapes are those in the Core Schema. Unknown or missing fields are errors. `DealCreated` requires distinct buyer and seller, and deadline later than its event timestamp. `JuryAssigned` uses three distinct jurors for round 0 and five for round 1. Approval arrays contain 1–7 unique signers. Reputation parties must differ. `CurrencyIssued.policy_id` matches `/^[a-z0-9._-]{1,64}$/`.

## 4. Attestations

| Kind | Signed body |
| --- | --- |
| `deal-consent` | `{ deal_id, buyer, seller, amount, criteria_hash, deadline }` |
| `precheck` | `{ deal_id, content_hash, result, checker_id }` |
| `jury-vote` | `{ deal_id, juror, vote, appeal_round }` |
| `reputation-account` | `{ account, counterparty, deal_id, delta, reason_hash }` |
| `reputation-counterparty` | `{ account, counterparty, deal_id, delta, reason_hash }` |
| `treasury-approval` | `{ action_hash, signer }` |

The supplied Core Schema text truncates the definition of the treasury `action_hash` after the beginning of its canonical action object. Treasury approval verification must remain disabled until that preimage is completed and frozen. Implementations must not guess the omitted fields.

## 5. Deal flow and constraints

The intended order is `DealCreated → DealConsented → EscrowFunded → DeliverableSubmitted → DealAccepted → EscrowReleased → FeeBurned`, or rejection followed by dispute, jury assignment/votes/resolution, and release. Prechecks may occur after delivery. An escrow funding event before consent is invalid. A refund after deadline without delivery releases escrow to the buyer.

The current state projection enforces transitions, parties, assigned-juror voting, vote tally, appeal round, and signer matching for release/fee. Settlement conservation is injected as a policy because the Core Schema does not fully define how release and burn amounts are combined. The dispute quorum, deterministic jury selection, fee function, appeal eligibility, and multisig policy also remain injected decisions. Until those policies are defined and tested at the ledger boundary, the projection is not sufficient to authorize real balances.

## 6. Stable validation errors

Implementations use the stable codes `VERSION`, `ENVELOPE`, `TIMESTAMP`, `PAYLOAD`, `SIGNATURE`, `UNKNOWN_TYPE`, `UNKNOWN_FIELD`, `MISSING_FIELD`, `FIELD_FORMAT`, `AMOUNT`, `LIMIT`, `SIGNER_AUTHORITY`, and `ATTESTATION`. Each error includes the offending JSON path when available.

## 7. Frozen versus parameterized

Frozen: envelope fields, canonical serialization, event signature and hash rules, content hash, existing event names, and payload field names/types. Parameterized: fee function, jury selection beyond the schema's 3/5 sizes, dispute quorum, reputation formula/decay, activity definition, and multisig membership. Relay transport and content storage are adapters. The MVP is pseudonymous and starts with one relay; it does not claim anonymity or decentralization.
