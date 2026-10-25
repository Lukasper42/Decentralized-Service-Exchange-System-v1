# Architecture

## Current slice

`packages/domain/src/protocol.ts` is the TypeScript wire type source for Core Schema v1 (27 event types, stable error codes, constants); `amount.ts` holds checked integer arithmetic and the fee formulas. `packages/crypto` implements canonical JSON, RFC 8032-strict Ed25519 event, receipt and attestation signatures, receipt/relay-key/commitment/action hashes and SHA-256. `packages/validation` is L1 only: an exact table-driven envelope and payload check against the receipt time `acceptedAtMs`, with no state and no clock. `packages/chain-verifier` is L2: per-signer prevHash chains, the contiguous signed receipt chain, relay key ranges, monotone acceptedAt and equivocation detection; account checks run only when a `SignerResolver` is injected and the result reports `accountChecks: 'skipped' | 'applied'`. `packages/domain/src/deal-machine.ts` implements the full state table of spec section 8 and returns the new state plus the ledger `movements` of every event.

## Ports (`packages/domain/src/ports.ts`)

`DealContext` bundles `DealPolicyView` (fee and window values, effective checkers), `FundsView` (spendable balance) and `JuryOracle` (deterministic jurors and replacements; may answer JURY_MISMATCH, WINDOW or POLICY). `SignerResolver` is the account projection used by the chain verifier. `Movement` is the closed set of ledger effects the later accounting module applies. The machine never computes juries, balances or policy itself.

## Target boundaries

```text
Client ── LedgerClient port ── Relay adapter (MVP: one append-only node)
  │                                  │
  ├── local key and content          ├── shared validation
  └── verifies events/receipts        ├── total event order and receipts
                                     └── durable append-only store (file or Postgres)
```

The client must use the chain verifier to check signatures, event hashes, previous-event links, signed receipts, and receipt links independently. A later ABCI/CometBFT adapter may replace ledger transport and ordering implementation, but it must accept the same versioned events. No validator-set or consensus metadata belongs in the event envelope.

## Changeability rule

The wire schema, canonical encoding, signature preimages, and hash algorithms are frozen for v1. Transport, storage, content pinning, AI provider, jury policy, fee policy, reputation formula, treasury policy, and UI belong behind interfaces. Local usernames are not ledger identity. Content remains local or in an optional content adapter; only hashes are global.

## Not implemented

Implemented: HTTP relay, durable stores (file, Postgres), accounting/escrow, account/invitation/key-rotation, policy and multisig, jury pool and beacon, reputation, replay/idempotency, verifying client, encrypted keystore with BIP39/SLIP-0010 recovery, content store, precheck, issuance, CI workflow and a read-only circular-trading listener. Remaining: a user interface or CLI, load and scale work (snapshots), an external security review, a red-team suite and moderation operations. Social recovery is excluded.
