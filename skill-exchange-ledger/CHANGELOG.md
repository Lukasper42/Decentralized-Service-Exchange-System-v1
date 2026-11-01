# Changelog

## Unreleased

- Relay: CORS preflight (`OPTIONS /v1/*`) is answered when `ALLOWED_ORIGIN` is set; browser clients could not POST before.
- Off-ledger circular-trading reports (`POST /v1/reports`, report schema v1, domain prefix `skillx/v1/listener-report`): receiver with strict validation, listener allowlist (checked before the signature), idempotency by `finding_id`, durable NDJSON outbox that survives torn lines, `.done` markers and replay after restart (at-least-once), optional HTTP delivery (`REPORT_DELIVERY_URL`). Enabled only when `LISTENER_ALLOWLIST_FILE` and `REPORT_OUTBOX_FILE` are set. No ledger events, no protocol change.

## 2026-10-24
- Docs cleaned up (README, architecture, threat-model, code-follow-up, open-questions, protocol-v1 rotation and small pool, keystore-spec). Decisions: treasury multisig 2-of-3 for the beta, juror payout only up to the treasury balance, treasury funded only via `genesisAccounting`, listener findings not on the ledger.
- Tooling: CI workflow, ESLint configuration, Postgres integration tests (`TEST_DATABASE_URL`); Windows: directory fsync skipped, symlink test skips on EPERM.
- Relay: asynchronous write path (`submitAsync`, `startAsync`, `closeAsync`), `PostgresStore` (port `SqlPort`, migration 1, advisory lock, append-only trigger), `DealCreated` requires registered parties.
- Client: `keyStatus` and a local check of the counterparty before `DealCreated` (rotated/frozen keys).
- Operations: `apps/relay/main.ts` (configuration via environment variables, genesis with SHA-256 pin, relay key file 0600, `TRUSTED_PROXIES` for rate limiting behind a proxy), `apps/relay/admin-cli.ts` (keygen, genesis build/hash), `apps/node-ports/pg-sql-port.ts`.
- `packages/listener`: circular-trading detection (read-only, no new event type).
- Tests: E2E `JurorReplaced` and fallback tiers. Status: 345 tests, 344 passing, 1 skipped (BIP39 word list).

## Pre-release revision 2

One-time pre-release v1 break; no ledger exists. Version remains `1`. After this revision, v1 is frozen.

### E1 — Per-account event chains
- Global `prevHash` → per-signer event hash; null only for signer genesis → concurrent account streams become atomically appendable.
- Global compare-and-append → receipt-only global ordering plus signer-tip compare-and-append → forks and stale tips can be reported deterministically.

### E2 — Receipt time
- Wall-clock validation and event-timestamp deadlines → receipt.acceptedAt, 5-minute claim skew, monotone receipts → historical replay no longer depends on today's clock.

### E3 — Receipts
- Implicit order → signed sequenced receipt with event binding, previous receipt link, relay key id and acceptedAt → relay acceptance is verifiable.

### E4 — Fees and settlement
- Undefined fee and settlement → 100 bp integer fee, bounded amounts, paired seller release/burn and fee-free full refund → accounting conserves value; buyer cannot block release by withholding a later signature.

### E5 — Auto-accept
- Buyer-only explicit acceptance → seller-triggered DealAutoAccepted after seven days → abandoned reviews settle.

### E6 — Dispute window
- Unbounded dispute initiation → seven-day window after rejection and refund after lapse (assumption) → escrow has finite resolution path.

### E7 — Jury
- Policy-injected jury → snapshot eligibility, 3/5 full quorum, delayed receipt beacon, deterministic draw, vote deadline and replacement event → independent replay is possible; undersized pool remains open.

### E8 — Appeal
- Undefined appeal → one underdog appeal, fee escrow, three-day window, second jury, final outcome and fee settlement → appeal and release races are specified.

### E9 — Reputation
- Dual attestations → account-signed single event, one per party/deal and derived dispute outcome → no counterparty veto; salted reason commitment remains private until reveal.

### E10 — Treasury and replay
- Truncated action hash and incomplete issuance replay binding → exact canonical action objects, nonce on issuance, 2-of-3 approvals and replay keys → approvals bind the intended operation.

### E11 — Commitments and evidence
- Unsalted hashes and unclear evidence → domain-separated salted commitments and EvidenceRevealed → private content can be committed and later opening audited.

### E12 — Prechecks
- Unconstrained checker effects → latest-content binding and informational-only result; unlisted checkers are ineffective → precheck cannot determine payment.

### E13 — Accounts and recovery
- No invitations or rotation → invite lifecycle, recovery-key rotation, identity projection and derivation assumptions → beta access and key recovery are replayable; social recovery excluded.

### E14 — Relay key / equivocation
- Static implicit relay key → sequenced key rotation and signed checkpoints → clients can prove equivocation and stop trusting a forked relay.

### E15 — Versioned policy
- Unversioned mutable parameters → hashed policy documents activated by sequence → old history remains deterministic under later updates.

### E16 — Ed25519 strictness
- Provider-defined acceptance → RFC 8032 canonical and small-order rejection requirements → implementations share verification boundary.

### E17 — Deal state and money
- Partial flow → complete lifecycle table, expiry, appeal lock, release-pending-fee and global conservation equation → every transition has reproducible balance effects.

### E18 — Error codes
- Generic error set → stable chain, receipt, state, policy, replay, balance and jury codes → clients can handle failures consistently.

### E19 — Validation layers
- Mixed parsing and projection → L1 structural, L2 chain/account, L3 state/accounting/policy → code boundaries align with required context.

## Relay and keystore (code)
- Added `packages/relay` and `packages/keystore` on top of the existing crypto, validation, chain-verifier and deal-machine modules; `apps/node-ports` is the only place that reads OS entropy and the wall clock.


## Content package
- New `packages/content` (store, commitments/reveal, retention, CTP1 transport, precheck port), `packages/crypto/src/x25519.ts`, `Keystore.sharedSecretWith`, `nodeUniqueName`.
- Moderation from the upload deliberately not ported (undecided, see `docs/moderation-options.md`).
