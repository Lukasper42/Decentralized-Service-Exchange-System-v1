# Skill Exchange Ledger – Diagrams (current code and Core Schema v1)

## 1. Packages and dependencies

```mermaid
flowchart LR
  P["domain/protocol.ts<br/>types, Result, err"]
  C["crypto/index.ts<br/>canonical, hash, Ed25519,<br/>receipt, attestation"]
  V["validation/index.ts<br/>validateEvent"]
  CV["chain-verifier/index.ts<br/>verifyChain"]
  DM["domain/deal-machine.ts<br/>applyDealEvent"]

  C --> P
  V --> P
  V --> C
  CV --> P
  CV --> C
  CV --> V
  DM --> P
  DM --> C

  classDef tested fill:#d7f0dc,stroke:#2e7d32,color:#111
  classDef untested fill:#fde2e2,stroke:#c62828,color:#111
  classDef types fill:#e8eef9,stroke:#3b5bdb,color:#111
  class C,V tested
  class CV,DM untested
  class P types
```

Green: has tests. Red: no tests. Blue: types only.

## 2. Validation pipeline (`validateEvent`)

```mermaid
flowchart TD
  IN["Input + now"] --> N{"now finite?"}
  N -- no --> E1["TIMESTAMP"]
  N -- yes --> O{"plain object?"}
  O -- no --> E2["ENVELOPE"]
  O -- yes --> VER{"version == 1?"}
  VER -- no --> E3["VERSION"]
  VER -- yes --> ENV{"exactly the 7 envelope fields?"}
  ENV -- no --> E2
  ENV -- yes --> T{"type known?"}
  T -- no --> E4["UNKNOWN_TYPE"]
  T -- yes --> TS{"timestamp in window?<br/>now - 365 days to now + 5 min"}
  TS -- no --> E1
  TS -- yes --> PL{"payload plain object?"}
  PL -- no --> E5["PAYLOAD"]
  PL -- yes --> KEYS{"signer and signature<br/>format ok?"}
  KEYS -- no --> E6["FIELD_FORMAT"]
  KEYS -- yes --> PREV{"prevHash null or Hash?"}
  PREV -- no --> E6
  PREV -- yes --> CP["checkPayload:<br/>fields, formats, amount,<br/>type-specific rules,<br/>attestations"]
  CP -- error --> E7["MISSING_FIELD, UNKNOWN_FIELD,<br/>FIELD_FORMAT, AMOUNT, LIMIT,<br/>ATTESTATION"]
  CP -- ok --> SA{"signer == expected signer<br/>for the event type?"}
  SA -- no --> E8["SIGNER_AUTHORITY"]
  SA -- yes --> SIG{"Ed25519 signature valid?"}
  SIG -- no --> E9["SIGNATURE"]
  SIG -- yes --> OK["ok: SignedEvent"]
```

## 3. Deal state machine (`deal-machine.ts`)

```mermaid
stateDiagram-v2
  [*] --> created: DealCreated
  created --> consented: DealConsented<br/>seller, consent_sig verified
  consented --> escrowed: EscrowFunded<br/>buyer, amount matches
  escrowed --> delivered: DeliverableSubmitted
  escrowed --> released: EscrowReleased refund<br/>buyer, after deadline
  delivered --> delivered: PrecheckCompleted
  delivered --> accepted: DealAccepted<br/>buyer
  delivered --> rejected: DealRejected<br/>buyer
  rejected --> disputed: DisputeOpened<br/>buyer or seller
  disputed --> disputed: JuryAssigned, JuryVoted
  disputed --> resolved: DisputeResolved<br/>quorum, majority
  resolved --> disputed: JuryAssigned round 1<br/>if canStartAppeal
  accepted --> released: EscrowReleased<br/>buyer is the only signer
  resolved --> released: EscrowReleased<br/>any account
  released --> released: FeeBurned<br/>same signer, settlementIsValid
  released --> [*]
```

Note: `released` is a final state even without `FeeBurned`. The machine does not enforce the fee.

## 4. Deal flow (sequence)

```mermaid
sequenceDiagram
  autonumber
  participant B as Buyer
  participant S as Seller
  participant R as Relay (not built yet)
  participant K as Checker
  participant J as Jury (3, then 5)

  B->>R: DealCreated
  S->>R: DealConsented (attestation deal-consent)
  B->>R: EscrowFunded
  S->>R: DeliverableSubmitted (content_hash)
  opt Precheck
    K->>R: PrecheckCompleted (attestation precheck)
  end
  alt Buyer accepts
    B->>R: DealAccepted
    B->>R: EscrowReleased (to seller)
    B->>R: FeeBurned
  else Buyer rejects
    B->>R: DealRejected
    B->>R: DisputeOpened (or seller)
    R-->>J: JuryAssigned (round 0, 3 jurors)
    J->>R: JuryVoted (attestation jury-vote)
    Note over R,J: DisputeResolved only with quorum and majority
    R->>R: DisputeResolved
    opt Appeal (policy)
      R-->>J: JuryAssigned (round 1, 5 jurors)
      J->>R: JuryVoted
      R->>R: DisputeResolved
    end
    R->>R: EscrowReleased (any account) + FeeBurned
  end
```

The relay does not exist yet. In the code, the order is only enforced as a projection through `applyDealEvent`.

## 5. Chain verification (`verifyChain`)

```mermaid
flowchart TD
  S["Start: prevEvent = null, prevReceipt = null"] --> L{"Next entry?"}
  L -- no --> DONE["ok: tip (sequence, event hash, receipt hash)"]
  L -- yes --> M{"event and receipt present?"}
  M -- no --> X1["ENVELOPE"]
  M -- yes --> VE["validateEvent with current now"]
  VE -- error --> X2["validator error"]
  VE -- ok --> H1{"event.prevHash == prevEvent?"}
  H1 -- no --> X3["CHAIN_LINK"]
  H1 -- yes --> SQ{"receipt.sequence == index + 1?"}
  SQ -- no --> X4["RECEIPT_SEQUENCE"]
  SQ -- yes --> EH{"receipt.eventHash == hash of event?"}
  EH -- no --> X5["RECEIPT_EVENT_HASH"]
  EH -- yes --> RL{"receipt.previousReceiptHash == prevReceipt?"}
  RL -- no --> X6["RECEIPT_LINK"]
  RL -- yes --> RS{"receipt signature valid<br/>(pinned relay key)?"}
  RS -- no --> X7["SIGNATURE"]
  RS -- yes --> UPD["prevEvent = hash of event<br/>prevReceipt = hash of receipt"]
  UPD --> L
```

Caution: `validateEvent` applies the 365-day window against `now`. Old chains fail verification after one year.

## 6. Data structure: events, receipts, linking

```mermaid
flowchart LR
  subgraph EVA["Event n-1"]
    e1["type, version, payload,<br/>signer, timestamp,<br/>prevHash, signature"]
  end
  subgraph EVB["Event n"]
    e2["type, version, payload,<br/>signer, timestamp,<br/>prevHash = hash(Event n-1),<br/>signature"]
  end
  subgraph RCA["Receipt n-1"]
    r1["sequence, eventHash,<br/>previousReceiptHash,<br/>acceptedAt, signature"]
  end
  subgraph RCB["Receipt n"]
    r2["sequence, eventHash = hash(Event n),<br/>previousReceiptHash = hash(Receipt n-1),<br/>acceptedAt, signature"]
  end
  e1 -- "prevHash (global in the code)" --> e2
  r1 -- "previousReceiptHash" --> r2
  e1 -. "eventHash" .-> r1
  e2 -. "eventHash" .-> r2
```

## 7. Signatures and hashes

```mermaid
flowchart TD
  subgraph SIGN["Sign an event"]
    core["Event without signature"] --> can1["canonical JSON<br/>(sorted keys, only strings,<br/>safe integers, booleans, null)"]
    can1 --> utf1["UTF-8 bytes"]
    utf1 --> sig1["Ed25519 signature<br/>(base64, 64 bytes)"]
  end
  subgraph HASH["Event hash"]
    full["Event with signature"] --> can2["canonical JSON"] --> sha1["SHA-256 (hex)"]
  end
  subgraph ATT["Attestation"]
    body["Body"] --> can3["canonical JSON"]
    pre["Prefix skillx/v1/&lt;kind&gt;\\n"] --> cat["prefix + canonical body"]
    can3 --> cat --> sig2["Ed25519 signature"]
  end
  subgraph CONT["Content hash"]
    raw["Raw bytes of the deliverable"] --> sha2["SHA-256 (hex)"]
  end
```

## 8. Who may sign which event

```mermaid
flowchart LR
  Buyer(("Buyer"))
  Seller(("Seller"))
  Checker(("checker_id"))
  Juror(("Juror"))
  Any(("Any account"))
  Appr(("Multisig approver"))
  Both(("Buyer or<br/>seller"))

  Buyer --- DC["DealCreated"]
  Buyer --- EF["EscrowFunded"]
  Buyer --- DA["DealAccepted"]
  Buyer --- DR["DealRejected"]
  Buyer --- ER1["EscrowReleased<br/>(acceptance, refund)"]
  Seller --- DCo["DealConsented"]
  Seller --- DS["DeliverableSubmitted"]
  Checker --- PC["PrecheckCompleted"]
  Juror --- JV["JuryVoted"]
  Both --- DO["DisputeOpened"]
  Any --- JA["JuryAssigned<br/>(must be recomputable)"]
  Any --- DRes["DisputeResolved<br/>(must be recomputable)"]
  Any --- ER2["EscrowReleased<br/>(after dispute)"]
  Any --- FB["FeeBurned<br/>(same signer as release)"]
  Appr --- TS["TreasurySpend"]
  Appr --- CI["CurrencyIssued"]
  NewAcc(("New account")) --- AC["AccountCreated"]
  Rater(("account<br/>in payload")) --- RE["ReputationEvent<br/>(counterparty co-signs)"]

  classDef gap fill:#fde2e2,stroke:#c62828,color:#111
  class DS gap
```

Red: the schema requires the seller as signer, but the code does not check this (neither the validator nor the state machine).

## 9. Target architecture and implementation status

```mermaid
flowchart TD
  subgraph CLIENT["Client (user)"]
    KS["Keystore + BIP39"]
    LDB["Local DB + content"]
    AI["Local AI (precheck)"]
    LC["LedgerClient<br/>submit, read, verify"]
    VER["Own verification"]
  end
  subgraph RELAY["Relay (MVP: 1 node)"]
    API["HTTP API"]
    STORE["Append-only store"]
    IDX["Idempotency index"]
    ORD["Total order + receipts"]
  end
  subgraph SHARED["Shared, deterministic"]
    VAL["validateEvent"]
    DM["applyDealEvent"]
    CH["verifyChain"]
    CR["crypto"]
    ACC["Accounts + escrow projection"]
    POL["Policies: fee, jury, quorum,<br/>reputation, multisig"]
  end
  CONT["Content store (adapter)"]

  LC --> API
  API --> VAL
  API --> ORD --> STORE
  API --> IDX
  VER --> CH
  CH --> VAL
  VAL --> CR
  DM --> CR
  ACC --> DM
  DM --> POL
  LDB --> CONT

  classDef done fill:#d7f0dc,stroke:#2e7d32,color:#111
  classDef part fill:#fff3cd,stroke:#b58900,color:#111
  classDef todo fill:#eceff1,stroke:#607d8b,color:#111,stroke-dasharray: 4 3
  class VAL,CH,CR done
  class DM part
  class KS,LDB,AI,LC,VER,API,STORE,IDX,ORD,ACC,POL,CONT todo
```

Green: implemented. Yellow: partial (policies injected, fee not enforced). Grey dashed: not built yet.
