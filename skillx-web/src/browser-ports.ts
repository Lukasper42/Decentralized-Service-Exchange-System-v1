import { MAX_RESPONSE_BYTES, readCappedText } from './net-limits.js';
import type {
  ClockPort,
  CryptoPort,
  FetchPort,
  FilePort,
  RandomPort,
  SchedulerPort,
  StoragePort,
  TimerHandle,
} from './ports.js';
import type { IsoUtc } from './types.js';

// The only place in the project that produces date/time and randomness (per the spec).

function pad(n: number, len: number): string {
  return String(n).padStart(len, '0');
}

export function isoFromMs(ms: number): IsoUtc {
  const d = new Date(ms);
  return (
    pad(d.getUTCFullYear(), 4) +
    '-' +
    pad(d.getUTCMonth() + 1, 2) +
    '-' +
    pad(d.getUTCDate(), 2) +
    'T' +
    pad(d.getUTCHours(), 2) +
    ':' +
    pad(d.getUTCMinutes(), 2) +
    ':' +
    pad(d.getUTCSeconds(), 2) +
    '.' +
    pad(d.getUTCMilliseconds(), 3) +
    'Z'
  );
}

export const browserClock: ClockPort = {
  nowMs(): number {
    return Date.now();
  },
  nowIso(): IsoUtc {
    return isoFromMs(Date.now());
  },
};

export const browserRandom: RandomPort = {
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  },
};

export const browserCrypto: CryptoPort = {
  subtle: crypto.subtle,
};

export const browserStorage: StoragePort = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Storage unavailable: value stays in process state only */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const browserFetch: FetchPort = async (url, init) => {
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.headers ?? {},
    body: init?.body ?? null,
    signal: init?.signal ?? null,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    redirect: 'error',
    mode: 'cors',
  });
  return {
    status: res.status,
    json: async (): Promise<unknown> => {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES);
      return JSON.parse(text) as unknown;
    },
  };
};

export const browserFiles: FilePort = {
  save(name: string, text: string): void {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  },
  pick(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) {
          input.remove();
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          input.remove();
          resolve(typeof reader.result === 'string' ? reader.result : null);
        });
        reader.addEventListener('error', () => {
          input.remove();
          resolve(null);
        });
        reader.readAsText(file);
      });
      document.body.append(input);
      input.click();
    });
  },
};

export const browserScheduler: SchedulerPort = {
  every(intervalMs: number, fn: () => void): TimerHandle {
    return setInterval(fn, intervalMs);
  },
  clear(handle: TimerHandle): void {
    clearInterval(handle as number);
  },
};
