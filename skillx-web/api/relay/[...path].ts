import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Projector, Relay } from '../../../skill-exchange-ledger/packages/relay/src/index.js';
import { SupabaseLedgerStore } from '../../../skill-exchange-ledger/packages/relay/src/supabase-ledger-store.js';
import { loadGenesis } from '../../../skill-exchange-ledger/apps/relay/genesis.js';
import { loadRelayKeySource } from '../../../skill-exchange-ledger/apps/relay/key-file.js';
import { systemClock } from '../../../skill-exchange-ledger/apps/node-ports/index.js';
import { SupabaseRpcClient } from '../../../skill-exchange-ledger/apps/node-ports/supabase-rpc.js';

const PREFIX = '/api/relay';
const MAX_BODY_BYTES = 65_536;
const MAX_EVENT_BYTES = 4_096;
const MAX_PAGE = 500;

type ErrorBody = { code: string; message: string; path: string };

function json(body: unknown, status = 200, origin: string | null = null): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (origin !== null) headers.set('access-control-allow-origin', origin);
  return new Response(JSON.stringify(body), { status, headers });
}

function apiError(code: string, message: string, path = '', status = 400, origin: string | null = null): Response {
  const body: ErrorBody = { code, message, path };
  return json(body, status, origin);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeRpcClient(): SupabaseRpcClient {
  return new SupabaseRpcClient({
    url: requiredEnv('SUPABASE_URL'),
    serviceRoleKey: requiredEnv('SUPABASE_SECRET_KEY'),
  });
}

async function enforceRateLimit(
  rpc: SupabaseRpcClient,
  bucketKeys: string[],
  limits: number[],
): Promise<boolean> {
  const allowed = await rpc.rpc('skillx_c8_runtime_rate_limit', {
    p_bucket_keys: bucketKeys,
    p_limits: limits,
    p_now_ms: systemClock.nowMs(),
    p_window_ms: 60_000,
  });
  if (typeof allowed !== 'boolean') {
    throw new Error('Invalid rate-limit response');
  }
  return allowed;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`Missing server configuration: ${name}`);
  return value.trim();
}

function envOrigin(): string | null {
  const configured = process.env.SKILLX_ALLOWED_ORIGIN?.trim();
  const deploymentHost = process.env.VERCEL_URL?.trim();
  const raw = configured || (deploymentHost ? `https://${deploymentHost}` : '');
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('SKILLX_ALLOWED_ORIGIN must use HTTPS');
  }
  return url.origin;
}

async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return null;

  // Avoid Vercel's lazy parsed request.body helper; consume the Web Request
  // stream directly so this works consistently for routed POST requests.
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return null;
  }
  const result = new TextEncoder().encode(raw);
  return result.byteLength <= limit ? result : null;
}

function parseIntParam(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d{1,15}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

async function openRelay(): Promise<Relay> {
  let stage = 'genesis_hash_and_validation';
  try {
    stage = 'genesis_json_environment';
    let genesisText = requiredEnv('SKILLX_GENESIS_JSON');

    stage = 'genesis_hash_environment';
    const expectedGenesisHash = requiredEnv('SKILLX_GENESIS_SHA256').toLowerCase();
    const expectedHashFormatValid = /^[a-f0-9]{64}$/.test(expectedGenesisHash);

    stage = 'genesis_hash_comparison';
    const actualGenesisHash = createHash('sha256').update(genesisText, 'utf8').digest('hex');
    if (!expectedHashFormatValid) {
      throw new Error('Public genesis hash check failed');
    }
    if (actualGenesisHash !== expectedGenesisHash) {
      // Vercel environment values can omit a final line feed. Accept that one
      // serialization difference only when restoring LF makes the exact
      // configured SHA-256 match the previously verified Genesis file.
      const withFinalLf = createHash('sha256').update(genesisText + '\n', 'utf8').digest('hex');
      if (withFinalLf === expectedGenesisHash) {
        genesisText += '\n';
      } else {
        console.error('skillx_relay_initialization_failed', {
          stage,
          expectedHashFormatValid,
          genesisTextLength: genesisText.length,
          finalLfRestoresExpectedHash: false,
        });
        throw new Error('Public genesis hash check failed');
      }
    }

    stage = 'genesis_document_validation';
    const projectorConfig = loadGenesis({
      path: 'SKILLX_GENESIS_JSON',
      expectedSha256: expectedGenesisHash,
      files: { readText: () => genesisText },
      policyDirectory: null,
    });

    stage = 'relay_private_key_validation';
    const keyText = requiredEnv('SKILLX_RELAY_PRIVATE_KEY');
    const keySource = loadRelayKeySource({
      path: 'SKILLX_RELAY_PRIVATE_KEY',
      files: {
        statMode: () => 0o600,
        readText: () => keyText,
      },
      expectedKeyId: projectorConfig.genesisRelayKey.keyId,
      expectedPublicKey: projectorConfig.genesisRelayKey.pubkey,
      platform: process.platform,
    });

    stage = 'supabase_ledger_open_and_replay';
    const store = new SupabaseLedgerStore(makeRpcClient());
    const relay = new Relay({
      store,
      keys: keySource,
      clock: systemClock,
      projector: new Projector(projectorConfig),
      policy: { maxEventBytes: MAX_EVENT_BYTES, checkpointEvery: 100 },
    });
    const started = await relay.startAsync();
    if (!started.ok) {
      console.error('skillx_relay_initialization_failed', {
        stage: 'ledger_replay',
        errorCode: started.error.code,
      });
      throw new Error('Persisted ledger verification failed');
    }
    return relay;
  } catch (error) {
    // Only stage and error class are logged. Never log keys, environment values,
    // database response bodies, or raw exception messages.
    console.error('skillx_relay_initialization_failed', {
      stage,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  }
}

async function handle(request: Request): Promise<Response> {
  let origin: string | null;
  try {
    origin = envOrigin();
  } catch {
    return apiError('STORE_FAILURE', 'Server configuration error', '', 503);
  }

  const requestOrigin = request.headers.get('origin');
  if (origin !== null && requestOrigin !== null && requestOrigin !== origin) {
    return apiError('BAD_REQUEST', 'Origin not allowed', '', 403, origin);
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...(origin === null ? {} : { 'access-control-allow-origin': origin }),
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      },
    });
  }

  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return apiError('NOT_FOUND', 'No such route', '', 404, origin);
  const rewrittenPath = url.searchParams.get('__route');
  const path = rewrittenPath !== null
    ? `/${rewrittenPath}`
    : url.pathname.slice(PREFIX.length) || '/';

  // Vercel overwrites x-forwarded-for with the actual public client IP. Only a
  // one-way hash is persisted in short-lived rate buckets; raw IPs are not stored.
  const forwardedIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const clientIp = isIP(forwardedIp) === 0 ? 'unknown' : forwardedIp;
  let rateRpc: SupabaseRpcClient;
  try {
    rateRpc = makeRpcClient();
    const ipBucket = 'ip:' + createHash('sha256').update(clientIp).digest('hex');
    if (!(await enforceRateLimit(rateRpc, [ipBucket], [120]))) {
      return apiError('RATE_LIMITED', 'Too many requests', path, 429, origin);
    }
  } catch {
    return apiError('STORE_FAILURE', 'Relay is temporarily unavailable', '', 503, origin);
  }

  let relay: Relay;
  try {
    relay = await openRelay();
  } catch {
    // Avoid leaking key, database, or Postgres details to anonymous clients.
    return apiError('STORE_FAILURE', 'Relay is temporarily unavailable', '', 503, origin);
  }

  if (request.method === 'GET' && path === '/v1/health') {
    return json({ ok: true, readOnly: relay.readOnly, tip: relay.tipSequence }, 200, origin);
  }
  if (request.method === 'GET' && path === '/v1/tip') {
    return json({ tipSequence: relay.tipSequence, stateHash: relay.stateHash }, 200, origin);
  }
  if (request.method === 'GET' && path === '/v1/checkpoints/latest') {
    const checkpoint = relay.latestCheckpoint();
    return checkpoint === null
      ? apiError('NOT_FOUND', 'No checkpoint yet', path, 404, origin)
      : json(checkpoint, 200, origin);
  }
  if (request.method === 'GET' && path === '/v1/entries') {
    const from = parseIntParam(url.searchParams.get('from'), 1);
    const to = parseIntParam(url.searchParams.get('to'), relay.tipSequence);
    if (from === null || to === null || from < 1) {
      return apiError('BAD_REQUEST', 'from/to must be positive integers', 'query', 400, origin);
    }
    const clamped = Math.min(to, from + MAX_PAGE - 1);
    return json({ entries: relay.entries(from, clamped), next: clamped < to ? clamped + 1 : null }, 200, origin);
  }
  if (request.method === 'GET' && path.startsWith('/v1/receipts/')) {
    const hash = path.slice('/v1/receipts/'.length);
    if (!/^[a-f0-9]{64}$/.test(hash)) return apiError('BAD_REQUEST', 'Not an event hash', path, 400, origin);
    const entry = relay.receiptFor(hash);
    return entry === null
      ? apiError('NOT_FOUND', 'Unknown event', path, 404, origin)
      : json(entry, 200, origin);
  }
  if (request.method === 'GET' && path === '/v1/signers/tip') {
    const signer = url.searchParams.get('signer');
    if (signer === null || signer.length === 0) return apiError('BAD_REQUEST', 'Missing signer', 'query.signer', 400, origin);
    return json({ signer, tip: relay.signerTip(signer) }, 200, origin);
  }
  const signerMatch = /^\/v1\/signers\/([^/]+)\/tip$/.exec(path);
  if (request.method === 'GET' && signerMatch !== null) {
    let signer: string;
    try {
      signer = decodeURIComponent(signerMatch[1] ?? '');
    } catch {
      return apiError('BAD_REQUEST', 'Bad signer encoding', path, 400, origin);
    }
    return json({ signer, tip: relay.signerTip(signer) }, 200, origin);
  }

  if (request.method === 'POST' && path === '/v1/events') {
    const body = await readBody(request, MAX_BODY_BYTES);
    if (body === null) return apiError('TOO_LARGE', 'Request body is too large', '', 413, origin);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch {
      return apiError('BAD_REQUEST', 'Body is not valid JSON', '$', 400, origin);
    }
    if (isRecord(raw) && typeof raw['signer'] === 'string' && raw['signer'].length > 0) {
      const signerBucket = 'signer:' + createHash('sha256').update(raw['signer']).digest('hex');
      try {
        if (!(await enforceRateLimit(rateRpc, [signerBucket], [60]))) {
          return apiError('RATE_LIMITED', 'Signer request limit exceeded', '$.signer', 429, origin);
        }
      } catch {
        return apiError('STORE_FAILURE', 'Relay is temporarily unavailable', '', 503, origin);
      }
    }
    const result = await relay.submitAsync(raw);
    if (!result.ok) {
      const status = result.error.code === 'RATE_LIMITED' ? 429
        : result.error.code === 'TOO_LARGE' ? 413
          : result.error.code === 'NOT_FOUND' ? 404
            : result.error.code === 'FORK' || result.error.code === 'CHAIN_LINK' ? 409
              : result.error.code === 'STORE_FAILURE' || result.error.code === 'READ_ONLY' ? 503 : 400;
      return apiError(result.error.code, result.error.message, result.error.path, status, origin);
    }
    return json({ receipt: result.value.receipt, duplicate: result.value.duplicate }, result.value.duplicate ? 200 : 201, origin);
  }

  if (request.method !== 'GET') return apiError('NOT_FOUND', 'No such route', path, 404, origin);
  return apiError('NOT_FOUND', 'No such route', path, 404, origin);
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request);
    } catch {
      return apiError('STORE_FAILURE', 'Internal server error', '', 503);
    }
  },
};
