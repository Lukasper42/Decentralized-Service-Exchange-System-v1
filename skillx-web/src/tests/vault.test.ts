import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVault,
  unlock,
  unlockSigner,
  exportFile,
  importFile,
  saveVault,
  loadVault,
  clearVault,
} from '../vault.js';
import type { Vault } from '../vault.js';
import {
  generateKeyPair,
  derivePublicKey,
  signWithNonExtractable,
  verifySignature,
} from '../crypto.js';
import type { ClockPort, CryptoPort, RandomPort, StoragePort } from '../ports.js';

const PASSWORD = 'correct-horse-battery-staple';
const WRONG_PASSWORD = 'another-wrong-password-here';
const STORAGE_KEY = 'skillx.vault.v1';
const PBKDF2_ITERATIONS = 600000;

const cryptoPort: CryptoPort = { subtle: globalThis.crypto.subtle };

const clock: ClockPort = {
  nowMs: () => 0,
  nowIso: () => '2026-01-01T00:00:00.000Z',
};

const random: RandomPort = {
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    globalThis.crypto.getRandomValues(out);
    return out;
  },
};

interface FakeStorage extends StoragePort {
  readonly map: Map<string, string>;
}

function makeStorage(): FakeStorage {
  const map = new Map<string, string>();
  return {
    map,
    get(key: string): string | null {
      const value = map.get(key);
      return value === undefined ? null : value;
    },
    set(key: string, value: string): void {
      map.set(key, value);
    },
    remove(key: string): void {
      map.delete(key);
    },
  };
}

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isStrictBase64(value: string): boolean {
  return value.length > 0 && STRICT_BASE64.test(value);
}

function b64decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

interface CreatedVault {
  vault: Vault;
  publicKey: string;
}

let createdPromise: Promise<CreatedVault> | null = null;

async function getCreated(): Promise<CreatedVault> {
  if (createdPromise === null) {
    createdPromise = (async (): Promise<CreatedVault> => {
      const r = await createVault(cryptoPort, random, clock, PASSWORD);
      assert.ok(r.ok, 'createVault im Test-Setup fehlgeschlagen');
      if (!r.ok) {
        throw new Error('createVault im Test-Setup fehlgeschlagen');
      }
      return r.value;
    })();
  }
  return createdPromise;
}

async function getVault(): Promise<Vault> {
  const created = await getCreated();
  return created.vault;
}

let pkcs8Promise: Promise<string> | null = null;

async function getPkcs8(): Promise<string> {
  if (pkcs8Promise === null) {
    pkcs8Promise = (async (): Promise<string> => {
      const vault = await getVault();
      const r = await unlock(cryptoPort, vault, PASSWORD);
      assert.ok(r.ok, 'unlock im Test-Setup fehlgeschlagen');
      if (!r.ok) {
        throw new Error('unlock im Test-Setup fehlgeschlagen');
      }
      return r.value;
    })();
  }
  return pkcs8Promise;
}

test('createVault: Passwort kürzer als 16 Zeichen -> POLICY', async () => {
  const r = await createVault(cryptoPort, random, clock, 'fifteen-chars!!');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'POLICY');
  assert.strictEqual(r.error.path, '$.vault.password');
});

test('createVault: Erfolg liefert Vault v1 mit erwarteten Parametern und gültigem Ed25519-Pubkey', async () => {
  const created = await getCreated();
  const file = created.vault.file;

  assert.strictEqual(file.v, 1);
  assert.strictEqual(file.iterations, PBKDF2_ITERATIONS);

  assert.ok(isStrictBase64(file.salt), 'salt muss striktes Base64 sein');
  assert.ok(isStrictBase64(file.iv), 'iv muss striktes Base64 sein');
  assert.ok(isStrictBase64(file.ciphertext), 'ciphertext muss striktes Base64 sein');

  assert.strictEqual(b64decode(file.salt).length, 16);
  assert.strictEqual(b64decode(file.iv).length, 12);
  assert.ok(b64decode(file.ciphertext).length > 0);

  assert.strictEqual(created.vault.publicKey, created.publicKey);
  assert.ok(isStrictBase64(created.publicKey), 'publicKey muss striktes Base64 sein');

  const pub = b64decode(created.publicKey);
  assert.strictEqual(pub.length, 44);

  const expectedPrefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
  for (let i = 0; i < expectedPrefix.length; i += 1) {
    const expected = expectedPrefix[i];
    assert.ok(expected !== undefined);
    if (expected === undefined) return;
    assert.strictEqual(pub[i], expected, `Pubkey-Präfix Byte ${String(i)}`);
  }
});

test('createVault: zwei Aufrufe erzeugen unterschiedliche salt, iv und publicKey', async () => {
  const first = await getCreated();
  const r = await createVault(cryptoPort, random, clock, PASSWORD);
  assert.ok(r.ok);
  if (!r.ok) return;
  const second = r.value;

  assert.notStrictEqual(first.vault.file.salt, second.vault.file.salt);
  assert.notStrictEqual(first.vault.file.iv, second.vault.file.iv);
  assert.notStrictEqual(first.vault.publicKey, second.vault.publicKey);
});

test('unlock: Erfolg liefert striktes Base64-PKCS8 passend zum vault.publicKey', async () => {
  const vault = await getVault();
  const pkcs8 = await getPkcs8();

  assert.ok(isStrictBase64(pkcs8), 'PKCS8 muss striktes Base64 sein');
  const derived = await derivePublicKey(cryptoPort, pkcs8);
  assert.strictEqual(derived, vault.publicKey);
});

test('unlock: leeres Passwort -> SIGNING (Passwort fehlt)', async () => {
  const vault = await getVault();
  const r = await unlock(cryptoPort, vault, '');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'SIGNING');
  assert.strictEqual(r.error.message, 'Passwort fehlt');
});

test('unlock: falsches Passwort -> SIGNING mit Standardmeldung', async () => {
  const vault = await getVault();
  const r = await unlock(cryptoPort, vault, WRONG_PASSWORD);
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'SIGNING');
  assert.strictEqual(r.error.message, 'Falsches Passwort oder beschädigte Vault-Datei');
});

test('unlock: Salt kein striktes Base64 -> SIGNING (Vault-Datei beschädigt)', async () => {
  const vault = await getVault();
  const broken = structuredClone(vault);
  broken.file.salt = '!!!!';

  const r = await unlock(cryptoPort, broken, PASSWORD);
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'SIGNING');
  assert.strictEqual(r.error.message, 'Vault-Datei beschädigt');
});

test('unlock: manipulierter Ciphertext -> SIGNING', async () => {
  const vault = await getVault();
  const broken = structuredClone(vault);

  const original = broken.file.ciphertext;
  const firstChar = original.charAt(0);
  const replacement = firstChar === 'A' ? 'B' : 'A';
  broken.file.ciphertext = replacement + original.slice(1);

  assert.notStrictEqual(broken.file.ciphertext, original);
  assert.ok(isStrictBase64(broken.file.ciphertext));

  const r = await unlock(cryptoPort, broken, PASSWORD);
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'SIGNING');
});

test('unlockSigner: Erfolg liefert nicht-extrahierbaren Sign-Key und gültige Signatur', async () => {
  const vault = await getVault();
  const r = await unlockSigner(cryptoPort, vault, PASSWORD);

  assert.ok(r.ok);
  if (!r.ok) return;

  assert.strictEqual(r.value.publicKey, vault.publicKey);

  const key = r.value.key;
  assert.strictEqual(key.type, 'private');
  assert.strictEqual(key.extractable, false);
  assert.deepStrictEqual(key.usages, ['sign']);

  await assert.rejects(async () => {
    await cryptoPort.subtle.exportKey('pkcs8', key);
  });

  const message = new TextEncoder().encode('vault-signer-test');
  const sig = await signWithNonExtractable(cryptoPort, key, message);
  const verified = await verifySignature(cryptoPort, r.value.publicKey, message, sig);
  assert.strictEqual(verified, true);
});

test('unlockSigner: importierter Vault mit leerem publicKey liefert abgeleiteten Pubkey', async () => {
  const vault = await getVault();
  const imported = structuredClone(vault);
  imported.publicKey = '';

  const r = await unlockSigner(cryptoPort, imported, PASSWORD);
  assert.ok(r.ok);
  if (!r.ok) return;

  const pkcs8 = await getPkcs8();
  const derived = await derivePublicKey(cryptoPort, pkcs8);
  assert.strictEqual(r.value.publicKey, derived);
});

test('unlockSigner: fremder gültiger publicKey -> SIGNING', async () => {
  const vault = await getVault();
  const foreign = await generateKeyPair(cryptoPort);

  const manipulated = structuredClone(vault);
  manipulated.publicKey = foreign.publicKey;
  assert.notStrictEqual(manipulated.publicKey, vault.publicKey);

  const r = await unlockSigner(cryptoPort, manipulated, PASSWORD);
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'SIGNING');
});

test('unlockSigner: falsches Passwort -> SIGNING', async () => {
  const vault = await getVault();
  const r = await unlockSigner(cryptoPort, vault, WRONG_PASSWORD);
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'SIGNING');
});

test('unlockSigner: iterations 1000 und 10_000_001 -> SIGNING', async () => {
  const vault = await getVault();

  const tooLow = structuredClone(vault);
  tooLow.file.iterations = 1000;
  const rLow = await unlockSigner(cryptoPort, tooLow, PASSWORD);
  assert.strictEqual(rLow.ok, false);
  if (rLow.ok) return;
  assert.strictEqual(rLow.error.code, 'SIGNING');

  const tooHigh = structuredClone(vault);
  tooHigh.file.iterations = 10_000_001;
  const rHigh = await unlockSigner(cryptoPort, tooHigh, PASSWORD);
  assert.strictEqual(rHigh.ok, false);
  if (rHigh.ok) return;
  assert.strictEqual(rHigh.error.code, 'SIGNING');
});

test('exportFile/importFile: JSON-Roundtrip liefert deepEqual-gleiches VaultFile', async () => {
  const vault = await getVault();
  const text = exportFile(vault);

  assert.strictEqual(text, JSON.stringify(vault.file));

  const r = importFile(text);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepStrictEqual(r.value, vault.file);
});

test('importFile: Text länger als 65536 Zeichen -> TOO_LARGE', () => {
  const r = importFile('x'.repeat(65537));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'TOO_LARGE');
});

test('importFile: kein JSON bzw. JSON-Array -> ENVELOPE', () => {
  const r1 = importFile('{');
  assert.strictEqual(r1.ok, false);
  if (r1.ok) return;
  assert.strictEqual(r1.error.code, 'ENVELOPE');

  const r2 = importFile('[]');
  assert.strictEqual(r2.ok, false);
  if (r2.ok) return;
  assert.strictEqual(r2.error.code, 'ENVELOPE');
});

test('importFile: v = 2 -> VERSION', async () => {
  const file = (await getVault()).file;
  const bad = {
    v: 2,
    iterations: file.iterations,
    salt: file.salt,
    iv: file.iv,
    ciphertext: file.ciphertext,
  };

  const r = importFile(JSON.stringify(bad));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'VERSION');
});

test('importFile: fehlendes Feld salt -> MISSING_FIELD', async () => {
  const file = (await getVault()).file;
  const bad = {
    v: 1,
    iterations: file.iterations,
    iv: file.iv,
    ciphertext: file.ciphertext,
  };

  const r = importFile(JSON.stringify(bad));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'MISSING_FIELD');
});

test('importFile: iterations als String -> FIELD_FORMAT', async () => {
  const file = (await getVault()).file;
  const bad = {
    v: 1,
    iterations: '600000',
    salt: file.salt,
    iv: file.iv,
    ciphertext: file.ciphertext,
  };

  const r = importFile(JSON.stringify(bad));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'FIELD_FORMAT');
});

test('importFile: iterations 1000, 599999 und 10_000_001 -> LIMIT', async () => {
  const file = (await getVault()).file;

  for (const iterations of [1000, 599999, 10_000_001]) {
    const bad = {
      v: 1,
      iterations,
      salt: file.salt,
      iv: file.iv,
      ciphertext: file.ciphertext,
    };

    const r = importFile(JSON.stringify(bad));
    assert.strictEqual(r.ok, false);
    if (r.ok) return;
    assert.strictEqual(r.error.code, 'LIMIT');
  }
});

test('importFile: iterations 600000 und 10_000_000 -> ok', async () => {
  const file = (await getVault()).file;

  for (const iterations of [PBKDF2_ITERATIONS, 10_000_000]) {
    const good = {
      v: 1,
      iterations,
      salt: file.salt,
      iv: file.iv,
      ciphertext: file.ciphertext,
    };

    const r = importFile(JSON.stringify(good));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.strictEqual(r.value.iterations, iterations);
  }
});

test('importFile: salt "AAAA" (zu kurz) -> LIMIT', async () => {
  const file = (await getVault()).file;
  const bad = {
    v: 1,
    iterations: file.iterations,
    salt: 'AAAA',
    iv: file.iv,
    ciphertext: file.ciphertext,
  };

  const r = importFile(JSON.stringify(bad));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'LIMIT');
});

test('importFile: salt mit ungültigen Zeichen -> FIELD_FORMAT', async () => {
  const file = (await getVault()).file;
  const bad = {
    v: 1,
    iterations: file.iterations,
    salt: '!!!!!!!!!!!!!!!!!!!!!!',
    iv: file.iv,
    ciphertext: file.ciphertext,
  };

  const r = importFile(JSON.stringify(bad));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'FIELD_FORMAT');
});

test('importFile: iv "AAAA" -> LIMIT', async () => {
  const file = (await getVault()).file;
  const bad = {
    v: 1,
    iterations: file.iterations,
    salt: file.salt,
    iv: 'AAAA',
    ciphertext: file.ciphertext,
  };

  const r = importFile(JSON.stringify(bad));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'LIMIT');
});

test('importFile: ciphertext leer -> LIMIT', async () => {
  const file = (await getVault()).file;
  const bad = {
    v: 1,
    iterations: file.iterations,
    salt: file.salt,
    iv: file.iv,
    ciphertext: '',
  };

  const r = importFile(JSON.stringify(bad));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'LIMIT');
});

test('saveVault/loadVault: Roundtrip ist deepEqual und nutzt VAULT_STORAGE_KEY', async () => {
  const vault = await getVault();
  const storage = makeStorage();

  saveVault(storage, vault);

  const raw = storage.map.get(STORAGE_KEY);
  assert.ok(raw !== undefined);
  if (raw === undefined) return;
  assert.ok(raw.length > 0);
  assert.ok(raw.startsWith('{'));

  const loaded = loadVault(storage);
  assert.ok(loaded.ok);
  if (!loaded.ok) return;
  assert.deepStrictEqual(loaded.value, vault);
});

test('loadVault: leerer Speicher -> NOT_FOUND', () => {
  const storage = makeStorage();
  const r = loadVault(storage);
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'NOT_FOUND');
});

test('loadVault: Inhalt "{" bzw. "[]" -> ENVELOPE', () => {
  const storage = makeStorage();

  storage.set(STORAGE_KEY, '{');
  const r1 = loadVault(storage);
  assert.strictEqual(r1.ok, false);
  if (r1.ok) return;
  assert.strictEqual(r1.error.code, 'ENVELOPE');

  storage.set(STORAGE_KEY, '[]');
  const r2 = loadVault(storage);
  assert.strictEqual(r2.ok, false);
  if (r2.ok) return;
  assert.strictEqual(r2.error.code, 'ENVELOPE');
});

test('loadVault: gespeichertes Objekt ohne publicKey -> MISSING_FIELD', async () => {
  const vault = await getVault();
  const storage = makeStorage();
  storage.set(STORAGE_KEY, JSON.stringify({ file: vault.file }));

  const r = loadVault(storage);
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'MISSING_FIELD');
});

test('loadVault: gespeicherte file mit iterations 1000 -> ok:false', async () => {
  const vault = await getVault();
  const storage = makeStorage();
  storage.set(
    STORAGE_KEY,
    JSON.stringify({
      publicKey: vault.publicKey,
      file: { ...vault.file, iterations: 1000 },
    }),
  );

  const r = loadVault(storage);
  assert.strictEqual(r.ok, false);
});

test('clearVault: entfernt Eintrag, danach loadVault -> NOT_FOUND', async () => {
  const vault = await getVault();
  const storage = makeStorage();

  saveVault(storage, vault);
  assert.ok(storage.map.has(STORAGE_KEY));

  clearVault(storage);
  assert.strictEqual(storage.map.has(STORAGE_KEY), false);

  const r = loadVault(storage);
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'NOT_FOUND');
});
test('unlockSigner: unzulässige Iterationszahl wird sofort abgelehnt (kein PBKDF2-Lauf)', async () => {
  const vault = await getVault();
  const hostile = structuredClone(vault);
  hostile.file.iterations = 100_000_000;

  const start = performance.now();
  const r = await unlockSigner(cryptoPort, hostile, PASSWORD);
  const elapsedMs = performance.now() - start;

  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.error.code, 'SIGNING');
  // 100 Mio. PBKDF2-Runden würden Minuten dauern; die Ablehnung muss vorher erfolgen.
  assert.ok(elapsedMs < 2000, `Ablehnung dauerte ${String(elapsedMs)} ms`);
});
