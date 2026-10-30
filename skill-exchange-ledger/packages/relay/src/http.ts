import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Relay, RelayError, RelayErrorCode } from './relay.js';
import type { ClockPort } from './ports.js';
import type { ReportReceiver } from './report-receiver.js';
import { RateLimiter } from './ratelimit.js';

export interface HttpPolicy {
  readonly maxBodyBytes: number;
  readonly perIpLimit: number;
  readonly perKeyLimit: number;
  readonly windowMs: number;
  /** Largest number of entries one range request may return. */
  readonly maxPage: number;
  /** Optional exact allowed origin for CORS; there is no wildcard mode. */
  readonly allowedOrigin: string | null;
  /**
   * Addresses of reverse proxies whose X-Forwarded-For header is believed (exact match after normalizing IPv4-mapped
   * IPv6). Empty or absent: the header is ignored and the socket address is the client address.
   */
  readonly trustedProxies?: readonly string[];
}
const STATUS: Readonly<Record<RelayErrorCode, number>> = {
  VERSION: 400, ENVELOPE: 400, TIMESTAMP: 400, PAYLOAD: 400, SIGNATURE: 400, UNKNOWN_TYPE: 400, UNKNOWN_FIELD: 400, MISSING_FIELD: 400,
  FIELD_FORMAT: 400, AMOUNT: 400, LIMIT: 400, SIGNER_AUTHORITY: 403, ATTESTATION: 400, CHAIN_LINK: 409, FORK: 409, RECEIPT_SEQUENCE: 500,
  RECEIPT_EVENT_HASH: 500, RECEIPT_LINK: 500, RECEIPT_SIGNATURE: 500, KEY_UNKNOWN: 500, STATE: 409, WINDOW: 409, POLICY: 422, REPLAY: 409,
  DUPLICATE: 409, INSUFFICIENT_FUNDS: 422, JURY_MISMATCH: 422, READ_ONLY: 503, RATE_LIMITED: 429, NOT_FOUND: 404, BAD_REQUEST: 400,
  TOO_LARGE: 413, STORE_FAILURE: 503,
};
const HASH = /^[a-f0-9]{64}$/;

export interface RelayHttpServer {
  readonly server: Server;
  listen(port: number, host: string): Promise<number>;
  /** Stop accepting connections and wait for in-flight requests to finish. */
  shutdown(): Promise<void>;
}

const normalizeAddress = (value: string): string => value.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
const ADDRESS = /^[0-9a-f:.]{2,45}$/;

/**
 * The address a request is attributed to for rate limiting. Behind a trusted proxy the client is the rightmost
 * X-Forwarded-For entry that is not itself a trusted proxy; anything a client prepends to the header is never reached.
 * Without a trusted peer the header is ignored, so it cannot be used to dodge or to poison the limit.
 */
export function clientIpOf(remoteAddress: string | undefined, forwardedFor: string | readonly string[] | undefined, trustedProxies: readonly string[]): string {
  const peer = normalizeAddress(remoteAddress ?? 'unknown');
  const trusted = new Set(trustedProxies.map(normalizeAddress));
  if (!trusted.has(peer) || forwardedFor === undefined) return peer;
  const chain = (typeof forwardedFor === 'string' ? [forwardedFor] : forwardedFor).join(',').split(',').map(normalizeAddress).filter((entry) => entry.length > 0);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const entry = chain[i] ?? '';
    if (trusted.has(entry)) continue;
    return ADDRESS.test(entry) ? entry : peer;
  }
  return peer;
}

function send(res: ServerResponse, status: number, body: unknown, origin: string | null): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (origin !== null) headers['access-control-allow-origin'] = origin;
  res.writeHead(status, headers);
  res.end(text);
}
const sendError = (res: ServerResponse, error: RelayError, origin: string | null): void => send(res, STATUS[error.code], { code: error.code, message: error.message, path: error.path }, origin);

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) over = true; else chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? 'too_large' : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function intParam(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  return /^\d{1,9}$/.test(value) ? Number.parseInt(value, 10) : null;
}

/** Minimal HTTP surface on Node built-ins. Errors always have the shape {code, message, path}; no stack traces leave the process. */
export function createRelayServer(relay: Relay, clock: ClockPort, policy: HttpPolicy, reportReceiver?: ReportReceiver): RelayHttpServer {
  const perIp = new RateLimiter(policy.perIpLimit, policy.windowMs, clock);
  const perKey = new RateLimiter(policy.perKeyLimit, policy.windowMs, clock);
  const origin = policy.allowedOrigin;
  const trustedProxies = policy.trustedProxies ?? [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://relay.local');
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (method === 'POST' && path === '/v1/events') {
      if (!perIp.allow(`ip:${clientIpOf(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustedProxies)}`)) return sendError(res, { code: 'RATE_LIMITED', message: 'Too many requests', path: '' }, origin);
      const body = await readBody(req, policy.maxBodyBytes);
      if (body === 'too_large') return sendError(res, { code: 'TOO_LARGE', message: 'Request body is too large', path: '' }, origin);
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return sendError(res, { code: 'BAD_REQUEST', message: 'Body is not valid JSON', path: '$' }, origin); }
      const signer = typeof parsed === 'object' && parsed !== null ? (parsed as { signer?: unknown }).signer : undefined;
      if (typeof signer === 'string' && !perKey.allow(`key:${signer}`)) return sendError(res, { code: 'RATE_LIMITED', message: 'Too many requests for this key', path: 'signer' }, origin);
      const result = await relay.submitAsync(parsed);
      if (!result.ok) return sendError(res, result.error, origin);
      return send(res, result.value.duplicate ? 200 : 201, { receipt: result.value.receipt, duplicate: result.value.duplicate }, origin);
    }
    if (method === 'OPTIONS' && origin !== null && path.startsWith('/v1/')) {
      // CORS preflight for the browser client: only the configured origin, only the methods and header the API uses.
      res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', 'cache-control': 'no-store', 'content-length': '0' });
      res.end();
      return;
    }

    if (method === 'POST' && path === '/v1/reports') {
      if (reportReceiver === undefined) return sendError(res, { code: 'NOT_FOUND', message: 'No such route', path: '' }, origin);
      if (!perIp.allow(`ip:${clientIpOf(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustedProxies)}`)) return sendError(res, { code: 'RATE_LIMITED', message: 'Too many requests', path: '' }, origin);
      const body = await readBody(req, policy.maxBodyBytes);
      if (body === 'too_large') return sendError(res, { code: 'TOO_LARGE', message: 'Request body is too large', path: '' }, origin);
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return sendError(res, { code: 'BAD_REQUEST', message: 'Body is not valid JSON', path: '$' }, origin); }
      const result = await reportReceiver.accept(parsed);
      if (!result.ok) return sendError(res, result.error, origin);
      return send(res, result.value.duplicate ? 200 : 201, { finding_id: result.value.findingId, duplicate: result.value.duplicate }, origin);
    }
    if (method !== 'GET') return sendError(res, { code: 'NOT_FOUND', message: 'No such route', path }, origin);
    if (path === '/v1/health') return send(res, 200, { ok: true, readOnly: relay.readOnly, tip: relay.tipSequence }, origin);
    if (path === '/v1/tip') return send(res, 200, { tipSequence: relay.tipSequence, stateHash: relay.stateHash }, origin);
    if (path === '/v1/checkpoints/latest') {
      const checkpoint = relay.latestCheckpoint();
      return checkpoint === null ? sendError(res, { code: 'NOT_FOUND', message: 'No checkpoint yet', path }, origin) : send(res, 200, checkpoint, origin);
    }
    if (path === '/v1/entries') {
      const from = intParam(url.searchParams.get('from'), 1);
      const to = intParam(url.searchParams.get('to'), relay.tipSequence);
      if (from === null || to === null || from < 1) return sendError(res, { code: 'BAD_REQUEST', message: 'from/to must be positive integers', path: 'query' }, origin);
      const clamped = Math.min(to, from + policy.maxPage - 1);
      return send(res, 200, { entries: relay.entries(from, clamped), next: clamped < to ? clamped + 1 : null }, origin);
    }
    const receipt = /^\/v1\/receipts\/([^/]+)$/.exec(path);
    if (receipt !== null) {
      const hash = receipt[1] ?? '';
      if (!HASH.test(hash)) return sendError(res, { code: 'BAD_REQUEST', message: 'Not an event hash', path }, origin);
      const entry = relay.receiptFor(hash);
      return entry === null ? sendError(res, { code: 'NOT_FOUND', message: 'Unknown event', path }, origin) : send(res, 200, entry, origin);
    }
    const tip = /^\/v1\/signers\/([^/]+)\/tip$/.exec(path);
    if (tip !== null) {
      let signer: string;
      try { signer = decodeURIComponent(tip[1] ?? ''); } catch { return sendError(res, { code: 'BAD_REQUEST', message: 'Bad signer encoding', path }, origin); }
      return send(res, 200, { signer, tip: relay.signerTip(signer) }, origin);
    }
    return sendError(res, { code: 'NOT_FOUND', message: 'No such route', path }, origin);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) sendError(res, { code: 'STORE_FAILURE', message: 'Internal error', path: '' }, origin); else res.end(); });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return {
    server,
    listen: (port, host) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
    }),
    shutdown: () => new Promise((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); }),
  };
}
