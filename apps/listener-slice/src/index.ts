import {
  TransferGraph,
  type EventHasher,
  type EventVerifier,
  type LedgerEvent,
} from "./graph.js";
import { detectCircularTradingBetweenPair } from "./rules/circularTrading.js";
import {
  buildUnsignedRiskFlaggedEvent,
  canonicalRiskFlaggedBytes,
  canonicalRiskAttestationBodyBytes,
  type RiskFlaggedEvent,
} from "./riskEvent.js";

export type EventSigner = (
  event: Omit<RiskFlaggedEvent, "signature">,
  privateKey: unknown,
) => Promise<RiskFlaggedEvent>;

export type ListenerResult =
  | {
      status: "no-finding";
    }
  | {
      status: "risk-flagged";
      signedEvent: RiskFlaggedEvent;
      unsignedEvent: Omit<RiskFlaggedEvent, "signature">;
      bytesToSign: Uint8Array;
      attestationBodyBytes: Uint8Array;
    };

export type ListenerInput = {
  ledger: readonly LedgerEvent[];
  accountA: string;
  accountB: string;
  listenerKeypair: {
    publicKey: string;
    privateKey: unknown;
  };
  now: string;
  graphSubgraphHash: string;
  stateCheckpointHash: string;
  parameterHash: string;
  verifyEvent: EventVerifier;
  hashEvent: EventHasher;
  signEvent: EventSigner;
};

export async function runListener(
  input: ListenerInput,
): Promise<ListenerResult> {
  const graph = new TransferGraph(
    input.verifyEvent,
    input.hashEvent,
  );

  for (const event of input.ledger) {
    const result = graph.ingest(event);
    if (!result.ok) {
      throw new Error(
        `${result.error.code}: ${result.error.path}: ${result.error.message}`,
      );
    }
  }

  const finding = detectCircularTradingBetweenPair(
    graph,
    input.accountA,
    input.accountB,
  );

  if (!finding) {
    return {
      status: "no-finding",
    };
  }

  const precedingHash = graph.lastEventHash();
  if (precedingHash === null) {
    throw new Error(
      "CHAIN: prevHash: cannot append RiskFlagged to an empty ledger",
    );
  }

  const unsignedEvent = buildUnsignedRiskFlaggedEvent({
    finding,
    graphSubgraphHash: input.graphSubgraphHash,
    stateCheckpointHash: input.stateCheckpointHash,
    parameterHash: input.parameterHash,
    listenerPubkey: input.listenerKeypair.publicKey,
    timestamp: input.now,
    prevHash: precedingHash,
  });

  const signedEvent = await input.signEvent(
    unsignedEvent,
    input.listenerKeypair.privateKey,
  );

  if (!input.verifyEvent(signedEvent)) {
    throw new Error(
      "SIGNATURE: signature: emitted RiskFlagged signature failed verification",
    );
  }

  return {
    status: "risk-flagged",
    signedEvent,
    unsignedEvent,
    bytesToSign: canonicalRiskFlaggedBytes(unsignedEvent),
    attestationBodyBytes:
      canonicalRiskAttestationBodyBytes(
        unsignedEvent.payload,
      ),
  };
}
