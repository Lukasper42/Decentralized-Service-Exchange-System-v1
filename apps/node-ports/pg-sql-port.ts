import type {
  SqlPort,
  SqlRows,
  SqlTx,
  SqlValue,
} from '../../packages/relay/src/postgres-store.js';

export interface PgQueryResult {
  rows: ReadonlyArray<Record<string, unknown>>;
}

export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
  release(error?: Error | boolean): void;
  /** pg clients emit 'error' when the connection drops while idle; an unhandled one would crash the process. */
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * True for a server-reported SQL error that leaves the connection usable. Node network errors (ECONNRESET, EPIPE, ...)
 * and the SQLSTATE classes for lost connections (08) and server shutdown (57P0x) mean the connection is gone.
 */
function isUsableSqlError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('code' in value)) {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  if (typeof code !== 'string' || !SQLSTATE.test(code)) {
    return false;
  }
  return !code.startsWith('08') && !code.startsWith('57P0');
}

function asError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}

export function createPgSqlPort(pool: PgPoolLike): SqlPort {
  let client: PgClientLike | undefined;
  let clientPromise: Promise<PgClientLike> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task);
    chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function getClient(): Promise<PgClientLike> {
    if (client !== undefined) {
      return Promise.resolve(client);
    }
    if (clientPromise !== undefined) {
      return clientPromise;
    }
    const connecting = pool.connect().then(
      (connected) => {
        connected.on?.('error', (error: Error) => {
          markBroken(connected, error);
        });
        client = connected;
        clientPromise = undefined;
        return connected;
      },
      (error: unknown) => {
        clientPromise = undefined;
        throw error;
      }
    );
    clientPromise = connecting;
    return connecting;
  }

  function markBroken(brokenClient: PgClientLike, error: unknown): void {
    if (client === brokenClient) {
      client = undefined;
      clientPromise = undefined;
      brokenClient.release(asError(error));
    }
  }

  async function runQuery(
    onClient: PgClientLike,
    text: string,
    params?: readonly SqlValue[]
  ): Promise<SqlRows> {
    try {
      const result = await onClient.query(
        text,
        params === undefined ? [] : [...params]
      );
      return { rows: result.rows };
    } catch (error) {
      if (!isUsableSqlError(error)) {
        markBroken(onClient, error);
      }
      throw error;
    }
  }

  function query(text: string, params?: readonly SqlValue[]): Promise<SqlRows> {
    if (closed) {
      return Promise.reject(new Error('sql port is closed'));
    }
    return enqueue(async () => {
      const connected = await getClient();
      return runQuery(connected, text, params);
    });
  }

  function transaction<T>(work: (tx: SqlTx) => Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(new Error('sql port is closed'));
    }
    return enqueue(async () => {
      const connected = await getClient();
      let transactionClosed = false;
      let rollbackAttempted = false;

      const tx: SqlTx = {
        query: async (
          text: string,
          params?: readonly SqlValue[]
        ): Promise<SqlRows> => {
          if (transactionClosed) {
            throw new Error('transaction is closed');
          }
          return runQuery(connected, text, params);
        },
      };

      async function rollback(): Promise<void> {
        if (rollbackAttempted) {
          return;
        }
        rollbackAttempted = true;
        try {
          await runQuery(connected, 'ROLLBACK');
        } catch {
          // The rollback error is intentionally ignored.
        }
      }

      try {
        await runQuery(connected, 'BEGIN');
        const value = await work(tx);
        try {
          await runQuery(connected, 'COMMIT');
          return value;
        } catch (commitError) {
          await rollback();
          throw commitError;
        }
      } catch (error) {
        await rollback();
        throw error;
      } finally {
        transactionClosed = true;
      }
    });
  }

  function close(): Promise<void> {
    if (closePromise !== undefined) {
      return closePromise;
    }
    closed = true;
    const promise = (async () => {
      await chain;
      const connected = client;
      client = undefined;
      clientPromise = undefined;
      if (connected !== undefined) {
        connected.release();
      }
      await pool.end();
    })();
    closePromise = promise;
    return promise;
  }

  return { query, transaction, close };
}

export function pgConnectionOptions(
  env: Readonly<Record<string, string | undefined>>
): { connectionString: string; max: number } {
  const url = env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('DATABASE_URL must be a postgres:// URL');
  }
  return { connectionString: url, max: 2 };
}