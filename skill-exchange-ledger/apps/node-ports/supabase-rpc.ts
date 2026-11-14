import type { SupabaseRpcPort } from '../../packages/relay/src/supabase-ledger-store.js';

export class SupabaseRpcError extends Error {
  readonly status: number;
  readonly sqlState: string | null;

  constructor(status: number, sqlState: string | null) {
    super('Supabase RPC request failed');
    this.name = 'SupabaseRpcError';
    this.status = status;
    this.sqlState = sqlState;
  }
}

export interface SupabaseRpcResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type SupabaseFetch = (
  input: string,
  init: {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<SupabaseRpcResponse>;

const ALLOWED_FUNCTIONS = new Set([
  'skillx_runtime_ledger_load',
  'skillx_runtime_ledger_append',
  'skillx_runtime_mailbox_get_key',
  'skillx_runtime_mailbox_put_key',
  'skillx_runtime_mailbox_add_message',
  'skillx_runtime_mailbox_list_messages',
  'skillx_runtime_mailbox_delete_message',
]);

/**
 * Minimal server-only Supabase Data API caller.
 * The service-role key must only be read from a Vercel server environment variable.
 * Never instantiate this module in browser code or expose its headers to the client.
 */
export class SupabaseRpcClient implements SupabaseRpcPort {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly fetchPort: SupabaseFetch;
  private readonly timeoutMs: number;

  constructor(options: {
    url: string;
    serviceRoleKey: string;
    fetchPort?: SupabaseFetch;
    timeoutMs?: number;
  }) {
    const url = new URL(options.url);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
      throw new Error('SUPABASE_URL must use HTTPS');
    }
    if (options.serviceRoleKey.trim().length < 20) {
      throw new Error('Supabase server credential is missing or invalid');
    }
    this.baseUrl = url.toString().replace(/\/+$/, '');
    this.serviceRoleKey = options.serviceRoleKey;
    this.fetchPort = options.fetchPort ?? (fetch as unknown as SupabaseFetch);
    this.timeoutMs = options.timeoutMs ?? 7000;
  }

  async rpc<T = unknown>(
    functionName: string,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    if (!ALLOWED_FUNCTIONS.has(functionName)) {
      throw new Error('Supabase RPC function is not allow-listed');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchPort(
        `${this.baseUrl}/rest/v1/rpc/${functionName}`,
        {
          method: 'POST',
          headers: {
            apikey: this.serviceRoleKey,
            authorization: `Bearer ${this.serviceRoleKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'accept-profile': 'public',
            'content-profile': 'public',
          },
          body: JSON.stringify(args),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        // Only retain the controlled SQLSTATE and HTTP status. Never retain or
        // forward Postgres messages, detail, hint, or request/credential data.
        let sqlState: string | null = null;
        try {
          const body: unknown = await response.json();
          if (
            typeof body === 'object' &&
            body !== null &&
            !Array.isArray(body) &&
            Object.hasOwn(body, 'code')
          ) {
            const candidate = (body as { code?: unknown }).code;
            if (typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate)) {
              sqlState = candidate;
            }
          }
        } catch {
          // A non-JSON gateway error still carries its HTTP status.
        }
        throw new SupabaseRpcError(response.status, sqlState);
      }
      if (response.status === 204) return undefined as T;
      try {
        return (await response.json()) as T;
      } catch {
        throw new Error('Supabase RPC returned invalid JSON');
      }
    } catch (error) {
      if (error instanceof SupabaseRpcError) throw error;
      throw new Error('Supabase RPC request failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}
