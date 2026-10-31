export interface ClockPort {
  nowMs(): number;
  nowIso(): string;
}

export interface RandomPort {
  bytes(n: number): Uint8Array;
}

export interface StoreFilePort {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}
