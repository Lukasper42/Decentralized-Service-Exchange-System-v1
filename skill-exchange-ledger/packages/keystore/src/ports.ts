/** Injected entropy: the library never calls a random source itself. */
export interface EntropyPort { bytes(count: number): Uint8Array }
/** Injected time source in epoch milliseconds. */
export interface ClockPort { nowMs(): number }
/** Shape of an OS keychain adapter (no implementation in the MVP). */
export interface KeychainPort {
  store(label: string, secret: Uint8Array): Promise<void>;
  load(label: string): Promise<Uint8Array | null>;
  remove(label: string): Promise<void>;
}
/** What the user is asked to approve before a money-moving signature. */
export interface ConfirmRequest { readonly kind: 'event' | 'approval' | 'key-rotation'; readonly type: string; readonly digest: string }
export interface SigningPolicy { confirm?: (request: ConfirmRequest) => boolean | Promise<boolean> }
