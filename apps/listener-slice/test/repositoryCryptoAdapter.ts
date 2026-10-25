import {
  createHash,
  sign,
  verify,
} from "node:crypto";
import { canonical } from "../../../packages/crypto/src/index.js";
import type { Sig } from "../src/crypto-types.js";
import type { LedgerEvent } from "../src/graph.js";

export function repositoryVerifyEvent(
  event: LedgerEvent,
): boolean {
  const { signature: _signature, ...unsigned } = event;
  void _signature;
  try {
    return verify(
      null,
      new TextEncoder().encode(canonical(unsigned)),
      {
        key: Buffer.from(
          event.signer,
          "base64",
        ),
        format: "der",
        type: "spki",
      },
      Buffer.from(
        event.signature,
        "base64",
      ),
    );
  } catch {
    return false;
  }
}

export function repositoryHashEvent(
  event: LedgerEvent,
): string {
  return createHash("sha256")
    .update(
      new TextEncoder().encode(canonical(event)),
    )
    .digest("hex");
}

export async function repositorySignEvent<
  T extends Omit<LedgerEvent, "signature">,
>(
  event: T,
  privateKey: unknown,
): Promise<T & { signature: Sig }> {
  const key = privateKey as Buffer;
  const signature = sign(
    null,
    new TextEncoder().encode(canonical(event)),
    {
      key,
      format: "der",
      type: "pkcs8",
    },
  );
  return {
    ...event,
    signature: signature.toString("base64"),
  };
}
