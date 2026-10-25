import type {
  TransferEdge,
  TransferGraph,
} from "../graph.js";

export type CircularTradingFinding = {
  ruleId: "circular-trading-pair";
  accountA: string;
  accountB: string;
  forward: TransferEdge;
  reverse: TransferEdge;
};

export function detectCircularTradingBetweenPair(
  graph: TransferGraph,
  accountA: string,
  accountB: string,
): CircularTradingFinding | null {
  for (const forward of graph.edgesFrom(accountA)) {
    if (forward.receiver !== accountB) continue;
    for (const reverse of graph.edgesFrom(accountB)) {
      if (reverse.receiver !== accountA) continue;
      return {
        ruleId: "circular-trading-pair",
        accountA,
        accountB,
        forward,
        reverse,
      };
    }
  }
  return null;
}
