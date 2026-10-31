import type { SchedulerPort } from './ports.js';
import type { ApiError } from './types.js';
import type { RelayClient } from './relay-client.js';
import type { ChainVerifier } from './verify.js';

const POLL_INTERVAL_MS = 15000;
const MAX_PAGES = 1000;

export interface SyncOutcome {
  appended: number;
  error: ApiError | null;
}

function failure(code: 'TRANSPORT' | 'DIVERGENCE', message: string, path: string): ApiError {
  return { code, message, path };
}

/**
 * Lädt alle Einträge vom lokalen Stand + 1 bis `tip` in Seiten und prüft sie.
 * Bricht nach mehr als 1000 Seiten ab.
 */
export async function syncOnce(
  client: RelayClient,
  verifier: ChainVerifier,
  tip: number,
): Promise<SyncOutcome> {
  let appended = 0;
  let from = verifier.length + 1;
  let pages = 0;
  while (from <= tip) {
    const to = tip;
    const res = await client.entries(from, to);
    if (!res.ok) {
      return { appended, error: res.error };
    }
    for (const entry of res.value.entries) {
      const v = await verifier.append(entry);
      if (!v.ok) {
        return { appended, error: v.error };
      }
      appended++;
    }
    pages++;
    if (pages > MAX_PAGES) {
      return {
        appended,
        error: failure('TRANSPORT', 'Zu viele Seiten geladen (>1000)', '$.sync.pages'),
      };
    }
    if (res.value.next === null) {
      break;
    }
    if (res.value.next <= from) {
      return {
        appended,
        error: failure('TRANSPORT', 'Pagination kommt nicht voran', '$.sync.next'),
      };
    }
    from = res.value.next;
  }
  // Checkpoint-Prüfung nach dem Synchronisieren.
  const cpRes = await client.latestCheckpoint();
  if (cpRes.ok) {
    const cpCheck = await verifier.verifyCheckpoint(cpRes.value);
    if (!cpCheck.ok) {
      return { appended, error: cpCheck.error };
    }
  } else if (cpRes.error.code !== 'NOT_FOUND') {
    return { appended, error: cpRes.error };
  }
  return { appended, error: null };
}

/** Startet Polling alle 15 s; gibt eine Rückbau-Funktion zurück. */
export function startPolling(
  scheduler: SchedulerPort,
  tick: () => void,
): () => void {
  tick();
  const handle = scheduler.every(POLL_INTERVAL_MS, tick);
  return () => {
    scheduler.clear(handle);
  };
}
