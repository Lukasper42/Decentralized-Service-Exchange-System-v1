# Skill Exchange Ledger

A pseudonymous, federation-ready foundation for trading skills against an internal ledger currency. Accounts are Ed25519 keypairs; usernames are local labels. The MVP target is one append-only relay. Users verify events and receipts themselves. Deliverables stay with their owners; the ledger carries content hashes and deal metadata.

This repository is a protocol foundation, not a deployable exchange. It currently contains the 27 v1 event types, RFC 8032-strict Ed25519 and SHA-256 helpers (receipt hash, relay key id, commitments, action hashes, approvals, checkpoints), L1 structural validation against the receipt time, an L2 chain verifier (per-signer chains, signed receipt chain, relay key ranges, equivocation detection), checked amount arithmetic, and the complete deal state machine of spec section 8 behind injected ports (policy, funds, jury oracle). It also contains an append-only relay (HTTP API, signed receipts and checkpoints, file and Postgres stores, replay), the accounting, policy, jury and reputation projections, a verifying client library, an encrypted keystore with BIP39/SLIP-0010 recovery, a content store, an operator toolchain (`apps/relay/main.ts`, `admin-cli.ts`) and a read-only circular-trading listener. It has no user interface, no external security review and no load testing. Do not use it to hold real balances or resolve disputes.

## Frozen protocol

[`docs/protocol-v1.md`](docs/protocol-v1.md) mirrors Core Schema v1. Keep event names and payloads, canonical JSON, Ed25519 signature preimages, and hash rules stable. Future features belong behind adapters or policy interfaces where possible. The treasury approval preimage is defined in spec section 4 and implemented by `actionHash`/`approvalActionFor`.

## Development

Requirements: Node.js 22+.

```sh
npm install
npm run typecheck
npm test
```

`npm test` cleans `dist`, compiles the TypeScript and runs the compiled `*.test.js` files by glob with Node's built-in test runner. `npm run coverage` prints coverage; `npx eslint .` runs the strict type-checked lint. CI (`.github/workflows/ci.yml`) runs typecheck, tests with a Postgres service (`TEST_DATABASE_URL`), coverage and lint. Postgres integration tests are skipped without `TEST_DATABASE_URL`.

## Architecture and limits

The shared validator is pure: it takes the receipt time (`acceptedAtMs`) and never reads a clock. The deal machine receives policy, funds and jury selection through injected ports (`packages/domain/src/ports.ts`) and reports every ledger effect as `movements`. The relay exposes a total order and signed receipts; clients verify them independently. There are no validator-set or consensus fields, and no custom consensus implementation is planned. Content is not uploaded by this repository. Read the threat model before treating pseudonymity as privacy protection.
