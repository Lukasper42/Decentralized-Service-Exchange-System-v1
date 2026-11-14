# SkillX serverless runtime plan

Status: design for the isolated branch `feat/serverless-supabase-runtime`.
This document does not apply database migrations, create credentials, or change the existing local partner-test environment.

## Goal and constraints

Provide public preview endpoints for the existing SkillX web client using only the existing Vercel Hobby project and the existing Supabase Free project. The intended runtime is Vercel Node.js Functions plus Supabase PostgreSQL. There is no always-on server process.

Hard constraints:
- Keep the total hosting budget at USD 0/month. Do not activate billing, purchase a domain, or add paid integrations.
- Keep the existing local C8 partner test, its relay identity, genesis, ledger, mailbox data, and Tailscale routes unchanged.
- Use the existing Supabase project `ppfimytabiidxlklfcah`; do not create another project.
- Keep runtime tables separate from the existing Notion/documentation data.
- Do not expose Supabase secret/service-role credentials to the browser.
- Do not advertise this codebase as production-ready for real balances or dispute resolution; the current project README explicitly says it has no external security review or load testing.

## Deployment shape

- The Vercel project remains rooted at `skillx-web`.
- Node.js function entrypoints will live under `skillx-web/api/`:
  - `/api/relay/*` forwards to the existing Relay HTTP contract.
  - `/api/mailbox/*` forwards to the existing Mailbox HTTP contract.
- The Vercel project will need permission to include source files outside its root directory, because the authoritative Relay and Mailbox implementations live in sibling folders. This is a Vercel project setting and must be changed only after the function build has been prepared for preview.
- The browser will call Vercel endpoints only. Supabase credentials stay in server-side Vercel environment variables.

## Database access strategy

Use Supabase's HTTPS Data API and PostgreSQL RPC functions from the Vercel Functions, rather than keeping a Node `pg` connection open.

Reasons:
- Vercel invocations are transient; the current Relay `PostgresStore` holds a session-level advisory lock across the process lifetime.
- Supabase transaction pooling is intended for short-lived/serverless connections and does not support session-level advisory locks.
- Database RPC calls let each critical write execute atomically inside one PostgreSQL transaction.

Runtime data belongs in a new private schema named `skillx_runtime`, not in the existing `public` or `skillx` data schemas. RPC functions exposed through the Data API will be narrowly scoped, with execution revoked from `PUBLIC`, `anon`, and `authenticated`, and granted only to the server-side `service_role`. Runtime tables will have RLS enabled and no public policies. The service-role key must never be included in frontend code, browser storage, or a `NEXT_PUBLIC_*` variable.

## Relay persistence and concurrency

The runtime ledger table will preserve the current append-only entry format:
- sequence
- event hash
- signer
- previous signer hash
- checksum
- canonical JSON containing the signed event and signed receipt

A singleton guard row will serialize writes. The append RPC will lock it with `FOR UPDATE`, then validate the expected next sequence and the signer's current tip before inserting. Unique constraints will independently prevent duplicate event hashes, duplicate sequences, and signer-chain forks. An append-only trigger will reject updates and deletes.

Each invocation will load the ledger snapshot, verify stored checksums/canonical JSON, replay and verify the ledger using the existing code, and only then serve the request. A stale concurrent invocation must fail its compare-and-append check rather than produce a fork. The caller can retry; on retry an already committed event is detected as a duplicate.

This initial implementation favours correctness and a small test workload over large-ledger performance. Loading/replaying the complete ledger on each invocation is not intended for a large public deployment.

## Mailbox persistence

The mailbox adapter will preserve the existing protocol and limits:
- key bundles remain self-signed public metadata;
- envelopes remain end-to-end encrypted; the server must not see plaintext;
- 14-day message TTL;
- maximum 200 retained messages per mailbox;
- maximum 10,000 registered mailbox keys;
- maximum 60 message posts per mailbox per minute;
- monotonically increasing per-mailbox message sequence numbers, including after deletion/expiry.

These limits and counters must be enforced by transactional database RPCs, not only by in-memory state, because separate serverless invocations do not share reliable process memory.

## New public relay identity

The public test runtime must use a relay key and genesis that are independent of the still-running local C8 relay. Reusing one private relay key across two independent ledgers could produce conflicting receipt histories. The new private key will be generated locally and entered directly into Vercel's server-side environment settings; it must never be sent through chat or committed to GitHub. The matching public key/genesis data can be reviewed separately before deployment.

## Rollout gates

1. Complete the adapters and handlers in this branch; add tests for concurrency, sequence continuity, mailbox limits, expiry, and protocol compatibility.
2. Review the exact SQL/RPC definition and security grants. No database changes are applied until the SQL is reviewed.
3. Verify Vercel preview builds without changing the existing master deployment.
4. Apply the runtime schema to the existing Supabase project only after explicit approval, then verify it with read-only queries and tests.
5. Add server-only Vercel environment variables without printing their values, deploy a branch preview, and test health/read/write/readback behaviour.
6. Only consider a public production rollout after the partner test passes and free-tier limits, inactivity pausing, and lack of automatic free-tier backups are understood.

## Known free-tier constraints

A USD 0/month setup is necessarily quota-limited. Vercel and Supabase free tiers can impose invocation, compute, storage, and inactivity constraints; an inactive Supabase project may pause. The free setup must fail safely or be taken offline when limits are reached. It cannot promise uninterrupted service or unlimited public usage.

No domain purchase, billing activation, paid service, database migration, or production deployment is part of this plan.
