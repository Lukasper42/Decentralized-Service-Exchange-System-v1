import type {
  Hash,
  IsoUtc,
  Pubkey,
  Sig,
} from "./crypto-types.js";

export type LedgerEvent = {
  type: string;
  version: 1;
  payload: Record<string, unknown>;
  signer: Pubkey;
  timestamp: IsoUtc;
  prevHash: Hash | null;
  signature: Sig;
};

export type TransferEventKind =
  | "EscrowFunded"
  | "EscrowReleased";

export type TransferEdge = {
  kind: TransferEventKind;
  dealId: string;
  sender: Pubkey;
  receiver: Pubkey;
  amount: number;
  timestamp: IsoUtc;
};

export type GraphIngestError = {
  code:
    | "VERSION"
    | "UNKNOWN_TYPE"
    | "FIELD_FORMAT"
    | "AMOUNT"
    | "MISSING_FIELD"
    | "SIGNATURE"
    | "CHAIN";
  path: string;
  message: string;
};

export type IngestResult =
  | {
      ok: true;
      edge: TransferEdge | null;
      eventHash: Hash;
    }
  | {
      ok: false;
      error: GraphIngestError;
    };

export type EventVerifier = (
  event: LedgerEvent,
) => boolean;

export type EventHasher = (
  event: LedgerEvent,
) => Hash;

const KNOWN_EVENT_TYPES = new Set([
  "AccountCreated",
  "DealCreated",
  "DealConsented",
  "EscrowFunded",
  "DeliverableSubmitted",
  "PrecheckCompleted",
  "DealAccepted",
  "DealRejected",
  "DisputeOpened",
  "JuryAssigned",
  "JuryVoted",
  "DisputeResolved",
  "EscrowReleased",
  "FeeBurned",
  "ReputationEvent",
  "TreasurySpend",
  "CurrencyIssued",
  "RiskFlagged",
]);

export class TransferGraph {
  private edges: TransferEdge[] = [];
  private outgoing = new Map<Pubkey, TransferEdge[]>();
  private lastAcceptedEventHash: Hash | null = null;

  constructor(
    private verifyEvent: EventVerifier,
    private hashEvent: EventHasher,
  ) {}

  ingest(event: LedgerEvent): IngestResult {
    if (event.version !== 1) {
      return {
        ok: false,
        error: {
          code: "VERSION",
          path: "version",
          message: "event version must be 1",
        },
      };
    }
    if (!KNOWN_EVENT_TYPES.has(event.type)) {
      return {
        ok: false,
        error: {
          code: "UNKNOWN_TYPE",
          path: "type",
          message: `unknown event type: ${event.type}`,
        },
      };
    }
    if (!this.verifyEvent(event)) {
      return {
        ok: false,
        error: {
          code: "SIGNATURE",
          path: "signature",
          message: "event signature failed verification",
        },
      };
    }
    if (event.prevHash !== this.lastAcceptedEventHash) {
      return {
        ok: false,
        error: {
          code: "CHAIN",
          path: "prevHash",
          message:
            "event prevHash does not match the previous accepted event hash",
        },
      };
    }

    let edge: TransferEdge | null = null;
    if (
      event.type === "EscrowFunded" ||
      event.type === "EscrowReleased"
    ) {
      const parsed = parseTransferEvent(event);
      if (!parsed.ok) {
        return parsed;
      }
      edge = parsed.edge!;
      this.edges.push(edge);
      const existing =
        this.outgoing.get(edge.sender) ?? [];
      existing.push(edge);
      this.outgoing.set(edge.sender, existing);
    }

    const eventHash = this.hashEvent(event);
    this.lastAcceptedEventHash = eventHash;
    return {
      ok: true,
      edge,
      eventHash,
    };
  }

  edgesFrom(account: Pubkey): readonly TransferEdge[] {
    return this.outgoing.get(account) ?? [];
  }

  allEdges(): readonly TransferEdge[] {
    return this.edges;
  }

  lastEventHash(): Hash | null {
    return this.lastAcceptedEventHash;
  }
}

function parseTransferEvent(
  event: LedgerEvent,
): IngestResult {
  const payload = event.payload;
  const dealId = payload.deal_id;
  const amount = payload.amount;
  const sender = payload.from;
  const receiver = payload.to;

  if (typeof dealId !== "string") {
    return {
      ok: false,
      error: {
        code: "FIELD_FORMAT",
        path: "payload.deal_id",
        message: "deal_id must be a string",
      },
    };
  }
  if (!isValidAmount(amount)) {
    return {
      ok: false,
      error: {
        code: "AMOUNT",
        path: "payload.amount",
        message:
          "amount must be a positive safe integer",
      },
    };
  }
  if (typeof sender !== "string") {
    return {
      ok: false,
      error: {
        code: "MISSING_FIELD",
        path: "payload.from",
        message:
          "transfer payload must contain from",
      },
    };
  }
  if (typeof receiver !== "string") {
    return {
      ok: false,
      error: {
        code: "MISSING_FIELD",
        path: "payload.to",
        message:
          "transfer payload must contain to",
      },
    };
  }

  return {
    ok: true,
    edge: {
      kind: event.type as TransferEventKind,
      dealId,
      sender,
      receiver,
      amount,
      timestamp: event.timestamp,
    },
    eventHash: "",
  };
}

export function isValidAmount(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    !Object.is(value, -0)
  );
}
