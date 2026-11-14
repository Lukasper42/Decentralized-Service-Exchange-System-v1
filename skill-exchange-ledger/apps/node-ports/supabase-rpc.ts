import type { SupabaseRpcPort } from '../../packages/relay/src/supabase-ledger-store.js';

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
        // Do not forward Postgres/PostgREST error bodies to a public caller.
        throw new Error(`Supabase RPC failed (${response.status})`);
      }
      return (await response.json()) as T;
    } catch {
      throw new Error('Supabase RPC request failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}
