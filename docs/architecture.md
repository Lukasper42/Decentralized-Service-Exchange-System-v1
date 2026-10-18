# Architecture

## Current slice

`packages/domain/src/protocol.ts` is the TypeScript wire type source for Core Schema v1. `packages/crypto` implements canonical JSON, Ed25519 event and attestation signatures, receipt verification, and SHA-256. `packages/validation` validates an untrusted event against exact envelope and payload shapes using an injected `now`. `packages/chain-verifier` independently checks an ordered event prefix, relay receipts, and both hash links. `packages/domain/src/deal-machine.ts` folds structurally valid events into one deal state and receives unresolved dispute policies through an interface.

The policy projection is not a complete ledger authority. It cannot validate deterministic jury assignment without an eligibility snapshot and selection policy, and cannot verify treasury approvals until the supplied Core Schema completes the action-hash preimage. It must be composed with a global accounting projection before any relay accepts balance-changing events.

## Target boundaries

```text
Client ── LedgerClient port ── Relay adapter (MVP: one append-only node)
  │                                  │
  ├── local key and content          ├── shared validation
  └── verifies events/receipts        ├── total event order and receipts
                                     └── durable append-only store (not implemented)
```

The client must use the chain verifier to check signatures, event hashes, previous-event links, signed receipts, and receipt links independently. A later ABCI/CometBFT adapter may replace ledger transport and ordering implementation, but it must accept the same versioned events. No validator-set or consensus metadata belongs in the event envelope.

## Changeability rule

The wire schema, canonical encoding, signature preimages, and hash algorithms are frozen for v1. Transport, storage, content pinning, AI provider, jury policy, fee policy, reputation formula, treasury policy, and UI belong behind interfaces. Local usernames are not ledger identity. Content remains local or in an optional content adapter; only hashes are global.

## Not implemented

Production HTTP relay, atomic durable event store, global accounting/escrow projection, replay/idempotency index, paging client, encrypted keystore, BIP39 recovery, content-store adapter, precheck framework, jury eligibility/selection, issuance, reputation projection, moderation, CI workflow, and red-team suite remain future work. The roadmap in the source notes is a target plan, not a claim that those components exist.
