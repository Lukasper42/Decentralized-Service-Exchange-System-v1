# SkillX C8 – 14-day cloud partner test

This runbook applies only to the Preview branch `feat/c8-14d-serverless-test`.

## Cloud endpoints

- App: https://skillx-web-git-feat-c8-14d-serverless-test-lukaspsenner12-1356.vercel.app
- Relay base URL: https://skillx-web-git-feat-c8-14d-serverless-test-lukaspsenner12-1356.vercel.app/api/relay
- Pinned Relay public key: `MCowBQYDK2VwAyEAoGokUzOPTvWnIxTRaC5u1HxVsK1u1STluXGfI1O/jOs=`
- Genesis SHA-256: `6980d098fef7131e70f7240df5e28913f2d21f2b4720a88496bdeb8e0eeda4e4`
- Policy ID: `c8-fresh-20261122-14d`
- Voting window: 1,209,600,000 ms (14 days)

Both browsers must set the same Relay URL and Relay public key in Status and choose Save and connect. The app persists these settings in each browser's local storage. The Relay key above is not the Juror-1 account public key.

## Operator script

The versioned source is `scripts/c8-fresh-jury-test-14d.mjs`. Copy this file into the operator-only `SkillX-C8-Fresh-Test` directory as `c8-fresh-jury-test-14d.mjs`, alongside `genesis-14d.json` and `inviter.key`, before running it. The script intentionally expects the repository directory `Decentralized-Service-Exchange-System-v1` to be the sibling of that test directory.

Only this script is stored in Git. Never upload or commit `inviter.key`, `extra-keys.json`, any Juror vault, passwords, or private keys.

## Backend isolation

The Preview API uses `SKILLX_RELAY_RPC_PROFILE=c8-14d-test`, which routes to:

- `skillx_c8_14d_test.ledger_entries`
- `skillx_c8_14d_test.rate_buckets`
- `public.skillx_c8_14d_test_ledger_load()`
- `public.skillx_c8_14d_test_ledger_append(...)`
- `public.skillx_c8_14d_test_rate_limit(...)`

All three RPCs are SECURITY INVOKER with an empty search_path. Only service_role has schema usage and execute grants. Ledger RLS is enabled, the ledger is append-only, and appends serialize through a singleton write guard. The existing `skillx_c8_runtime.ledger_entries` table is not read or written by this test profile.

The 14-day test schema was verified empty (tip 0). The pre-existing C8 ledger was separately read and remained at 457 entries. The migration does not import, copy, update, or delete existing ledger rows.

## Test procedure

1. Operator and partner open the Preview app and configure the exact same Relay URL and pinned Relay public key in Status.
2. On the trusted operator/test-preparation device, run `c8-fresh-jury-test-14d.mjs setup` locally. The script reads `extra-keys.json`, `inviter.key`, and the existing Juror-1 vault from local disk, validates them, and prompts for the vault password without echo. These files must never be uploaded or committed.
3. The script creates six accounts, 48 training deals, the dispute, and a three-person jury assignment. Expected fresh-test ledger tip after setup: 457.
4. The script reports the actual JuryAssigned receipt time and deadline (receipt time + 14 days). Do not ask Juror 1 to vote until setup is confirmed and both browsers show the same assignment.
5. Juror 1 unlocks their own vault in their own browser and records the Buyer vote. No vault or password is shared. Expected tip after this vote: 458.
6. Run the script's `finish` phase locally after verifying the Juror-1 vote. It checks the exact event state, records Juror 2 Buyer and Juror 3 Seller, and resolves the dispute 2:1 for Buyer. Expected final tip: 461.

The 14-day period is a voting deadline, not a mandatory waiting period. If all votes are recorded earlier, the test can finish earlier.

## Security

This Preview endpoint is internet-reachable and is not Vercel password-protected. CORS is an origin restriction, not authentication. The API never exposes the server-side Supabase or Relay private key to browser code. Writes must be valid signed C8 events and the test profile has server-side rate limits. This Preview is for test data only; do not use it for production balances, real funds, or sensitive business records.
