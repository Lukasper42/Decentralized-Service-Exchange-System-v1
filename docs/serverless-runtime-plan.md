# SkillX serverless runtime plan

Status: isolated implementation branch `feat/serverless-supabase-runtime`.
This document does not change the existing local C8 partner-test files or Tailscale routes.

## Goal and constraints

Provide public preview endpoints for the existing SkillX web client using only the existing Vercel Hobby project and the existing Supabase Free project. The runtime is Vercel Node.js Functions plus Supabase PostgreSQL; there is no always-on server process.

Hard constraints:
- Total hosting budget remains USD 0/month. Do not activate billing, purchase a domain, or add paid integrations.
- Keep the existing local partner-test files and mailbox data unchanged.
- Use the existing Supabase project `ppfimytabiidxlklfcah`; do not create another project.
- Keep runtime tables separate from the existing Notion/documentation data.
- Never expose a Supabase service-role/secret key to browser code, GitHub, or chat.
- Do not present this software as production-ready for real balances or dispute resolution; it has no external security review or load testing.

## Deployment shape

- The Vercel project remains rooted at `skillx-web`.
- `/api/relay/*` and `/api/mailbox/*` preserve the existing HTTP contracts.
- Browser code calls Vercel endpoints only. Supabase service credentials stay server-side.
- Relay and mailbox implementations remain in their existing source packages and are imported by the Vercel functions.

## Chosen C8 migration source

The public test runtime must preserve the previously verified C8 partner snapshot, not create a fresh ledger or new relay identity.

Migration source files were copied byte-for-byte to the separate local directory:
`SkillX-C8-Migration-Source-20261114`

Files and hashes:
- `genesis-partner.json`: `83f14d9597da29209433c181c21f3af9fdf47268cd1cbf46798831142e5895c8`
- `relay-export-20261107-160504.json`: `759536cfe18458c6e98a7f65757bc4092ddaf50a88aa9ed601f9897b43bdb5a6`
- `mailbox.json`: `97ef3bf2f46baae2c5d7f6ce7a343c503ec93e6d172dde3e0a680b92533612c1`

Validation completed:
- The partner Genesis replays the one-entry export successfully and produces the exact stored snapshot state hash.
- The export has one `AccountCreated` event at receipt sequence 1. It is not the later full jury-test history.
- The event signer matches mailbox identity suffix `f5c3ef02`.
- The receipt key ID matches the relay key in the partner Genesis.
- Both mailbox key-bundle signatures and IDs validate; both original encrypted messages and sequence counters validate.
- The second mailbox identity `b09772b0` is retained in the mailbox migration, although it is not one of the partner Genesis accounts.

The existing C8 relay key must be used with `genesis-partner.json` so the stored receipt remains verifiable and subsequent relay receipts continue the same identity chain. No replacement relay key or genesis is planned.

## Database access strategy

Use the Supabase HTTPS Data API and narrowly scoped PostgreSQL RPCs from Vercel Functions, not a persistent Node `pg` pool. Vercel invocations are transient; the existing Relay `PostgresStore` depends on a session-level advisory lock and is unsuitable for this runtime.

All runtime data is isolated in a new private schema named `skillx_runtime`; existing `public` and `skillx` Notion data is not modified. Runtime tables have RLS enabled, no anon/authenticated table grants, and no public policies. RPC functions in `public` revoke execution from `PUBLIC`, `anon`, and `authenticated`; only the Vercel server-side `service_role` can execute them.

The service-role key must never be included in frontend code, browser storage, GitHub commits, or a `NEXT_PUBLIC_*` variable.

## Relay persistence and concurrency

- Store the canonical signed event + receipt JSON, checksum, sequence, event hash, signer, and previous signer hash.
- A singleton write guard serializes ledger appends. The append RPC checks the next global sequence and signer tip inside the same transaction.
- Each request loads and verifies the complete persisted ledger before serving it. This initial implementation is intended for a very small partner test, not a large ledger.
- The verified one-entry snapshot is inserted through a one-time import RPC that refuses to run if ledger/mailbox business data already exists. After successful import and readback verification, remove that import function.

## Mailbox persistence

Preserve the existing mailbox protocol and state:
- both public key bundles;
- original message IDs, encrypted envelopes, stored timestamps, and sequence numbers;
- monotonically increasing mailbox counters;
- the existing 14-day TTL, 200-message cap, 10,000-key cap, and 60-posts/minute limit.

The server continues to store only encrypted message envelopes; it must not receive plaintext. The import RPC is one-time and transactionally seeds the keys, counters, and messages without changing IDs or timestamps.

### Message-post idempotency

The serverless mailbox accepts an optional `Idempotency-Key` header containing 32 lowercase hexadecimal characters. Updated web clients generate one key per encrypted send and retain the exact encrypted envelope and key after an uncertain response. Repeating that request returns the original message ID without consuming another mailbox sequence, message slot, or per-minute post allowance. Reusing the same key with a different envelope returns HTTP 409. Idempotency records expire after the same 14-day period as mailbox messages. Legacy clients without the header remain supported but do not receive retry deduplication.

The database migration adds a private `skillx_runtime.mailbox_idempotency` table and a uniquely named six-argument RPC, `skillx_runtime_mailbox_add_message_idempotent`. The original four-argument `skillx_runtime_mailbox_add_message` remains available for older Preview instances. A distinct function name is required because Supabase PostgREST does not support overloaded function names.

## Preview CORS configuration

When the web app is served through the neutral alias, set the Preview/branch-scoped Vercel variable `SKILLX_ALLOWED_ORIGIN=https://skillx-web-six.vercel.app`. Without this explicit value, the function's `VERCEL_URL` fallback is the per-deployment hostname and does not match browser requests made through the alias. Keep this variable scoped to Preview and the `feat/serverless-supabase-runtime` branch; it is not a secret.

## Safe rollout and local cutover

The local Relay, mailbox service, web UI, and Tailscale routes remain untouched while the public runtime is prepared.

Because the public runtime preserves the C8 relay identity and mailbox IDs, two writable copies must not be used concurrently:
1. Import the verified snapshot and run read-only public health, tip, ledger-replay, and mailbox readback checks.
2. Keep the public endpoints unavailable to partner writes during this validation stage.
3. Before the partner begins using the public endpoints, stop the local Relay and local mailbox processes without deleting or modifying their files. This prevents two independent runtimes from creating divergent relay receipts or mailbox sequences under the same identities.
4. Once public writes begin, do not resume local writes from the old copy. Keep the local migration source and original local files as backups.
5. If public validation fails before cutover, leave the local services running and roll back only the public preview configuration/data, not the local test environment.

## Rollout gates

1. Finish and test the request-scoped Supabase adapters and Vercel API handlers.
2. Review the complete SQL, RLS, schema grants, RPC grants, and one-time import path before applying anything.
3. Confirm the Vercel preview build without changing the existing master/production deployment.
4. Apply the private runtime schema only to the existing Supabase project after approval.
5. Import the local migration-source files through a server-side one-time RPC; verify row counts, checksums, original IDs, sequence counters, and replayed state hash.
6. Remove the one-time import RPC after verification.
7. Add only server-side Vercel environment variables, deploy a branch preview, and perform read-only validation before the local-to-public cutover.
8. Only consider public partner writes after the local Relay and mailbox are stopped and the partner is ready to use the public service.

## Free-tier limits

A USD 0/month setup is quota-limited. Supabase Free projects may pause after inactivity and do not include automatic backups; Vercel and Supabase limits can restrict invocation, compute, and storage. The service cannot promise uninterrupted service or unlimited public usage.

No domain purchase, billing activation, paid service, new Supabase project, fresh Genesis, replacement Relay key, or production deployment is part of this plan.
