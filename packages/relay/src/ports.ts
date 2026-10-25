/** Time source in epoch milliseconds (injected; the library never reads the wall clock). */
export interface ClockPort { nowMs(): number }
/** Where the relay's private keys come from. Never read from an environment variable inside the library. */
export interface KeySource {
  /** Base64 PKCS8 private key for a relay key id, or null when this operator does not hold it. */
  privateKeyFor(keyId: string): string | null;
}
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;
export type Logger = (event: string, fields: LogFields) => void;
