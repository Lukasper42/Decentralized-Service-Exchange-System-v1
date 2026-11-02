import type { ClockPort, CryptoPort, RandomPort, StoragePort } from './ports.js';
import type { Hash, IsoUtc, LedgerEntry, Pubkey, Result } from './types.js';
import { err, ok } from './types.js';
import { bytesToHexLower, isValidPubkey, sha256Hex } from './crypto.js';
import { AMOUNT_MAX, AMOUNT_MIN, isRecord } from './guards.js';
import { deriveKeyStatus } from './project.js';

export const DEAL_SECRETS_KEY = 'skillx.deal-secrets.v1';
export const MAX_CRITERIA_CHARS = 2000;
export const MAX_DEADLINE_DAYS = 365;

export interface DealInput {
  seller: string;
  amountText: string;
  deadlineDaysText: string;
  criteriaText: string;
}

export interface DealSecret {
  deal_id: string;
  salt: string;
  criteria_text: string;
  created_at: IsoUtc;
}

export function uuidV4(random: RandomPort): string {
  const bytes = random.bytes(16);
  if (bytes.length !== 16) {
    throw new Error('Random source must return 16 bytes');
  }
  const copy = new Uint8Array(bytes);
  copy[6] = ((copy[6] ?? 0) & 0x0f) | 0x40;
  copy[8] = ((copy[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHexLower(copy);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function recoveryCommitmentOf(
  crypto: CryptoPort,
  pubkey: Pubkey,
): Promise<Hash> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`skillx/v1/recovery\n${pubkey}`);
  return await sha256Hex(crypto, bytes);
}

export async function criteriaCommitment(
  crypto: CryptoPort,
  salt: Uint8Array,
  criteriaText: string,
): Promise<Hash> {
  if (salt.length !== 32) {
    throw new Error('Salt must be 32 bytes');
  }
  const encoder = new TextEncoder();
  const prefixBytes = encoder.encode('skillx/v1/commit/criteria\n');
  const textBytes = encoder.encode(criteriaText);
  const combined = new Uint8Array(prefixBytes.length + salt.length + textBytes.length);
  combined.set(prefixBytes, 0);
  combined.set(salt, prefixBytes.length);
  combined.set(textBytes, prefixBytes.length + salt.length);
  return await sha256Hex(crypto, combined);
}

export async function buildAccountCreatedPayload(
  crypto: CryptoPort,
  entries: readonly LedgerEntry[],
  ownPubkey: Pubkey,
): Promise<Result<Record<string, unknown>>> {
  if (!isValidPubkey(ownPubkey)) {
    return err('FIELD_FORMAT', 'Own pubkey is invalid', '$.pubkey');
  }
  const status = deriveKeyStatus(entries, ownPubkey);
  switch (status) {
    case 'active':
      return err('STATE', 'This key is already registered on the ledger', '$.action.state');
    case 'rotated':
      return err('STATE', 'This key was rotated out and cannot be registered again', '$.action.state');
    case 'unknown': {
      try {
        const recovery_commitment = await recoveryCommitmentOf(crypto, ownPubkey);
        return ok({
          pubkey: ownPubkey,
          recovery_commitment,
          invite_ref: null,
        });
      } catch {
        return err('SIGNING', 'Hashing failed', '$.recovery_commitment');
      }
    }
    default: {
      const _exhaust: never = status;
      throw new Error(`Unhandled status: ${_exhaust}`);
    }
  }
}

export async function buildDealCreatedPayload(
  deps: { crypto: CryptoPort; random: RandomPort; clock: ClockPort },
  entries: readonly LedgerEntry[],
  ownPubkey: Pubkey,
  input: DealInput,
): Promise<Result<{ payload: Record<string, unknown>; secret: DealSecret }>> {
  if (!isValidPubkey(ownPubkey)) {
    return err('FIELD_FORMAT', 'Own pubkey is invalid', '$.buyer');
  }

  const ownStatus = deriveKeyStatus(entries, ownPubkey);
  if (ownStatus !== 'active') {
    return err('STATE', 'Register this key as a ledger account first', '$.action.state');
  }

  const seller = input.seller.trim();
  if (!isValidPubkey(seller)) {
    return err('FIELD_FORMAT', 'Seller pubkey is invalid', '$.seller');
  }

  if (seller === ownPubkey) {
    return err('PAYLOAD', 'Buyer and seller must differ', '$.seller');
  }

  const sellerStatus = deriveKeyStatus(entries, seller);
  if (sellerStatus !== 'active') {
    return err('STATE', 'Seller is not a registered account on the verified chain', '$.seller');
  }

  const trimmedAmount = input.amountText.trim();
  if (!/^[0-9]+$/.test(trimmedAmount)) {
    return err('AMOUNT', 'Amount must be a whole number between 2 and 900719925474', '$.amount');
  }
  const amount = Number(trimmedAmount);
  if (!Number.isSafeInteger(amount) || amount < AMOUNT_MIN || amount > AMOUNT_MAX) {
    return err('AMOUNT', 'Amount must be a whole number between 2 and 900719925474', '$.amount');
  }

  const trimmedDays = input.deadlineDaysText.trim();
  if (!/^[0-9]+$/.test(trimmedDays)) {
    return err('WINDOW', 'Deadline must be 1 to 365 days from now', '$.deadline');
  }
  const days = Number(trimmedDays);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DEADLINE_DAYS) {
    return err('WINDOW', 'Deadline must be 1 to 365 days from now', '$.deadline');
  }
  const deadlineDate = new Date(deps.clock.nowMs() + days * 86400000);
  const deadline = deadlineDate.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(deadline)) {
    return err('WINDOW', 'Deadline is not representable', '$.deadline');
  }

  if (input.criteriaText.trim() === '' || input.criteriaText.length > MAX_CRITERIA_CHARS) {
    return err('FIELD_FORMAT', 'Criteria must be 1 to 2000 characters', '$.criteria');
  }

  let deal_id: string;
  let salt: Uint8Array;
  let criteria_hash: Hash;
  try {
    deal_id = uuidV4(deps.random);
    const saltBytes = deps.random.bytes(32);
    if (saltBytes.length !== 32) {
      throw new Error('Salt must be 32 bytes');
    }
    salt = new Uint8Array(saltBytes);
    criteria_hash = await criteriaCommitment(deps.crypto, salt, input.criteriaText);
  } catch {
    return err('SIGNING', 'Could not build the criteria commitment', '$.criteria_hash');
  }

  const payload = {
    deal_id,
    buyer: ownPubkey,
    seller,
    amount,
    criteria_hash,
    deadline,
  };
  const secret: DealSecret = {
    deal_id,
    salt: bytesToHexLower(salt),
    criteria_text: input.criteriaText,
    created_at: deps.clock.nowIso(),
  };
  return ok({ payload, secret });
}

export function saveDealSecret(storage: StoragePort, secret: DealSecret): Result<true> {
  const listResult = loadDealSecrets(storage);
  if (!listResult.ok) {
    return listResult;
  }
  const list = listResult.value;
  const copy: DealSecret = {
    deal_id: secret.deal_id,
    salt: secret.salt,
    criteria_text: secret.criteria_text,
    created_at: secret.created_at,
  };
  const idx = list.findIndex((s) => s.deal_id === copy.deal_id);
  if (idx >= 0) {
    list[idx] = copy;
  } else {
    list.push(copy);
  }
  try {
    storage.set(DEAL_SECRETS_KEY, JSON.stringify(list));
    return ok(true);
  } catch {
    return err('STORE_FAILURE', 'Could not store the deal secret in this browser', '$.storage');
  }
}

export function loadDealSecrets(storage: StoragePort): Result<DealSecret[]> {
  let raw: string | null;
  try {
    raw = storage.get(DEAL_SECRETS_KEY);
  } catch {
    return err('STORE_FAILURE', 'Stored deal secrets are corrupt', '$.storage');
  }
  if (raw === null) {
    return ok([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err('STORE_FAILURE', 'Stored deal secrets are corrupt', '$.storage');
  }
  if (!Array.isArray(parsed)) {
    return err('STORE_FAILURE', 'Stored deal secrets are corrupt', '$.storage');
  }
  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const saltPattern = /^[a-f0-9]{64}$/;
  const result: DealSecret[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      return err('STORE_FAILURE', 'Stored deal secrets are corrupt', '$.storage');
    }
    const dealId = item['deal_id'];
    const salt = item['salt'];
    const criteriaText = item['criteria_text'];
    const createdAt = item['created_at'];
    if (
      typeof dealId !== 'string' ||
      typeof salt !== 'string' ||
      typeof criteriaText !== 'string' ||
      typeof createdAt !== 'string'
    ) {
      return err('STORE_FAILURE', 'Stored deal secrets are corrupt', '$.storage');
    }
    if (!saltPattern.test(salt)) {
      return err('STORE_FAILURE', 'Stored deal secrets are corrupt', '$.storage');
    }
    if (!isoPattern.test(createdAt)) {
      return err('STORE_FAILURE', 'Stored deal secrets are corrupt', '$.storage');
    }
    result.push({
      deal_id: dealId,
      salt,
      criteria_text: criteriaText,
      created_at: createdAt,
    });
  }
  return ok(result);
}

export function removeDealSecret(storage: StoragePort, dealId: string): void {
  const listResult = loadDealSecrets(storage);
  if (!listResult.ok) {
    return;
  }
  const filtered = listResult.value.filter((s) => s.deal_id !== dealId);
  try {
    if (filtered.length === 0) {
      storage.remove(DEAL_SECRETS_KEY);
    } else {
      storage.set(DEAL_SECRETS_KEY, JSON.stringify(filtered));
    }
  } catch {
    // swallow
  }
}