# Skill Exchange Ledger – Diagrams (Current Code and Core Schema v1)

The diagrams are available as PNG images and editable Mermaid source. Click an image to open it on GitHub, or use the adjacent Mermaid source link to edit it.

## 1. Packages and Dependencies

[![Packages and Dependencies](diagrams/01-packages.png)](diagrams/01-packages.png)

[Mermaid source](diagrams/01-packages.mmd)

Green: tested. Red: no tests. Blue: types only.

## 2. Validation Pipeline (`validateEvent`)

[![Validation Pipeline (`validateEvent`)](diagrams/02-validation-pipeline.png)](diagrams/02-validation-pipeline.png)

[Mermaid source](diagrams/02-validation-pipeline.mmd)

## 3. Deal State Machine (`deal-machine.ts`)

[![Deal State Machine (`deal-machine.ts`)](diagrams/03-deal-state-machine.png)](diagrams/03-deal-state-machine.png)

[Mermaid source](diagrams/03-deal-state-machine.mmd)

Note: `released` is a terminal state, even without `FeeBurned`. The machine does not enforce the fee. Self-transitions (`PrecheckCompleted`, `JuryAssigned`/`JuryVoted`, `FeeBurned`) are shown in the respective nodes.

## 4. Deal Flow (Sequence)

[![Deal Flow (Sequence)](diagrams/04-deal-flow.png)](diagrams/04-deal-flow.png)

[Mermaid source](diagrams/04-deal-flow.mmd)

The relay does not exist yet. In the code, the sequence is only represented as a projection through `applyDealEvent`.

## 5. Chain Verification (`verifyChain`)

[![Chain Verification (`verifyChain`)](diagrams/05-chain-verification.png)](diagrams/05-chain-verification.png)

[Mermaid source](diagrams/05-chain-verification.mmd)

Warning: `validateEvent` applies a 365-day window relative to `now`. Old chains fail after one year.

## 6. Data Structures: Event, Receipt, and Chaining

[![Data Structures: Event, Receipt, and Chaining](diagrams/06-data-structures.png)](diagrams/06-data-structures.png)

[Mermaid source](diagrams/06-data-structures.mmd)

## 7. Signatures and Hashes

[![Signatures and Hashes](diagrams/07-signatures-hashes.png)](diagrams/07-signatures-hashes.png)

[Mermaid source](diagrams/07-signatures-hashes.mmd)

## 8. Who Can Sign Which Event

[![Who Can Sign Which Event](diagrams/08-signer-permissions.png)](diagrams/08-signer-permissions.png)

[Mermaid source](diagrams/08-signer-permissions.mmd)

Red: The schema requires the seller to be the signer, but the code does not check this (neither the validator nor the state machine).

## 9. Target Architecture and Implementation Status

[![Target Architecture and Implementation Status](diagrams/09-target-architecture.png)](diagrams/09-target-architecture.png)

[Mermaid source](diagrams/09-target-architecture.mmd)

Green: implemented. Yellow: partial (policies are injected; the fee is not enforced). Gray: not yet implemented.
