# Contributors

This file acknowledges contributions to the Decentralized Service Exchange System (DSES), including implementation, testing, documentation, and technical analysis. Recognition in this file does not determine copyright ownership, grant or transfer usage rights, or replace the repository's applicable license or any separate agreement.

## supreme — [@vasanthshettihallirajesh-netizen](https://github.com/vasanthshettihallirajesh-netizen)

**Contributions to circular-trading detection and off-ledger reporting:**

- Developed a circular-trading listener prototype that maps signed transfer events into a participant graph and checks for the required reverse-transfer pattern.
- Added prototype-level event-signing and validation logic, with tests covering signature tampering, `prevHash` chain validation, missing reverse transfers, and invalid transfer amounts.
- Prepared canonicalizer-integration documentation, an authoritative listener snapshot and checksum manifest, and reproducible compatibility-check tooling. The submitted validation reported 12/12 listener tests passing and a byte-for-byte match against the authoritative implementation.
- Inspected the existing `packages/listener` implementation and documented its circular-trading detection behavior and the remaining gaps for off-ledger signed-report emission and verification. The gap analysis also identified interface decisions needed before that separate listener integration could be completed.
- Implemented the off-ledger circular-trading report path merged in PR #4: report schema v1 and deterministic `finding_id`; canonical signed-report payloads; `POST /v1/reports`; report-shape, signature, and sequence-scoped listener-allowlist validation; and idempotent acceptance of duplicate findings.
- Added a durable NDJSON report outbox with restart recovery, pending-report replay, optional HTTP delivery, and exponential-backoff retries. The implementation keeps report handling separate from ledger events and does not change ledger sequence, state hash, or receipt chain.
- Added relay configuration and startup integration for the report receiver, CORS preflight handling when `ALLOWED_ORIGIN` is configured, tests, and `docs/listener-reports.md` documentation.

**Verification reported for PR #4:** TypeScript type-check passed; the report-receiver suite passed 10/10; and the full test run reported 362 tests, 354 passed, 0 failed, and 8 skipped (the PostgreSQL tests skipped without `TEST_DATABASE_URL`).

**Status note (checked 2026-11-09):** PR #4 — [Add circular-trading report receiver](https://github.com/Lukasper42/Decentralized-Service-Exchange-System-v1/pull/4) — was merged into `master` on 2026-10-31. This acknowledges the report-receiver implementation as merged repository work. The separate listener-slice integration is not represented as merged: PR #1 remains open and unmerged, PR #2 was closed without being merged, and PR #3 (the gap-analysis documentation) remains open and unmerged. The prototype, review, and documentation work in those submissions is acknowledged as such; it does not imply that those proposed changes landed in `master`.

This acknowledgement also does not imply that the separate two-party SkillX partner test has completed its end-to-end deal flow (deal creation, consent, escrow, deliverable, and acceptance); the Project Hub still records that test as pending.
