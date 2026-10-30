import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ClockPort } from './ports.js';
import type { MailboxStore } from './store.js';
import {
  ApiError,
  mailboxIdOf,
  parseEnvelope,
  parseKeyBundle,
  statusFor,
} from './protocol.js';
import type { ErrorCode } from './protocol.js';
import { verifyAuthHeader, verifyKeyBundle } from './verify.js';

const MAX_BODY_BYTES = 24 * 1024;

const KEY_PATH_RE = /^\/v1\/keys\/([0-9a-f]{64})$/;
const MAILBOX_PATH_RE = /^\/v1\/mailbox\/([0-9a-f]{64})$/;
const MESSAGES_PATH_RE = /^\/v1\/mailbox\/([0-9a-f]{64})\/messages$/;
const MESSAGE_PATH_RE = /^\/v1\/mailbox\/([0-9a-f]{64})\/messages\/([0-9a-f]{32})$/;

export interface HandlerDeps {
  readonly store: MailboxStore;
  readonly clock: ClockPort;
  readonly allowedOrigin: string;
}

export function createHandler(
  deps: HandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handleRequest(deps, req, res).catch((err: unknown) => {
      handleFailure(res, err);
      req.resume();
    });
  };
}

export function createMailboxServer(deps: HandlerDeps): Server {
  const server = createServer(createHandler(deps));
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return server;
}

function handleFailure(res: ServerResponse, err: unknown): void {
  if (res.writableEnded) {
    return;
  }
  if (err instanceof ApiError) {
    sendError(res, err.code, err.message);
    return;
  }
  sendJson(res, 500, { error: { code: 'BAD_REQUEST', message: 'internal error' } });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) {
    return;
  }
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function sendError(res: ServerResponse, code: ErrorCode, message: string): void {
  sendJson(res, statusFor(code), { error: { code, message } });
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendError(res, 'METHOD_NOT_ALLOWED', 'method not allowed');
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return undefined;
}

function requireJsonContentType(req: IncomingMessage): void {
  const contentType = headerValue(req, 'content-type');
  if (contentType === undefined) {
    throw new ApiError('BAD_REQUEST', 'missing content type');
  }
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base !== 'application/json') {
    throw new ApiError('BAD_REQUEST', 'content type must be application/json');
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = headerValue(req, 'content-length');
  if (declared !== undefined) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > limit) {
      throw new ApiError('TOO_LARGE', 'body too large');
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = req as AsyncIterable<Buffer | string>;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    total += buf.length;
    if (total > limit) {
      throw new ApiError('TOO_LARGE', 'body too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req, MAX_BODY_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('BAD_REQUEST', 'invalid json');
  }
}

function parseUint(raw: string, min: number, max: number): number {
  if (!/^[0-9]{1,15}$/.test(raw)) {
    throw new ApiError('BAD_REQUEST', 'invalid number');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError('BAD_REQUEST', 'invalid number');
  }
  return value;
}

async function handleRequest(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', deps.allowedOrigin);

  const method = req.method ?? '';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Skillx-Auth');
    res.setHeader('Access-Control-Max-Age', '600');
    res.statusCode = 204;
    res.end();
    return;
  }

  if (path === '/v1/health') {
    if (method !== 'GET') {
      methodNotAllowed(res, 'GET');
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  const keyMatch = KEY_PATH_RE.exec(path);
  if (keyMatch !== null) {
    const mailboxId = keyMatch[1] ?? '';
    if (method === 'PUT') {
      await putKey(deps, req, res, mailboxId);
      return;
    }
    if (method === 'GET') {
      getKey(deps, res, mailboxId);
      return;
    }
    methodNotAllowed(res, 'GET, PUT');
    return;
  }

  const messagesMatch = MESSAGES_PATH_RE.exec(path);
  if (messagesMatch !== null) {
    const mailboxId = messagesMatch[1] ?? '';
    if (method === 'GET') {
      await getMessages(deps, req, res, url, path, mailboxId);
      return;
    }
    methodNotAllowed(res, 'GET');
    return;
  }

  const messageMatch = MESSAGE_PATH_RE.exec(path);
  if (messageMatch !== null) {
    const mailboxId = messageMatch[1] ?? '';
    const messageId = messageMatch[2] ?? '';
    if (method === 'DELETE') {
      await deleteMessage(deps, req, res, path, mailboxId, messageId);
      return;
    }
    methodNotAllowed(res, 'DELETE');
    return;
  }

  const mailboxMatch = MAILBOX_PATH_RE.exec(path);
  if (mailboxMatch !== null) {
    const mailboxId = mailboxMatch[1] ?? '';
    if (method === 'POST') {
      await postMessage(deps, req, res, mailboxId);
      return;
    }
    methodNotAllowed(res, 'POST');
    return;
  }

  throw new ApiError('NOT_FOUND', 'not found');
}

async function putKey(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  mailboxId: string,
): Promise<void> {
  requireJsonContentType(req);
  const body = await readJsonBody(req);
  const bundle = parseKeyBundle(body);
  if (mailboxIdOf(bundle.identity_pubkey) !== mailboxId) {
    throw new ApiError('BAD_REQUEST', 'mailbox id does not match identity key');
  }
  const valid = await verifyKeyBundle(bundle);
  if (!valid) {
    throw new ApiError('BAD_REQUEST', 'invalid key bundle signature');
  }
  const result = await deps.store.putKey(bundle);
  sendJson(res, result === 'created' ? 201 : 200, { ok: true });
}

function getKey(deps: HandlerDeps, res: ServerResponse, mailboxId: string): void {
  const bundle = deps.store.getKey(mailboxId);
  if (bundle === undefined) {
    throw new ApiError('NOT_FOUND', 'unknown mailbox');
  }
  sendJson(res, 200, bundle);
}

async function postMessage(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  mailboxId: string,
): Promise<void> {
  requireJsonContentType(req);
  const body = await readJsonBody(req);
  const envelope = parseEnvelope(body);
  if (!deps.store.hasKey(mailboxId)) {
    throw new ApiError('NOT_FOUND', 'unknown mailbox');
  }
  const created = await deps.store.addMessage(mailboxId, envelope);
  sendJson(res, 201, { id: created.id });
}

async function getMessages(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  mailboxId: string,
): Promise<void> {
  const auth = headerValue(req, 'x-skillx-auth');
  if (auth === undefined) {
    throw new ApiError('UNAUTHORIZED', 'missing auth header');
  }
  const ok = await verifyAuthHeader(auth, 'GET', path, mailboxId, deps.clock);
  if (!ok) {
    throw new ApiError('UNAUTHORIZED', 'invalid auth');
  }
  const afterRaw = url.searchParams.get('after');
  const after = afterRaw === null ? 0 : parseUint(afterRaw, 0, Number.MAX_SAFE_INTEGER);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? 100 : parseUint(limitRaw, 1, 100);
  const result = await deps.store.listMessages(mailboxId, after, limit);
  const messages = result.messages.map((message) => ({
    seq: message.seq,
    id: message.id,
    envelope: message.envelope,
  }));
  sendJson(res, 200, { messages, next: result.next });
}

async function deleteMessage(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  mailboxId: string,
  messageId: string,
): Promise<void> {
  const auth = headerValue(req, 'x-skillx-auth');
  if (auth === undefined) {
    throw new ApiError('UNAUTHORIZED', 'missing auth header');
  }
  const ok = await verifyAuthHeader(auth, 'DELETE', path, mailboxId, deps.clock);
  if (!ok) {
    throw new ApiError('UNAUTHORIZED', 'invalid auth');
  }
  const removed = await deps.store.deleteMessage(mailboxId, messageId);
  if (!removed) {
    throw new ApiError('NOT_FOUND', 'unknown message');
  }
  res.statusCode = 204;
  res.end();
}
