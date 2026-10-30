import type { CryptoPort, FetchInit, FetchPort, FetchResponseLike } from './ports.js';
import type { ErrorCode, Result } from './types.js';
import { err, ok } from './types.js';
import type { Envelope, KeyBundle } from './mailbox-crypto.js';
import { mailboxId as computeMailboxId } from './mailbox-crypto.js';
import { checkRelayUrl } from './net-policy.js';

interface KeyBundleResponse {
  status: number;
}

interface SendResponse {
  id: string;
}

interface MessageEntry {
  seq: number;
  id: string;
  envelope: Envelope;
}

interface FetchMessagesResponse {
  messages: MessageEntry[];
  next: number;
}

interface DeleteResponse {
  status: number;
}

interface ApiErrorBody {
  code: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isMailboxId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isEnvelope(value: unknown): value is Envelope {
  if (!isRecord(value)) return false;
  return (
    value['v'] === 1 &&
    typeof value['eph_pub'] === 'string' &&
    typeof value['iv'] === 'string' &&
    typeof value['ct'] === 'string'
  );
}

function isKeyBundle(value: unknown): value is KeyBundle {
  if (!isRecord(value)) return false;
  return (
    value['v'] === 1 &&
    typeof value['identity_pubkey'] === 'string' &&
    typeof value['x_pubkey'] === 'string' &&
    typeof value['created_at'] === 'string' &&
    typeof value['sig'] === 'string'
  );
}

function isMessageEntry(value: unknown): value is MessageEntry {
  if (!isRecord(value)) return false;
  return (
    isSafeInt(value['seq']) &&
    value['seq'] >= 1 &&
    typeof value['id'] === 'string' &&
    isEnvelope(value['envelope'])
  );
}

function parseApiError(value: unknown, status: number, path: string): { code: ErrorCode; message: string } {
  if (isRecord(value)) {
    const error = value['error'];
    if (isRecord(error)) {
      const code = error['code'];
      const message = error['message'];
      if (typeof code === 'string' && typeof message === 'string') {
        return { code: statusToCode(status), message: `${code}: ${message}`.slice(0, 200) };
      }
    }
  }
  return { code: statusToCode(status), message: `HTTP ${status} for ${path}` };
}

function statusToCode(status: number): ErrorCode {
  if (status === 400) return 'FIELD_FORMAT';
  if (status === 401) return 'POLICY';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'POLICY';
  if (status === 413) return 'LIMIT';
  if (status === 429) return 'LIMIT';
  if (status === 405) return 'POLICY';
  return 'POLICY';
}

export class MailboxClient {
  private readonly baseUrl: string;
  private readonly fetchPort: FetchPort;

  constructor(baseUrl: string, fetchPort: FetchPort) {
    const checked = checkRelayUrl(baseUrl);
    if (!checked.ok) {
      throw new Error(`invalid mailbox base URL: ${checked.reason}`);
    }
    this.baseUrl = checked.url;
    this.fetchPort = fetchPort;
  }

  private url(path: string): string {
    return this.baseUrl + path;
  }

  private async call(
    path: string,
    init?: FetchInit
  ): Promise<Result<{ status: number; body: unknown }>> {
    try {
      const response: FetchResponseLike = await this.fetchPort(this.url(path), init);
      let body: unknown = null;
      if (response.status !== 204) {
        try {
          body = await response.json();
        } catch {
          if (response.status >= 200 && response.status < 300) {
            return err('FIELD_FORMAT', 'invalid JSON', path);
          }
          return err(statusToCode(response.status), `HTTP ${response.status}`, path);
        }
      }
      if (response.status >= 200 && response.status < 300) {
        return ok({ status: response.status, body });
      }
      const apiError = parseApiError(body, response.status, path);
      return err(apiError.code, apiError.message, path);
    } catch {
      return err('POLICY', 'network error', path);
    }
  }

  async putKeyBundle(
    bundle: KeyBundle,
    mailboxIdArg?: string
  ): Promise<Result<KeyBundleResponse>> {
    let id: string;
    if (mailboxIdArg !== undefined) {
      id = mailboxIdArg;
    } else {
      const cryptoPort: CryptoPort = { subtle: globalThis.crypto.subtle };
      try {
        id = await computeMailboxId(cryptoPort, bundle.identity_pubkey);
      } catch {
        return err('FIELD_FORMAT', 'invalid identity_pubkey', '/v1/keys');
      }
    }
    if (!isMailboxId(id)) {
      return err('FIELD_FORMAT', 'invalid mailbox id', '/v1/keys');
    }
    const path = `/v1/keys/${encodeURIComponent(id)}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const result = await this.call(path, {
      method: 'PUT',
      headers,
      body: JSON.stringify(bundle)
    });
    if (!result.ok) return result;
    return ok({ status: result.value.status });
  }

  async getKeyBundle(mailboxId: string): Promise<Result<KeyBundle>> {
    if (!isMailboxId(mailboxId)) {
      return err('FIELD_FORMAT', 'invalid mailbox id', '/v1/keys');
    }
    const path = `/v1/keys/${encodeURIComponent(mailboxId)}`;
    const result = await this.call(path, { method: 'GET' });
    if (!result.ok) return result;
    const bundle = result.value.body;
    if (!isKeyBundle(bundle)) {
      return err('FIELD_FORMAT', 'invalid key bundle response', path);
    }
    // Ein Server darf kein fremdes Bündel unterschieben (sonst Mitlesen möglich).
    let derived: string;
    try {
      derived = await computeMailboxId({ subtle: globalThis.crypto.subtle }, bundle.identity_pubkey);
    } catch {
      return err('FIELD_FORMAT', 'invalid identity_pubkey in bundle', path);
    }
    if (derived !== mailboxId) {
      return err('SIGNING', 'key bundle does not belong to requested mailbox', path);
    }
    return ok(bundle);
  }

  async send(mailboxId: string, envelope: Envelope): Promise<Result<string>> {
    if (!isMailboxId(mailboxId)) {
      return err('FIELD_FORMAT', 'invalid mailbox id', '/v1/mailbox');
    }
    if (!isEnvelope(envelope)) {
      return err('FIELD_FORMAT', 'invalid envelope', '/v1/mailbox');
    }
    const path = `/v1/mailbox/${encodeURIComponent(mailboxId)}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const result = await this.call(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope)
    });
    if (!result.ok) return result;
    const body = result.value.body;
    if (!isRecord(body)) {
      return err('FIELD_FORMAT', 'invalid send response', path);
    }
    const id = body['id'];
    if (typeof id !== 'string') {
      return err('FIELD_FORMAT', 'invalid message id', path);
    }
    return ok(id);
  }

  async fetchMessages(
    mailboxId: string,
    authHeader: string,
    after: number
  ): Promise<Result<FetchMessagesResponse>> {
    if (!isMailboxId(mailboxId)) {
      return err('FIELD_FORMAT', 'invalid mailbox id', '/v1/mailbox/messages');
    }
    if (authHeader.length === 0) {
      return err('FIELD_FORMAT', 'empty auth header', '/v1/mailbox/messages');
    }
    if (!isSafeInt(after) || after < 0) {
      return err('FIELD_FORMAT', 'invalid after', '/v1/mailbox/messages');
    }
    const path = `/v1/mailbox/${encodeURIComponent(mailboxId)}/messages`;
    const queryPath = `${path}?after=${after}&limit=100`;
    const headers: Record<string, string> = { 'X-Skillx-Auth': authHeader };
    const result = await this.call(queryPath, { method: 'GET', headers });
    if (!result.ok) return result;
    const body = result.value.body;
    if (!isRecord(body)) {
      return err('FIELD_FORMAT', 'invalid messages response', path);
    }
    const messagesValue = body['messages'];
    const nextValue = body['next'];
    if (!Array.isArray(messagesValue)) {
      return err('FIELD_FORMAT', 'invalid messages array', path);
    }
    if (!isSafeInt(nextValue) || nextValue < 0) {
      return err('FIELD_FORMAT', 'invalid next', path);
    }
    const messages: MessageEntry[] = [];
    for (const entry of messagesValue) {
      if (!isMessageEntry(entry)) {
        return err('FIELD_FORMAT', 'invalid message entry', path);
      }
      messages.push(entry);
    }
    return ok({ messages, next: nextValue });
  }

  async deleteMessage(
    mailboxId: string,
    id: string,
    authHeader: string
  ): Promise<Result<DeleteResponse>> {
    if (!isMailboxId(mailboxId)) {
      return err('FIELD_FORMAT', 'invalid mailbox id', '/v1/mailbox/delete');
    }
    if (id.length === 0) {
      return err('FIELD_FORMAT', 'empty message id', '/v1/mailbox/delete');
    }
    if (authHeader.length === 0) {
      return err('FIELD_FORMAT', 'empty auth header', '/v1/mailbox/delete');
    }
    const path = `/v1/mailbox/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(id)}`;
    const headers: Record<string, string> = { 'X-Skillx-Auth': authHeader };
    const result = await this.call(path, { method: 'DELETE', headers });
    if (!result.ok) return result;
    return ok({ status: result.value.status });
  }
}
