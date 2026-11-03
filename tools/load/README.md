# SkillX relay load and integrity test

`tools/load/load.mjs` starts a real relay child process, submits signed events, measures load, downloads and verifies the chain, and (in PostgreSQL mode) tests restart persistence and optional crash recovery.

## Requirements

- Node.js 22.
- Build the ledger first: `cd skill-exchange-ledger && npm ci && npm run build`.
- For PostgreSQL mode, set `DATABASE_URL` to a `postgres://` URL for a disposable test database. The script refuses a non-empty `public` schema unless `--reset-db` is supplied. `--reset-db` drops and recreates that schema.
- The relay uses loopback `127.0.0.1:3055`; keep that port free.

## Examples

Default in-memory run (200 accounts, 200 deals, concurrency 8):

```sh
node tools/load/load.mjs
```

Larger in-memory run:

```sh
node tools/load/load.mjs --accounts 1000 --deals 1000 --concurrency 16
```

PostgreSQL run with reset and crash test (PowerShell):

```powershell
$env:DATABASE_URL = 'postgres://skill:skill@localhost:5432/skill_exchange_test'
node tools/load/load.mjs --mode postgres --reset-db --crash-test
```

Use `--keep` to retain and print the temporary working directory. The JSON report defaults to `load-report.json` in the current directory; change it with `--json <file>`.

## Output

- `mode`: relay storage mode (`memory` or `postgres`).
- `accounts` / `deals`: phase event count sent, count accepted with HTTP 201, error count and codes, wall-clock duration in milliseconds, accepted events per second, and request latency p50/p95/p99/max in milliseconds. Percentiles use nearest-rank.
- `tip`: final chain tip after any restart and crash test.
- `peak-rss-kb`: Linux `VmHWM` peak resident memory for the initial relay process, in kB; `n/a` on other platforms.
- `chain-download-ms`: time to download the initial full chain in pages of up to 500 entries; the entry count is shown alongside it.
- `tip-latency-p50-ms`: median latency of 50 sequential `GET /v1/tip` calls at the end of the run.
- `integrity.*`: `event-signatures` and `receipt-signatures` verify cryptographic signatures; `sequence-continuity` checks sequence numbers and missing entries; `receipt-chain` checks previous receipt hashes; `receipt-event-hash` links each receipt to its event; `signer-prev-hash` checks each signer's event chain; `checkpoint` verifies the latest checkpoint and its receipt; `entry-counts` compares account registrations and completed deals with the acknowledged load results.
- `restart.*` (PostgreSQL only): confirms clean stop, startup time in milliseconds, unchanged tip/state hash/checkpoint after restart, acceptance of one additional `DealCreated`, and integrity after restart.
- `crash.*` (`--crash-test`): reports the second 50-deal burst, highest acknowledged receipt sequence (`maxAcked`), recovered tip, startup time, and integrity after SIGKILL recovery.
- `result`: overall `OK` or `FAIL`.

Every `FAIL` is a failed check. Any event in the `accounts` or `deals` phase that did not return HTTP 201 also makes the run fail. During the crash burst, requests interrupted by SIGKILL are expected; the durability check is whether the recovered tip is at least `maxAcked` and the chain integrity checks pass. Exit codes are 0 for success, 1 for test failure, and 2 for usage or setup errors.

## Limits

This tests one relay process through local loopback. Events from an individual account are strictly sequential; different accounts can run in parallel. Memory mode cannot test persistence or restart behavior. Results depend on the machine, database, and runtime conditions and are not a capacity guarantee.
