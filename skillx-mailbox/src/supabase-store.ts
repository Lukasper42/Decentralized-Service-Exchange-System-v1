import { randomBytes } from 'node:crypto';
import { ApiError, parseStoredMessage } from './protocol.js';
import type { Envelope, KeyBundle, StoredMessage } from './protocol.js';
export interface MailboxRpcPort {
  rpc<T = unknown>(
    functionName: string,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<T>;
}

export interface MailboxClock {
  nowMs(): number;
}

interface MailboxListResponse {
  messages: unknown[];
  next: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class MailboxStorageUnavailableError extends Error {
  constructor() {
    super('mailbox storage is temporarily unavailable');
    this.name = 'MailboxStorageUnavailableError';
  }
}

function apiErrorFor(error: unknown): ApiError | MailboxStorageUnavailableError {
  const code = isRecord(error) && typeof error['sqlState'] === 'string'
    ? error['sqlState']
    : '';
  if (code === 'P0002') return new ApiError('NOT_FOUND', 'unknown mailbox');
  if (code === 'P0001') return new ApiError('RATE_LIMITED', 'mailbox limit reached');
  if (code === '23505') return new ApiError('CONFLICT', 'mailbox key or message conflicts with stored data');
  if (code === '22023') return new ApiError('BAD_REQUEST', 'invalid mailbox request');
  return new MailboxStorageUnavailableError();
}

/**
 * Request-safe mailbox persistence. There is no process-local state: each method
 * delegates its atomic work to a PostgreSQL function in the private runtime schema.
 */
export class SupabaseMailboxStore {
  private readonly rpc: MailboxRpcPort;
  private readonly clock: MailboxClock;

  constructor(rpc: MailboxRpcPort, clock: MailboxClock) {
    this.rpc = rpc;
    this.clock = clock;
  }

  async getKey(mailboxId: string): Promise<KeyBundle | undefined> {
    let value: unknown;
    try {
      value = await this.rpc.rpc('skillx_runtime_mailbox_get_key', {
        p_mailbox_id: mailboxId,
      });
    } catch (error) {
      throw apiErrorFor(error);
    }
    if (value === null) return undefined;
    if (!isRecord(value) || value['v'] !== 1 ||
        typeof value['identity_pubkey'] !== 'string' ||
        typeof value['x_pubkey'] !== 'string' ||
        typeof value['created_at'] !== 'string' ||
        typeof value['sig'] !== 'string') {
      throw new ApiError('BAD_REQUEST', 'invalid stored key bundle');
    }
    return {
      v: 1,
      identity_pubkey: value['identity_pubkey'],
      x_pubkey: value['x_pubkey'],
      created_at: value['created_at'],
      sig: value['sig'],
    };
  }

  async putKey(bundle: KeyBundle, mailboxId: string): Promise<'created' | 'replaced' | 'unchanged'> {
    try {
      const result = await this.rpc.rpc<unknown>('skillx_runtime_mailbox_put_key', {
        p_mailbox_id: mailboxId,
        p_identity_pubkey: bundle.identity_pubkey,
        p_x_pubkey: bundle.x_pubkey,
        p_created_at: bundle.created_at,
        p_sig: bundle.sig,
      });
      if (result === 'created' || result === 'replaced' || result === 'unchanged') return result;
      throw new ApiError('BAD_REQUEST', 'invalid mailbox store response');
    } catch (error) {
      if (error instanceof ApiError || error instanceof MailboxStorageUnavailableError) throw error;
      throw apiErrorFor(error);
    }
  }

  async addMessage(mailboxId: string, envelope: Envelope): Promise<{ id: string }> {
    const id = randomBytes(16).toString('hex');
    try {
      const result = await this.rpc.rpc<unknown>('skillx_runtime_mailbox_add_message', {
        p_mailbox_id: mailboxId,
        p_message_id: id,
        p_envelope: envelope,
        p_stored_at: this.clock.nowMs(),
      });
      if (!isRecord(result) || result['id'] !== id) {
        throw new ApiError('BAD_REQUEST', 'invalid mailbox store response');
      }
      return { id };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw apiErrorFor(error);
    }
  }

  async listMessages(
    mailboxId: string,
    after: number,
    limit: number,
  ): Promise<{ messages: StoredMessage[]; next: number }> {
    let result: unknown;
    try {
      result = await this.rpc.rpc('skillx_runtime_mailbox_list_messages', {
        p_mailbox_id: mailboxId,
        p_after: after,
        p_limit: limit,
        p_now: this.clock.nowMs(),
      });
    } catch (error) {
      throw apiErrorFor(error);
    }
    if (!isRecord(result) || !Array.isArray(result['messages']) ||
        typeof result['next'] !== 'number' || !Number.isSafeInteger(result['next'])) {
      throw new ApiError('BAD_REQUEST', 'invalid mailbox list response');
    }
    return {
      messages: result['messages'].map((item) => parseStoredMessage(item)),
      next: result['next'],
    } satisfies MailboxListResponse & { messages: StoredMessage[] };
  }

  async deleteMessage(mailboxId: string, messageId: string): Promise<boolean> {
    try {
      const result = await this.rpc.rpc<unknown>('skillx_runtime_mailbox_delete_message', {
        p_mailbox_id: mailboxId,
        p_message_id: messageId,
        p_now: this.clock.nowMs(),
      });
      if (typeof result !== 'boolean') throw new ApiError('BAD_REQUEST', 'invalid mailbox delete response');
      return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw apiErrorFor(error);
    }
  }
}
