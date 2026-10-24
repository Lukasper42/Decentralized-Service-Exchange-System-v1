import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { TransferGraph } from "../src/graph.js";
import { runListener } from "../src/index.js";
import {
  repositoryVerifyEvent,
  repositoryHashEvent,
  repositorySignEvent,
} from "./repositoryCryptoAdapter.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/circular-trading-ledger.json", import.meta.url),
    "utf8",
  ),
) as {
  accountA: string;
  accountB: string;
  accountAPrivateKey: string;
  accountBPrivateKey: string;
  listenerPubkey: string;
  listenerPrivateKey: string;
  now: string;
  prevHash: string;
  graphSubgraphHash: string;
  stateCheckpointHash: string;
  parameterHash: string;
  ledger: any[];
};

function listenerInput(ledger: any[] = fixture.ledger) {
  return {
    ledger,
    accountA: fixture.accountA,
    accountB: fixture.accountB,
    listenerKeypair: {
      publicKey: fixture.listenerPubkey,
      privateKey: Buffer.from(fixture.listenerPrivateKey, "base64"),
    },
    now: fixture.now,
    graphSubgraphHash: fixture.graphSubgraphHash,
    stateCheckpointHash: fixture.stateCheckpointHash,
    parameterHash: fixture.parameterHash,
    verifyEvent: repositoryVerifyEvent,
    hashEvent: repositoryHashEvent,
    signEvent: repositorySignEvent,
  };
}

describe("circular trading listener", () => {
  it("returns one valid signed RiskFlagged event", async () => {
    const result = await runListener(listenerInput());
    assert.equal(result.status, "risk-flagged");
    if (result.status !== "risk-flagged") {
      throw new Error("Expected a risk finding");
    }

    assert.equal(result.signedEvent.type, "RiskFlagged");
    assert.equal(result.signedEvent.signer, fixture.listenerPubkey);
    assert.equal(repositoryVerifyEvent(result.signedEvent), true);
    assert.equal(
      result.signedEvent.prevHash,
      repositoryHashEvent(fixture.ledger[fixture.ledger.length - 1]),
    );
    assert.equal(
      result.signedEvent.payload.graph_subgraph_hash,
      fixture.graphSubgraphHash,
    );
    assert.equal(
      result.signedEvent.payload.state_checkpoint_hash,
      fixture.stateCheckpointHash,
    );
    assert.equal(
      result.signedEvent.payload.parameter_hash,
      fixture.parameterHash,
    );
    assert.equal(
      new Set([
        fixture.graphSubgraphHash,
        fixture.stateCheckpointHash,
        fixture.parameterHash,
      ]).size,
      3,
    );
  });

  it("maps payload.from and payload.to into the graph", async () => {
    const result = await runListener(listenerInput());
    assert.equal(result.status, "risk-flagged");
    if (result.status !== "risk-flagged") {
      throw new Error("Expected a risk finding");
    }

    assert.equal(
      result.signedEvent.payload.forward_event.from,
      fixture.accountA,
    );
    assert.equal(
      result.signedEvent.payload.forward_event.to,
      fixture.accountB,
    );
    assert.equal(
      result.signedEvent.payload.reverse_event.from,
      fixture.accountB,
    );
    assert.equal(
      result.signedEvent.payload.reverse_event.to,
      fixture.accountA,
    );
  });

  it("rejects an input event with an invalid signature after tampering", async () => {
    const tamperedLedger = structuredClone(fixture.ledger);
    tamperedLedger[0].payload.amount = 999;
    assert.equal(repositoryVerifyEvent(tamperedLedger[0]), false);

    await assert.rejects(
      runListener(listenerInput(tamperedLedger)),
      /SIGNATURE/,
    );
  });

  it("rejects a validly signed event with an incorrect prevHash", async () => {
    const brokenLedger = structuredClone(fixture.ledger);
    const { signature: _signature, ...unsignedWithoutSig } = brokenLedger[1];
    void _signature;
    const unsignedEvent2 = {
      ...unsignedWithoutSig,
      prevHash: "0".repeat(64),
    };
    brokenLedger[1] = await repositorySignEvent(
      unsignedEvent2,
      Buffer.from(fixture.accountBPrivateKey, "base64"),
    );

    assert.equal(repositoryVerifyEvent(brokenLedger[1]), true);
    await assert.rejects(
      runListener(listenerInput(brokenLedger)),
      /CHAIN/,
    );
  });

  it("does not flag when the reverse transfer is missing", async () => {
    const result = await runListener(
      listenerInput(fixture.ledger.slice(0, 1)),
    );
    assert.equal(result.status, "no-finding");
  });

  const invalidAmounts: Array<[string, number]> = [
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["decimal", 10.5],
    ["zero", 0],
    ["negative amount", -10],
    ["negative zero", -0],
  ];

  for (const [label, amount] of invalidAmounts) {
    it(`rejects ${label} as a transfer amount`, () => {
      const badLedger = structuredClone(fixture.ledger);
      badLedger[0].payload.amount = amount;

      const graph = new TransferGraph(() => true, repositoryHashEvent);
      const result = graph.ingest(badLedger[0]);

      assert.equal(result.ok, false);
      if (result.ok) {
        throw new Error("Expected invalid amount to be rejected");
      }
      assert.equal(result.error.code, "AMOUNT");
      assert.equal(result.error.path, "payload.amount");
      assert.match(result.error.message, /positive safe integer/);
    });
  }
});
