# Skill Exchange Ledger

A pseudonymous, federation-ready foundation for trading skills against an internal ledger currency. Accounts are Ed25519 keypairs; usernames are local labels. The MVP target is one append-only relay. Users verify events and receipts themselves. Deliverables stay with their owners; the ledger carries content hashes and deal metadata.

This repository is a protocol foundation, not a deployable exchange. It currently contains v1 protocol types, native Ed25519/SHA-256 helpers, structural validation, an independent event/receipt chain verifier, and a policy-driven deal state projection. It does not yet contain a production relay, persistent event store, complete accounting projection, client application, encrypted keystore, recovery workflow, jury selection, issuance policy, or treasury governance. Do not use it to hold real balances or resolve disputes.

## Frozen protocol

[`docs/protocol-v1.md`](docs/protocol-v1.md) mirrors Core Schema v1. Keep event names and payloads, canonical JSON, Ed25519 signature preimages, and hash rules stable. Future features belong behind adapters or policy interfaces where possible. Treasury approval preimage details are incomplete in the supplied schema and are deliberately not guessed.

## Development

Requirements: Node.js 22+.

```sh
npm install
npm run typecheck
npm test
```

`npm test` compiles the TypeScript and runs compiled `*.test.js` files with Node's built-in test runner. ESLint and coverage thresholds are not configured yet; they should be added alongside CI after the package layout and test suite settle.

## Architecture and limits

The shared validator is pure when called with an explicit current time. The deal projection receives policies for unresolved dispute decisions. The relay is intended to expose a total order and signed receipts, but no relay server exists yet. There are no validator-set or consensus fields, and no custom consensus implementation is planned. Content is not uploaded by this repository. Read the threat model before treating pseudonymity as privacy protection.
