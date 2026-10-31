# Assumptions and open decisions — Pre-release revision 2

| Point | Options | Recommendation | Cost if delayed |
|---|---|---|---|
| Refund fee-free (E4, ANNAHME) | Fee-free refund; charge cancellation fee; prohibit refund | Fee-free, since seller nonperformance should not reduce buyer principal; monitor collusive nominal deals used to farm completed-deal/reputation/activity benefits | Refund accounting and abuse policy may diverge |
| Rejection without dispute (E6, ANNAHME) | Rejection final and buyer refund after 7d; indefinite escrow; automatic neutral escalation | Final after 7d to guarantee finite escrow lifecycle | Funds can remain locked or implementations disagree |
| Beacon drawn from future receipt (E7, ANNAHME) | Future receipt + relay; prior known event hash; external multi-source randomness | Future receipt limits opener timing choice; relay collusion/withholding remains | Jury assignments cannot be independently reproduced |
| Vote window (E7, ANNAHME) | 1, 3, or 7 days | 3 days balances response time and escrow liveness | Unbounded or inconsistent jury deadlines |
| Pool too small (E7, entschieden) | Fail closed; lower thresholds by policy; reduce jury size/quorum | Published policy fallback tiers lower the thresholds step by step; if no tier yields a large enough pool the draw fails with `POLICY`. Jury sizes 3/5 stay frozen | Disputes may stall when no tier fits |
| Key rotation timelock (E13, entschieden) | Immediate at receipt; fixed delay; delay with emergency override | Delay with emergency override: the old key is frozen at once when the rotation is submitted, the new key takes over after the policy delay (`keyRotationDelayMs`, 3 days). In a dispute the seed (recovery key) always wins; proof is the seed words only, no human judge | Lost-key recovery may be abused or unusably slow |
| Salt for precheck-report (E11) | Empty sentinel; random salt despite unsalted report hash | Empty string sentinel; report uses raw content hash and is not a commitment | Client encodings may disagree |
| Missing evidence consequence (E11) | Jury discretion; presumption against seller; invalidate claim | Jury discretion, with missing reveal recorded as evidence; settlement rule not encoded as an automatic presumption | Evidence availability may be treated inconsistently |
| Unlisted checker (E12, ANNAHME) | Reject event; accept but ineffective; allow as advisory | Accept but ineffective so it cannot change settlement and remains auditable | Precheck policy can alter deal conclusions |
| Recovery derivation paths (E13, entschieden) | `m/44'/999999'/0'/0'/0'` account and `m/44'/999999'/0'/1'/0'` recovery; project-specific hardened paths; externally generated keys | Project-specific hardened SLIP-0010 Ed25519 paths: account `m/19283'/0'/0'`, recovery `m/19283'/0'/1'` (19283 = 0x4B53); BIP39 passphrase optional and changes both keys | Wallet interoperability and recovery may break |
| Currency conservation interpretation (E17) | Burn reduces issued supply; keep supply constant via burn account | Burn reduces issued supply, maintaining spendable+escrow=issued supply | Cross-implementation balances diverge |
| Policy activation sequence constraints (E15) | Any future sequence; next receipt only; governance-scheduled future sequence | Allow future sequence, but require strictly increasing versions and unique activation sequence | Parameter updates can be ambiguous at boundaries |
| Initial relay key bootstrap (E14) | Genesis policy pin; compiled key; first multisig event | Genesis policy pins first key at sequence 1 | No verifiable receipt chain can start |

All listed items are explicitly marked assumptions or open choices in `protocol-v1.md`; a closed assumption is still recorded here because it needs later review before deployment.
