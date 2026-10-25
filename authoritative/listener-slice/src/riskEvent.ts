import { canonical } from "./crypto.js";
import type {
  Hash,
  IsoUtc,
  Pubkey,
  Sig,
} from "./crypto-types.js";
import type {
  TransferEdge,
} from "./graph.js";

export type TransferProjection = {
  kind: "EscrowFunded" | "EscrowReleased";
  deal_id: string;
  from: Pubkey;
  to: Pubkey;
  amount: number;
  timestamp: IsoUtc;
};

export type RiskAttestationBody = {
  rule_id: "circular-trading-pair";
  account_a: Pubkey;
  account_b: Pubkey;
  graph_subgraph_hash: Hash;
  state_checkpoint_hash: Hash;
  parameter_hash: Hash;
  forward_event: TransferProjection;
  reverse_event: TransferProjection;
};

export type RiskFlaggedPayload = RiskAttestationBody;

export type RiskFlaggedEvent = {
  type: "RiskFlagged";
  version: 1;
  payload: RiskFlaggedPayload;
  signer: Pubkey;
  timestamp: IsoUtc;
  prevHash: Hash | null;
  signature: Sig;
};

export type UnsignedRiskFlaggedEvent = Omit<
  RiskFlaggedEvent,
  "signature"
>;

export function buildUnsignedRiskFlaggedEvent(input: {
  finding: {
    ruleId: "circular-trading-pair";
    accountA: Pubkey;
    accountB: Pubkey;
    forward: TransferEdge;
    reverse: TransferEdge;
  };
  graphSubgraphHash: Hash;
  stateCheckpointHash: Hash;
  parameterHash: Hash;
  listenerPubkey: Pubkey;
  timestamp: IsoUtc;
  prevHash: Hash;
}): UnsignedRiskFlaggedEvent {
  const body: RiskAttestationBody = {
    rule_id: input.finding.ruleId,
    account_a: input.finding.accountA,
    account_b: input.finding.accountB,
    graph_subgraph_hash: input.graphSubgraphHash,
    state_checkpoint_hash: input.stateCheckpointHash,
    parameter_hash: input.parameterHash,
    forward_event: toProjection(input.finding.forward),
    reverse_event: toProjection(input.finding.reverse),
  };

  return {
    type: "RiskFlagged",
    version: 1,
    payload: body,
    signer: input.listenerPubkey,
    timestamp: input.timestamp,
    prevHash: input.prevHash,
  };
}

export function canonicalRiskFlaggedBytes(
  event: UnsignedRiskFlaggedEvent,
): Uint8Array {
  return new TextEncoder().encode(canonical(event));
}

export function canonicalRiskAttestationBodyBytes(
  body: RiskAttestationBody,
): Uint8Array {
  return new TextEncoder().encode(canonical(body));
}

function toProjection(
  edge: TransferEdge,
): TransferProjection {
  return {
    kind: edge.kind,
    deal_id: edge.dealId,
    from: edge.sender,
    to: edge.receiver,
    amount: edge.amount,
    timestamp: edge.timestamp,
  };
}
