# Changelog

## 2026-10-24
- Doku bereinigt (README, architecture, threat-model, code-follow-up, open-questions, protocol-v1 Rotation und kleiner Pool, keystore-spec). Entscheidungen: Treasury-Multisig 2-von-3 für die Beta, Juror-Auszahlung nur bis Treasury-Guthaben, Treasury nur über `genesisAccounting`, Listener-Befunde nicht auf dem Ledger.
- Tooling: CI-Workflow, ESLint-Konfiguration, Postgres-Integrationstests (`TEST_DATABASE_URL`); Windows: Verzeichnis-fsync übersprungen, Symlink-Test überspringt bei EPERM.
- Relay: asynchroner Schreibpfad (`submitAsync`, `startAsync`, `closeAsync`), `PostgresStore` (Port `SqlPort`, Migration 1, Advisory-Lock, append-only Trigger), `DealCreated` verlangt registrierte Parteien.
- Client: `keyStatus` und lokale Prüfung der Gegenpartei vor `DealCreated` (rotierte/eingefrorene Schlüssel).
- Betrieb: `apps/relay/main.ts` (Konfiguration über Umgebungsvariablen, Genesis mit SHA-256-Pin, Relay-Key-Datei 0600, `TRUSTED_PROXIES` fuer Rate-Limit hinter Proxy), `apps/relay/admin-cli.ts` (keygen, genesis build/hash), `apps/node-ports/pg-sql-port.ts`.
- `packages/listener`: Erkennung von Kreishandel (nur Lesezugriff, kein neuer Event-Typ).
- Tests: E2E `JurorReplaced` und Fallback-Tiers. Stand: 345 Tests, 344 grün, 1 übersprungen (BIP39-Wortliste).

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
