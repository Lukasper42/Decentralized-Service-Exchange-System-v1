# Skill Exchange Ledger – Diagrams (Current Code and Core Schema v1)

> This file displays the diagrams as PNG images, so they render reliably on GitHub. The editable Mermaid source is [`diagrams.md`](diagrams.md). The images are in the [`diagrams/`](diagrams/) folder. Click an image to enlarge it.

## 1. Packages and Dependencies

[Packages and Dependencies](diagrams/01-pakete.png)

Green: has tests. Red: no tests. Blue: types only.

## 2. Validation Pipeline (`validateEvent`)

[Validation Pipeline (`validateEvent`)](diagrams/02-validierungspipeline.png)

## 3. Deal State Machine (`deal-machine.ts`)

[Deal State Machine (`deal-machine.ts`)](diagrams/03-deal-zustandsmaschine.png)

Note: `released` is a terminal state, even without `FeeBurned`. The machine does not enforce the fee. Self-transitions (`PrecheckCompleted`, `JuryAssigned`/`JuryVoted`, `FeeBurned`) are shown in the respective nodes.

## 4. Deal Flow (Sequence)

[Deal Flow (Sequence)](diagrams/04-deal-ablauf.png)

The relay does not exist yet. In the code, the sequence is only represented as a projection through `applyDealEvent`.

## 5. Chain Verification (`verifyChain`)

[Chain Verification (`verifyChain`)](diagrams/05-kettenpruefung.png)

Warning: `validateEvent` applies a 365-day window relative to `now`. Old chains fail after one year.

## 6. Data Structures: Event, Receipt, and Chaining

[Data Structures: Event, Receipt, and Chaining](diagrams/06-datenstruktur.png)

## 7. Signatures and Hashes

[Signatures and Hashes](diagrams/07-signaturen-hashes.png)

## 8. Who Can Sign Which Event

[Who Can Sign Which Event](diagrams/08-signer-rechte.png)

Red: The schema requires the seller to be the signer, but the code does not check this (neither the validator nor the state machine).

## 9. Target Architecture and Implementation Status

[Target Architecture and Implementation Status](diagrams/09-zielarchitektur.png)

Green: implemented. Yellow: partial (policies are injected; the fee is not enforced). Gray: not yet implemented.
