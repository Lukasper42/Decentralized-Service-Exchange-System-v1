# Open protocol and policy decisions

These items remain configurable because Core Schema v1 does not freeze them. Do not add them as envelope or payload fields without a new protocol decision.

| Decision | Options to evaluate | Recommended next step | Cost if delayed |
| --- | --- | --- | --- |
| Treasury approval action hash | Complete the canonical action object; bind every spend/issuance field | Resolve the truncated source definition before implementing approval verification | Invalid or replayable approvals |
| Multisig policy | Fixed 2-of-3; configurable threshold and member list | Define a versioned policy source and membership update process | Treasury validation cannot be completed |
| Jury selection | Deterministic seed and eligible pool; tie handling | Specify unbiased selection input, eligibility snapshot, and replayable computation | Jury assignments cannot be independently verified |
| Dispute quorum | Fixed quorum or policy by round | Set quorum and tie behavior together with appeal rules | Dispute resolution can disagree across implementations |
| Appeal eligibility | Either party; deadline and one appeal; superseding outcome | Define who may trigger round 1 and whether the first outcome remains actionable | Escrow release may race with an appeal |
| Fee function | Fixed basis points, caps, minimum/maximum, rounding | Specify integer arithmetic and overflow/rounding vectors | Implementations may burn different amounts |
| Active user and issuance | Activity window and qualifying completed deals | Define deduplication, rate, caps, and policy version | Currency supply cannot be reproduced consistently |
| Reputation and decay | Event graph projection; decay by elapsed time/activity | Keep only signed raw events in the ledger; inject formula policy into readers | Scores can diverge if time basis is unspecified |
| Recovery | BIP39-derived account key; optional social recovery | Specify derivation path and backup UX before shipping identity tooling | Key-loss recovery may be incompatible later |
| Content retention | Local-only, optional pinning, retention term | Define deal-duration availability expectation and evidence archive | Dispute evidence may disappear |
| Moderation and legal review | Report, review, appeal, and jurisdiction process | Resolve before public beta; no cash-out without legal review | Enforcement and launch exposure |
| Option B governance | Validator selection, removal, quorum-loss behavior | Decide only when a multi-validator deployment is actually planned | Governance assumptions could force a migration |
