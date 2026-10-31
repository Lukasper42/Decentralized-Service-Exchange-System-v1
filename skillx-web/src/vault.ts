import type {
  ClockPort,
  CryptoPort,
  RandomPort,
  StoragePort,
} from './ports.js';
import type { ApiError, Result } from './types.js';
import { err, ok } from './types.js';
import {
  b64DecodeStrict,
  b64Encode,
  derivePublicKey,
  generateKeyPair,
  importNonExtractablePrivate,
} from './crypto.js';
import { GuardError, field, guardIso, guardPositiveInt, guardString, isRecord } from './guards.js';

export const PBKDF2_ITERATIONS = 600000;
export const VAULT_STORAGE_KEY = 'skillx.vault.v1';
export const MIN_PASSWORD_LENGTH = 16;
export const MAX_PBKDF2_ITERATIONS = 10_000_000;
const SALT_LEN = 16;
const IV_LEN = 12;
const MAX_B64_FIELD = 4096;

export interface VaultFile {
  v: 1;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface Vault {
  publicKey: string;
  file: VaultFile;
}

function signingError(message: string): Result<never> {
  return err('SIGNING', message, '$.vault');
}

async function deriveKey(
  crypto: CryptoPort,
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as unknown as ArrayBuffer,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as ArrayBuffer,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function createVault(
  crypto: CryptoPort,
  random: RandomPort,
  clock: ClockPort,
  password: string,
): Promise<Result<{ vault: Vault; publicKey: string }>> {
  void clock;
  if (password.length < MIN_PASSWORD_LENGTH) {
    return err('POLICY', `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben`, '$.vault.password');
  }
  const pair = await generateKeyPair(crypto);
  const salt = random.bytes(SALT_LEN);
  const iv = random.bytes(IV_LEN);
  const key = await deriveKey(crypto, password, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
    key,
    new TextEncoder().encode(pair.privateKeyPkcs8) as unknown as ArrayBuffer,
  );
  const file: VaultFile = {
    v: 1,
    iterations: PBKDF2_ITERATIONS,
    salt: b64Encode(salt),
    iv: b64Encode(iv),
    ciphertext: b64Encode(new Uint8Array(ct)),
  };
  return ok({ vault: { publicKey: pair.publicKey, file }, publicKey: pair.publicKey });
}

export async function unlock(
  crypto: CryptoPort,
  vault: Vault,
  password: string,
): Promise<Result<string>> {
  if (password.length === 0) {
    return err('SIGNING', 'Passwort fehlt', '$.vault.password');
  }
  let salt: Uint8Array;
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    salt = b64DecodeStrict(vault.file.salt);
    iv = b64DecodeStrict(vault.file.iv);
    ct = b64DecodeStrict(vault.file.ciphertext);
  } catch {
    return signingError('Vault-Datei beschädigt');
  }
  if (salt.length !== SALT_LEN || iv.length !== IV_LEN) {
    return signingError('Ungültige Salt-/IV-Länge');
  }
  try {
    const key = await deriveKey(crypto, password, salt, vault.file.iterations);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
      key,
      ct as unknown as ArrayBuffer,
    );
    const pkcs8 = new TextDecoder().decode(plain);
    b64DecodeStrict(pkcs8);
    return ok(pkcs8);
  } catch {
    return signingError('Falsches Passwort oder beschädigte Vault-Datei');
  }
}

/**
 * Entsperrt den Vault und liefert einen nicht exportierbaren Signierschlüssel
 * samt aus dem Schlüssel abgeleitetem Public Key (nie dem gespeicherten vertrauen).
 */
export async function unlockSigner(
  crypto: CryptoPort,
  vault: Vault,
  password: string,
): Promise<Result<{ key: CryptoKey; publicKey: string }>> {
  if (
    vault.file.iterations < PBKDF2_ITERATIONS ||
    vault.file.iterations > MAX_PBKDF2_ITERATIONS
  ) {
    return signingError('Iterationsanzahl außerhalb des erlaubten Bereichs');
  }
  const r = await unlock(crypto, vault, password);
  if (!r.ok) {
    return r;
  }
  try {
    const publicKey = await derivePublicKey(crypto, r.value);
    if (vault.publicKey !== '' && vault.publicKey !== publicKey) {
      return signingError('Gespeicherter Public Key passt nicht zum Schlüssel im Vault');
    }
    const key = await importNonExtractablePrivate(crypto, r.value);
    return ok({ key, publicKey });
  } catch {
    return signingError('Schlüssel nicht verwendbar');
  }
}

export function exportFile(vault: Vault): string {
  return JSON.stringify(vault.file);
}

export function importFile(text: string): Result<VaultFile> {
  if (text.length > 64 * 1024) {
    return err('TOO_LARGE', 'Vault-Datei zu groß', '$.vault');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err('ENVELOPE', 'Kein gültiges JSON', '$.vault');
  }
  if (!isRecord(parsed)) {
    return err('ENVELOPE', 'Vault muss ein Objekt sein', '$.vault');
  }
  try {
    const v = field(parsed, 'v', '$', guardPositiveInt);
    if (v !== 1) {
      return err('VERSION', 'Nur Vault-Version 1 unterstützt', '$.vault.v');
    }
    const iterations = field(parsed, 'iterations', '$', guardPositiveInt);
    if (iterations < PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
      return err('LIMIT', 'Iterationsanzahl außerhalb des erlaubten Bereichs', '$.vault.iterations');
    }
    const checkB64 = (name: string, expectedLen: number | null): string => {
      const s = field(parsed, name, '$', guardString);
      if (s.length === 0 || s.length > MAX_B64_FIELD) {
        throw new GuardError('LIMIT', `Feld "${name}" hat ungültige Länge`, `$.vault.${name}`);
      }
      let bytes: Uint8Array;
      try {
        bytes = b64DecodeStrict(s);
      } catch {
        throw new GuardError('FIELD_FORMAT', `Feld "${name}" ist kein striktes Base64`, `$.vault.${name}`);
      }
      if (expectedLen !== null && bytes.length !== expectedLen) {
        throw new GuardError('LIMIT', `Feld "${name}" hat falsche Byte-Länge`, `$.vault.${name}`);
      }
      return s;
    };
    const saltStr = checkB64('salt', SALT_LEN);
    const ivStr = checkB64('iv', IV_LEN);
    const ctStr = checkB64('ciphertext', null);
    return ok({ v: 1, iterations, salt: saltStr, iv: ivStr, ciphertext: ctStr });
  } catch (e) {
    if (e instanceof GuardError) {
      return err(e.code as ApiError['code'], e.message, e.gpath);
    }
    throw e;
  }
}

export function saveVault(storage: StoragePort, vault: Vault): void {
  storage.set(VAULT_STORAGE_KEY, JSON.stringify({ publicKey: vault.publicKey, file: vault.file }));
}

export function loadVault(storage: StoragePort): Result<Vault> {
  const raw = storage.get(VAULT_STORAGE_KEY);
  if (raw === null) {
    return err('NOT_FOUND', 'Kein Vault gespeichert', '$.vault');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err('ENVELOPE', 'Gespeicherter Vault ist kein JSON', '$.vault');
  }
  if (!isRecord(parsed)) {
    return err('ENVELOPE', 'Vault-Mantel ungültig', '$.vault');
  }
  try {
    const publicKey = field(parsed, 'publicKey', '$', guardString);
    const fileRaw = field(parsed, 'file', '$', (v, p) => {
      if (!isRecord(v)) {
        throw new GuardError('ENVELOPE', 'file muss ein Objekt sein', p);
      }
      return v;
    });
    const imported = importFile(JSON.stringify(fileRaw));
    if (!imported.ok) {
      return imported;
    }
    void guardIso;
    return ok({ publicKey, file: imported.value });
  } catch (e) {
    if (e instanceof GuardError) {
      return err(e.code as ApiError['code'], e.message, e.gpath);
    }
    throw e;
  }
}

export function clearVault(storage: StoragePort): void {
  storage.remove(VAULT_STORAGE_KEY);
}
