import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonical as repoCanonical } from "../../../packages/crypto/src/index.js";
import { runListener as repoRun } from "../src/index.js";
import {
  repositoryVerifyEvent as repoVerify,
    repositoryHashEvent as repoHash,
      repositorySignEvent as repoSign,
      } from "../test/repositoryCryptoAdapter.js";

      const authoritativeDir = process.env.AUTHORITATIVE_LISTENER_DIR;
      if (!authoritativeDir) {
        console.error(
            "Set AUTHORITATIVE_LISTENER_DIR to the directory containing the authoritative listener implementation.",
              );
                process.exit(2);
                }

                const authoritativePath = resolve(authoritativeDir);
                const sliceCanonical = (
                  await import(pathToFileURL(resolve(authoritativePath, "src/crypto.ts")).href)
                  ).canonical;
                  const sliceRun = (
                    await import(pathToFileURL(resolve(authoritativePath, "src/index.ts")).href)
                    ).runListener;
                    const sliceAdapter = await import(
                      pathToFileURL(resolve(authoritativePath, "test/repositoryCryptoAdapter.ts")).href
                      );

                      const fixture = JSON.parse(
                        readFileSync(
                            new URL("../fixtures/circular-trading-ledger.json", import.meta.url),
                                "utf8",
                                  ),
                                  );

                                  function listenerInput(verifyEvent: any, hashEvent: any, signEvent: any) {
                                    return {
                                        ledger: fixture.ledger,
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
                                                                                        verifyEvent,
                                                                                            hashEvent,
                                                                                                signEvent,
                                                                                                  };
                                                                                                  }

                                                                                                  function unsignedEvent(event: Record<string, unknown>) {
                                                                                                    const { signature: _signature, ...unsigned } = event;
                                                                                                      void _signature;
                                                                                                        return unsigned;
                                                                                                        }

                                                                                                        const repoResult = await repoRun(
                                                                                                          listenerInput(repoVerify, repoHash, repoSign),
                                                                                                          );
                                                                                                          const sliceResult = await sliceRun(
                                                                                                            listenerInput(
                                                                                                                sliceAdapter.repositoryVerifyEvent,
                                                                                                                    sliceAdapter.repositoryHashEvent,
                                                                                                                        sliceAdapter.repositorySignEvent,
                                                                                                                          ),
                                                                                                                          );

                                                                                                                          if (
                                                                                                                            repoResult.status !== "risk-flagged" ||
                                                                                                                              sliceResult.status !== "risk-flagged"
                                                                                                                              ) {
                                                                                                                                console.error("MISMATCH: expected risk-flagged results");
                                                                                                                                  process.exit(1);
                                                                                                                                  }

                                                                                                                                  const repoBytes = Buffer.from(
                                                                                                                                    repoCanonical(unsignedEvent(repoResult.unsignedEvent)),
                                                                                                                                    );
                                                                                                                                    const sliceBytes = Buffer.from(
                                                                                                                                      sliceCanonical(unsignedEvent(sliceResult.unsignedEvent)),
                                                                                                                                      );

                                                                                                                                      if (!repoBytes.equals(sliceBytes)) {
                                                                                                                                        console.error("BYTE_MISMATCH");
                                                                                                                                          console.error("integrated:", repoBytes.toString("hex"));
                                                                                                                                            console.error("authoritative:", sliceBytes.toString("hex"));
                                                                                                                                              process.exit(1);
                                                                                                                                              }

                                                                                                                                              console.log("BYTE_FOR_BYTE_MATCH");
                                                                                                                                              console.log("signed-bytes:", repoBytes.toString("hex"));
