import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  ApiError,
  mailboxIdOf,
  parseEnvelope,
  parseKeyBundle,
  statusFor,
} from '../../../skillx-mailbox/src/protocol.js';
import { verifyAuthHeader, verifyKeyBundle } from '../../../skillx-mailbox/src/verify.js';
import {
  MailboxStorageUnavailableError,
  SupabaseMailboxStore,
} from '../../../skillx-mailbox/src/supabase-store.js';
import type { ClockPort } from '../../../skillx-mailbox/src/ports.js';
import { SupabaseRpcClient } from '../../../skill-exchange-ledger/apps/node-ports/supabase-rpc.js';

const PREFIX = '/api/mailbox';
const MAX_BODY_BYTES = 24 * 1024;

const clock: ClockPort = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

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

function sendApiError(error: ApiError, origin: string | null): Response {
  return json({ error: { code: error.code, message: error.message } }, statusFor(error.code), origin);
}

function unavailable(origin: string | null): Response {
  return json(
    { error: { code: 'UNAVAILABLE', message: 'Mailbox is temporarily unavailable' } },
    503,
    origin,
  );
}

function allowedOrigin(): string | null {
  const raw = process.env.SKILLX_ALLOWED_ORIGIN?.trim();
  if (!raw) return null;
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new Error('SKILLX_ALLOWED_ORIGIN must use HTTPS');
  }
  return parsed.origin;
}

function makeRpcClient(): SupabaseRpcClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url === undefined || key === undefined) throw new Error('Mailbox storage configuration missing');
  return new SupabaseRpcClient({ url, serviceRoleKey: key });
}

async function allowIpRequest(rpc: SupabaseRpcClient, request: Request): Promise<boolean> {
  const forwardedIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const clientIp = isIP(forwardedIp) === 0 ? 'unknown' : forwardedIp;
  const bucket = 'ip:' + createHash('sha256').update(clientIp).digest('hex');
  const allowed = await rpc.rpc<unknown>('skillx_runtime_rate_limit', {
    p_bucket_keys: [bucket],
    p_limits: [120],
    p_now_ms: Date.now(),
    p_window_ms: 60_000,
  });
  if (typeof allowed !== 'boolean') throw new Error('Invalid rate limit response');
  return allowed;
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ApiError('BAD_REQUEST', 'content type must be application/json');
  }

  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiError('TOO_LARGE', 'body too large');
  }

  if (request.body === null) throw new ApiError('BAD_REQUEST', 'missing request body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError('TOO_LARGE', 'body too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ApiError('BAD_REQUEST', 'invalid json');
  }
}

function parseUint(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  if (!/^[0-9]{1,15}$/.test(raw)) throw new ApiError('BAD_REQUEST', 'invalid number');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError('BAD_REQUEST', 'invalid number');
  }
  return value;
}

async function handle(request: Request): Promise<Response> {
  let origin: string | null;
  try {
    origin = allowedOrigin();
  } catch {
    return unavailable(null);
  }

  const requestOrigin = request.headers.get('origin');
  if (origin !== null && requestOrigin !== null && requestOrigin !== origin) {
    return json({ error: { code: 'UNAUTHORIZED', message: 'origin not allowed' } }, 403, origin);
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...(origin === null ? {} : { 'access-control-allow-origin': origin }),
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, x-skillx-auth',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      },
    });
  }

  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) {
    return json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404, origin);
  }
  // Strip only the Vercel routing prefix. Client signatures cover the original
  // protocol paths (/v1/...), exactly as they do for the standalone mailbox.
  const path = url.pathname.slice(PREFIX.length) || '/';
  let rpc: SupabaseRpcClient;
  try {
    rpc = makeRpcClient();
    if (!(await allowIpRequest(rpc, request))) {
      return json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, 429, origin);
    }
  } catch {
    return unavailable(origin);
  }
  const store = new SupabaseMailboxStore(rpc, clock);

  if (path === '/v1/health') {
    if (request.method !== 'GET') {
      return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } }, 405, origin);
    }
    return json({ ok: true }, 200, origin);
  }

  const keyMatch = /^\/v1\/keys\/([0-9a-f]{64})$/.exec(path);
  if (keyMatch !== null) {
    const mailboxId = keyMatch[1] ?? '';
    if (request.method === 'GET') {
      try {
        const bundle = await store.getKey(mailboxId);
        return bundle === undefined
          ? json({ error: { code: 'NOT_FOUND', message: 'unknown mailbox' } }, 404, origin)
          : json(bundle, 200, origin);
      } catch (error) {
        if (error instanceof MailboxStorageUnavailableError) return unavailable(origin);
        if (error instanceof ApiError) return sendApiError(error, origin);
        return unavailable(origin);
      }
    }
    if (request.method === 'PUT') {
      try {
        const bundle = parseKeyBundle(await readJson(request));
        if (mailboxIdOf(bundle.identity_pubkey) !== mailboxId) {
          throw new ApiError('BAD_REQUEST', 'mailbox id does not match identity key');
        }
        if (!(await verifyKeyBundle(bundle))) {
          throw new ApiError('BAD_REQUEST', 'invalid key bundle signature');
        }
        const result = await store.putKey(bundle, mailboxId);
        return json({ ok: true }, result === 'created' ? 201 : 200, origin);
      } catch (error) {
        if (error instanceof MailboxStorageUnavailableError) return unavailable(origin);
        if (error instanceof ApiError) return sendApiError(error, origin);
        return unavailable(origin);
      }
    }
    return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } }, 405, origin);
  }

  const messagesMatch = /^\/v1\/mailbox\/([0-9a-f]{64})\/messages$/.exec(path);
  if (messagesMatch !== null && request.method === 'GET') {
    const mailboxId = messagesMatch[1] ?? '';
    const auth = request.headers.get('x-skillx-auth');
    if (auth === null || !(await verifyAuthHeader(auth, 'GET', path, mailboxId, clock))) {
      return json({ error: { code: 'UNAUTHORIZED', message: 'invalid auth' } }, 401, origin);
    }
    try {
      const after = parseUint(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = parseUint(url.searchParams.get('limit'), 100, 1, 100);
      const result = await store.listMessages(mailboxId, after, limit);
      return json({
        messages: result.messages.map((message) => ({
          seq: message.seq,
          id: message.id,
          envelope: message.envelope,
        })),
        next: result.next,
      }, 200, origin);
    } catch (error) {
      if (error instanceof MailboxStorageUnavailableError) return unavailable(origin);
      if (error instanceof ApiError) return sendApiError(error, origin);
      return unavailable(origin);
    }
  }

  const messageMatch = /^\/v1\/mailbox\/([0-9a-f]{64})\/messages\/([0-9a-f]{32})$/.exec(path);
  if (messageMatch !== null && request.method === 'DELETE') {
    const mailboxId = messageMatch[1] ?? '';
    const messageId = messageMatch[2] ?? '';
    const auth = request.headers.get('x-skillx-auth');
    if (auth === null || !(await verifyAuthHeader(auth, 'DELETE', path, mailboxId, clock))) {
      return json({ error: { code: 'UNAUTHORIZED', message: 'invalid auth' } }, 401, origin);
    }
    try {
      const removed = await store.deleteMessage(mailboxId, messageId);
      return removed
        ? new Response(null, {
            status: 204,
            headers: {
              'cache-control': 'no-store',
              ...(origin === null ? {} : { 'access-control-allow-origin': origin }),
            },
          })
        : json({ error: { code: 'NOT_FOUND', message: 'unknown message' } }, 404, origin);
    } catch (error) {
      if (error instanceof MailboxStorageUnavailableError) return unavailable(origin);
      if (error instanceof ApiError) return sendApiError(error, origin);
      return unavailable(origin);
    }
  }

  const mailboxMatch = /^\/v1\/mailbox\/([0-9a-f]{64})$/.exec(path);
  if (mailboxMatch !== null && request.method === 'POST') {
    const mailboxId = mailboxMatch[1] ?? '';
    try {
      const envelope = parseEnvelope(await readJson(request));
      const result = await store.addMessage(mailboxId, envelope);
      return json({ id: result.id }, 201, origin);
    } catch (error) {
      if (error instanceof MailboxStorageUnavailableError) return unavailable(origin);
      if (error instanceof ApiError) return sendApiError(error, origin);
      return unavailable(origin);
    }
  }

  const knownPath =
    /^\/v1\/(health|keys\/[0-9a-f]{64}|mailbox\/[0-9a-f]{64}(|\/messages(|\/[0-9a-f]{32})))$/.test(path);
  return knownPath
    ? json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } }, 405, origin)
    : json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404, origin);
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request);
    } catch (error) {
      if (error instanceof MailboxStorageUnavailableError) return unavailable(null);
      if (error instanceof ApiError) return sendApiError(error, null);
      return unavailable(null);
    }
  },
};
