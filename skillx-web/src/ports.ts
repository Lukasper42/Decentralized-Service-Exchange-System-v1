import type { IsoUtc } from './types.js';

export interface ClockPort {
  nowMs(): number;
  nowIso(): IsoUtc;
}

export interface RandomPort {
  bytes(n: number): Uint8Array;
}

export interface StoragePort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export type FetchPort = (
  url: string,
  init?: FetchInit,
) => Promise<FetchResponseLike>;

export interface CryptoPort {
  subtle: SubtleCrypto;
}

export interface FilePort {
  save(name: string, text: string): void;
  pick(): Promise<string | null>;
}

export type TimerHandle = unknown;

export interface SchedulerPort {
  every(intervalMs: number, fn: () => void): TimerHandle;
  clear(handle: TimerHandle): void;
}
