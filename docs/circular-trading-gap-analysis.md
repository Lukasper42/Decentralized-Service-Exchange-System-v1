# Circular-trading listener gap analysis

## Scope

This document identifies the functionality currently missing from
`packages/listener` for circular-trading detection. It proposes no
implementation yet.

The existing listener is read-only. It analyzes already-verified ledger
entries and does not write findings to the ledger.

## Existing functionality

`packages/listener/src/circular-trading.ts` already provides:

- `transferEdges()` — builds buyer-to-seller transfer edges from verified
  `EscrowReleased` ledger entries.
- `detectCircularTradingBetweenPair()` — detects a direct two-account cycle
  where value moved from A to B and later from B to A.
- `findCircularTradingPairs()` — finds all such pairs deterministically.
- Key-rotation resolution, so an account’s historical activity remains linked
  to its current key.
- `attestationBody()` — builds canonical evidence for a finding.
- `findingHash()` — computes a stable SHA-256 identifier for that evidence.

Funding and refunds are correctly excluded because they do not represent a
buyer-to-seller trade settlement.

## Missing functionality

### 1. Signed off-ledger report emission

The listener can create finding evidence and a finding hash, but it cannot yet
emit a complete signed report.

Missing:

- A versioned off-ledger report envelope.
- A function that signs the canonical report content.
- A function that returns the signed report to a caller or relay-side consumer.

### 2. Signed-report verification

There is no function that lets another component verify an off-ledger risk
report independently.

Missing:

- Structural validation of the report envelope.
- Verification of the Ed25519 signature over the canonical report content.
- Verification that the report is bound to the underlying finding and its
  finding hash.

### 3. Reporter authority

The repository does not define who may sign a circular-trading risk report.

Missing:

- The permitted reporter identity or role.
- Whether the reporter is a relay, an independent risk service, or another
  authorized account.
- How a verifier obtains and trusts the reporter public key.

### 4. Report delivery boundary

The listener package contains detection logic only. It does not define where an
emitted report goes.

Missing:

- The port or interface through which a signed report is emitted.
- Whether the report is delivered to a client, an operational service, or
  another off-ledger consumer.
- Whether report delivery requires persistence, retry, or acknowledgment.

## Protocol constraints

Protocol v1 freezes the ledger event types and attestation kinds. There is no
`risk-report` attestation kind and no `RiskFlagged` ledger event.

Therefore, this work must not:

- Add a `RiskFlagged` ledger event.
- Add a new protocol attestation kind.
- Duplicate the existing listener.
- Copy an authoritative listener implementation into the repository.
- Modify unrelated modules.

## Required decision before implementation

Decision 6 is not present in the repository documentation. Before implementing
the signed report, the following must be confirmed:

1. The exact decision-6 requirement or external specification.
2. The required report schema and version.
3. The permitted report signer and its trust model.
4. The required delivery boundary for the signed report.

Until those are confirmed, the only safe conclusion is that the listener needs
a narrowly scoped off-ledger signed-report capability; the exact envelope and
authority model must come from decision 6.


## Confirmed off-ledger report requirements

Decision 6 now defines the report schema and signer/trust model.

### Report schema

The report retains the existing evidence body:

- `rule_id`
- Canonically sorted `account_a` and `account_b`
- Forward and reverse references: `deal_id`, `release_event_hash`, `sequence`, `amount`, and `accepted_at`
- `through_sequence`

The report additionally includes:

- `report_version`: `1`
- `through_receipt_hash`
- A stable `finding_id`
- `listener_pubkey`
- `created_at`, obtained through the clock port
- `signature`

`finding_id` must be stable and derived from the rule, account pair, and both release hashes. It must exclude `through_sequence`. The current sequence-dependent `findingHash` must not be used as the finding identifier.

The signed payload contains references and hashes only. It must not contain copies of ledger events. Signing uses the domain prefix `skillx/v1/listener-report\n` followed by canonical JSON. The `signature` field is excluded from the signed payload.

### Signer and trust model

The report is signed with a dedicated listener Ed25519 key. This key is separate from account, treasury, and relay keys and has no ledger privileges.

The receiver validates signatures strictly and maintains an allowlist containing the listener public key together with its `valid_from_sequence` and `valid_to_sequence` validity range.

Key rotation remains off-ledger. Reports signed by a previous listener key remain valid for sequences within that key’s authorized range.

### Remaining gap

The delivery interface for emitting or delivering the signed report has not yet been confirmed. Implementation remains blocked until that boundary is defined.
