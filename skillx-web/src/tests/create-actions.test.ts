import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { hexToBytesLower } from '../crypto.js';
import type { ClockPort, CryptoPort, RandomPort, StoragePort } from '../ports.js';
import type { IsoUtc, LedgerEntry, Pubkey } from '../types.js';
import {
  buildAccountCreatedPayload,
  buildDealCreatedPayload,
  criteriaCommitment,
  DEAL_SECRETS_KEY,
  type DealInput,
  type DealSecret,
  loadDealSecrets,
  recoveryCommitmentOf,
  removeDealSecret,
  saveDealSecret,
  uuidV4,
} from '../create-actions.js';

const port: CryptoPort = { subtle: globalThis.crypto.subtle };

function makePubkey(): Pubkey {
  const { publicKey } = generateKeyPairSync('ed25519');
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function makeFakeRandom(startByte = 0): RandomPort {
  let counter = startByte;
  return {
    bytes(n: number): Uint8Array {
      const arr = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        arr[i] = (counter + i) & 0xff;
      }
      counter = (counter + n) & 0xff;
      return arr;
    },
  };
}

function makeWrongLengthRandom(): RandomPort {
  return {
    bytes(): Uint8Array {
      return new Uint8Array(0);
    },
  };
}

const FIXED_MS = Date.UTC(2026, 10, 1, 12, 0, 0);
const FIXED_ISO: IsoUtc = '2026-11-01T12:00:00.000Z';

const fakeClock: ClockPort = {
  nowMs(): number {
    return FIXED_MS;
  },
  nowIso(): IsoUtc {
    return FIXED_ISO;
  },
};

function makeFakeStorage(): StoragePort & { getMap(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    get(key: string): string | null {
      return map.get(key) ?? null;
    },
    set(key: string, value: string): void {
      map.set(key, value);
    },
    remove(key: string): void {
      map.delete(key);
    },
    getMap(): Map<string, string> {
      return map;
    },
  };
}

function makeThrowingSetStorage(): StoragePort {
  const map = new Map<string, string>();
  return {
    get(key: string): string | null {
      return map.get(key) ?? null;
    },
    set(): void {
      throw new Error('set failed');
    },
    remove(key: string): void {
      map.delete(key);
    },
  };
}

function makeThrowingGetStorage(): StoragePort {
  return {
    get(): string | null {
      throw new Error('get failed');
    },
    set(): void {},
    remove(): void {},
  };
}

function makeAccountCreatedEntry(pubkey: string): LedgerEntry {
  return {
    event: {
      type: 'AccountCreated',
      version: 1,
      payload: { pubkey, recovery_commitment: 'a'.repeat(64), invite_ref: null },
      signer: pubkey,
      timestamp: '2026-01-01T00:00:00.000Z' as IsoUtc,
      prevHash: null,
      signature: 'x',
    },
    receipt: {
      sequence: 1,
      eventHash: 'a'.repeat(64),
      previousReceiptHash: null,
      acceptedAt: '2026-01-01T00:00:00.000Z' as IsoUtc,
      keyId: 'b'.repeat(64),
      signature: 'sig',
    },
  };
}

function makeKeyRotatedEntry(oldPubkey: string, newPubkey: string): LedgerEntry {
  return {
    event: {
      type: 'KeyRotated',
      version: 1,
      payload: {
        old_pubkey: oldPubkey,
        new_pubkey: newPubkey,
        new_recovery_commitment: 'b'.repeat(64),
      },
      signer: oldPubkey,
      timestamp: '2026-01-02T00:00:00.000Z' as IsoUtc,
      prevHash: null,
      signature: 'x',
    },
    receipt: {
      sequence: 2,
      eventHash: 'c'.repeat(64),
      previousReceiptHash: null,
      acceptedAt: '2026-01-02T00:00:00.000Z' as IsoUtc,
      keyId: 'd'.repeat(64),
      signature: 'sig',
    },
  };
}

// uuidV4 tests
test('uuidV4 matches v4 pattern for 50 inputs', () => {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (let i = 0; i < 50; i++) {
    const random = makeFakeRandom(i);
    const uuid = uuidV4(random);
    assert.match(uuid, uuidPattern);
  }
});

test('uuidV4 forces version and variant for all-zero bytes', () => {
  const random: RandomPort = { bytes: () => new Uint8Array(16) };
  const uuid = uuidV4(random);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('uuidV4 forces version and variant for all-0xff bytes', () => {
  const random: RandomPort = { bytes: () => new Uint8Array(16).fill(0xff) };
  const uuid = uuidV4(random);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('uuidV4 does not modify the array returned by random', () => {
  const original = new Uint8Array(16).fill(0x42);
  const random: RandomPort = { bytes: () => original };
  uuidV4(random);
  assert.deepStrictEqual(original, new Uint8Array(16).fill(0x42));
});

test('uuidV4 throws on wrong-length array', () => {
  const random = makeWrongLengthRandom();
  assert.throws(() => uuidV4(random));
});

// recoveryCommitmentOf and criteriaCommitment tests
test('recoveryCommitmentOf reproduces test vector', async () => {
  const pubkey = 'MCowBQYDK2VwAyEAL80ayIE/KCu8U4zIMc8jguTUiNSDrJsBLxFUvTBF2ow=';
  const expected = '2035dd18061bae4e8fbdfb6048fc0298422ed145776daac92920b8fafdfc7487';
  const result = await recoveryCommitmentOf(port, pubkey);
  assert.strictEqual(result, expected);
});

test('criteriaCommitment reproduces test vector 1', async () => {
  const salt = new Uint8Array(32).fill(0x01);
  const text = 'Write a logo in SVG';
  const expected = 'b7661276e02c46207b11d5b8343a23a30c4fc64d49e64df3f2cdeab13304c430';
  const result = await criteriaCommitment(port, salt, text);
  assert.strictEqual(result, expected);
});

test('criteriaCommitment reproduces test vector 2 (unicode)', async () => {
  const salt = new Uint8Array(32).fill(0x01);
  const text = 'Übersetze äö café 🚀';
  const expected = '09cf570d39358eabda803386ff063d344742364d5097bb9877e41a778b53e815';
  const result = await criteriaCommitment(port, salt, text);
  assert.strictEqual(result, expected);
});

test('criteriaCommitment throws for salt of 31 bytes', async () => {
  const salt = new Uint8Array(31).fill(0x01);
  await assert.rejects(() => criteriaCommitment(port, salt, 'test'));
});

test('criteriaCommitment throws for salt of 33 bytes', async () => {
  const salt = new Uint8Array(33).fill(0x01);
  await assert.rejects(() => criteriaCommitment(port, salt, 'test'));
});

test('criteriaCommitment changes with different salt byte', async () => {
  const salt1 = new Uint8Array(32).fill(0x01);
  const salt2 = new Uint8Array(32).fill(0x01);
  salt2[0] = 0x02;
  const text = 'test';
  const hash1 = await criteriaCommitment(port, salt1, text);
  const hash2 = await criteriaCommitment(port, salt2, text);
  assert.notStrictEqual(hash1, hash2);
});

test('criteriaCommitment changes with different text', async () => {
  const salt = new Uint8Array(32).fill(0x01);
  const hash1 = await criteriaCommitment(port, salt, 'test1');
  const hash2 = await criteriaCommitment(port, salt, 'test2');
  assert.notStrictEqual(hash1, hash2);
});

test('three test vectors are distinct', async () => {
  const pubkey = 'MCowBQYDK2VwAyEAL80ayIE/KCu8U4zIMc8jguTUiNSDrJsBLxFUvTBF2ow=';
  const salt = new Uint8Array(32).fill(0x01);
  const recHash = await recoveryCommitmentOf(port, pubkey);
  const critHash1 = await criteriaCommitment(port, salt, 'Write a logo in SVG');
  const critHash2 = await criteriaCommitment(port, salt, 'Übersetze äö café 🚀');
  assert.notStrictEqual(recHash, critHash1);
  assert.notStrictEqual(recHash, critHash2);
  assert.notStrictEqual(critHash1, critHash2);
});

// buildAccountCreatedPayload tests
test('buildAccountCreatedPayload success', async () => {
  const pubkey = 'MCowBQYDK2VwAyEAL80ayIE/KCu8U4zIMc8jguTUiNSDrJsBLxFUvTBF2ow=';
  const entries: LedgerEntry[] = [];
  const result = await buildAccountCreatedPayload(port, entries, pubkey);
  assert.ok(result.ok);
  assert.deepStrictEqual(Object.keys(result.value), ['pubkey', 'recovery_commitment', 'invite_ref']);
  assert.strictEqual(result.value['pubkey'], pubkey);
  assert.strictEqual(result.value['invite_ref'], null);
  const expectedHash = createHash('sha256').update(`skillx/v1/recovery\n${pubkey}`, 'utf8').digest('hex');
  assert.strictEqual(result.value['recovery_commitment'], expectedHash);
});

test('buildAccountCreatedPayload already registered gives STATE', async () => {
  const pubkey = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(pubkey)];
  const result = await buildAccountCreatedPayload(port, entries, pubkey);
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STATE');
  assert.strictEqual(result.error.path, '$.action.state');
  assert.strictEqual(result.error.message, 'This key is already registered on the ledger');
});

test('buildAccountCreatedPayload rotated gives STATE with different message', async () => {
  const pubkey1 = makePubkey();
  const pubkey2 = makePubkey();
  const entries: LedgerEntry[] = [
    makeAccountCreatedEntry(pubkey1),
    makeKeyRotatedEntry(pubkey1, pubkey2),
  ];
  const result = await buildAccountCreatedPayload(port, entries, pubkey1);
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STATE');
  assert.strictEqual(result.error.path, '$.action.state');
  assert.strictEqual(result.error.message, 'This key was rotated out and cannot be registered again');
});

test('buildAccountCreatedPayload invalid pubkey gives FIELD_FORMAT', async () => {
  const result = await buildAccountCreatedPayload(port, [], 'invalid-pubkey');
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'FIELD_FORMAT');
  assert.strictEqual(result.error.path, '$.pubkey');
});

// buildDealCreatedPayload happy path
test('buildDealCreatedPayload happy path', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [
    makeAccountCreatedEntry(buyer),
    makeAccountCreatedEntry(seller),
  ];
  const random = makeFakeRandom(0);
  const input: DealInput = {
    seller,
    amountText: '100',
    deadlineDaysText: '1',
    criteriaText: 'Some criteria text',
  };
  const result = await buildDealCreatedPayload(
    { crypto: port, random, clock: fakeClock },
    entries,
    buyer,
    input,
  );
  assert.ok(result.ok);
  assert.deepStrictEqual(
    Object.keys(result.value.payload),
    ['deal_id', 'buyer', 'seller', 'amount', 'criteria_hash', 'deadline'],
  );
  assert.strictEqual(result.value.payload['buyer'], buyer);
  assert.match(
    result.value.payload['deal_id'] as string,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.strictEqual(result.value.payload['deadline'], '2026-11-02T12:00:00.000Z');
  assert.strictEqual(result.value.payload['amount'], 100);
  const saltHex = result.value.secret.salt;
  const saltBytes = hexToBytesLower(saltHex);
  const expectedHash = await criteriaCommitment(port, saltBytes, input.criteriaText);
  assert.strictEqual(result.value.payload['criteria_hash'], expectedHash);
  assert.strictEqual(saltHex.length, 64);
  assert.match(saltHex, /^[a-f0-9]{64}$/);
  assert.strictEqual(result.value.secret.criteria_text, 'Some criteria text');
  assert.strictEqual(result.value.secret.created_at, FIXED_ISO);
});

// Validation steps 1-8
test('buildDealCreatedPayload step 1: bad own pubkey', async () => {
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    [],
    'invalid',
    { seller: 'x', amountText: '10', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'FIELD_FORMAT');
  assert.strictEqual(result.error.path, '$.buyer');
  assert.strictEqual(result.error.message, 'Own pubkey is invalid');
});

test('buildDealCreatedPayload step 2: own key unknown', async () => {
  const buyer = makePubkey();
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    [],
    buyer,
    { seller: makePubkey(), amountText: '10', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STATE');
  assert.strictEqual(result.error.path, '$.action.state');
  assert.strictEqual(result.error.message, 'Register this key as a ledger account first');
});

test('buildDealCreatedPayload step 2: own key rotated', async () => {
  const buyer = makePubkey();
  const newKey = makePubkey();
  const entries: LedgerEntry[] = [
    makeAccountCreatedEntry(buyer),
    makeKeyRotatedEntry(buyer, newKey),
  ];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller: makePubkey(), amountText: '10', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STATE');
  assert.strictEqual(result.error.path, '$.action.state');
  assert.strictEqual(result.error.message, 'Register this key as a ledger account first');
});

test('buildDealCreatedPayload step 3: invalid seller', async () => {
  const buyer = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller: 'invalid', amountText: '10', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'FIELD_FORMAT');
  assert.strictEqual(result.error.path, '$.seller');
  assert.strictEqual(result.error.message, 'Seller pubkey is invalid');
});

test('buildDealCreatedPayload step 4: seller equals own', async () => {
  const buyer = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller: buyer, amountText: '10', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'PAYLOAD');
  assert.strictEqual(result.error.path, '$.seller');
  assert.strictEqual(result.error.message, 'Buyer and seller must differ');
});

test('buildDealCreatedPayload step 5: seller not registered', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '10', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STATE');
  assert.strictEqual(result.error.path, '$.seller');
  assert.strictEqual(result.error.message, 'Seller is not a registered account on the verified chain');
});

test('buildDealCreatedPayload step 6: amount 1', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '1', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'AMOUNT');
  assert.strictEqual(result.error.path, '$.amount');
});

test('buildDealCreatedPayload step 6: amount 900719925475', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '900719925475', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'AMOUNT');
  assert.strictEqual(result.error.path, '$.amount');
});

test('buildDealCreatedPayload step 6: amount 12.5', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '12.5', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'AMOUNT');
  assert.strictEqual(result.error.path, '$.amount');
});

test('buildDealCreatedPayload step 6: amount -3', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '-3', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'AMOUNT');
  assert.strictEqual(result.error.path, '$.amount');
});

test('buildDealCreatedPayload step 6: amount abc', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: 'abc', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'AMOUNT');
  assert.strictEqual(result.error.path, '$.amount');
});

test('buildDealCreatedPayload step 6: amount empty', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'AMOUNT');
  assert.strictEqual(result.error.path, '$.amount');
});

test('buildDealCreatedPayload step 6: amount with spaces succeeds', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: ' 10 ', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(result.ok);
  assert.strictEqual(result.value.payload['amount'], 10);
});

test('buildDealCreatedPayload step 7: days 0', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '10', deadlineDaysText: '0', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'WINDOW');
  assert.strictEqual(result.error.path, '$.deadline');
});

test('buildDealCreatedPayload step 7: days 366', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '10', deadlineDaysText: '366', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'WINDOW');
  assert.strictEqual(result.error.path, '$.deadline');
});

test('buildDealCreatedPayload step 7: days 1.5', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '10', deadlineDaysText: '1.5', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'WINDOW');
  assert.strictEqual(result.error.path, '$.deadline');
});

test('buildDealCreatedPayload step 7: days empty', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '10', deadlineDaysText: '', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'WINDOW');
  assert.strictEqual(result.error.path, '$.deadline');
});

test('buildDealCreatedPayload step 8: criteria empty', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '10', deadlineDaysText: '1', criteriaText: '' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'FIELD_FORMAT');
  assert.strictEqual(result.error.path, '$.criteria');
});

test('buildDealCreatedPayload step 8: criteria only spaces', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '10', deadlineDaysText: '1', criteriaText: '   ' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'FIELD_FORMAT');
  assert.strictEqual(result.error.path, '$.criteria');
});

test('buildDealCreatedPayload step 8: criteria 2001 chars fails', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '10', deadlineDaysText: '1', criteriaText: 'x'.repeat(2001) },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'FIELD_FORMAT');
  assert.strictEqual(result.error.path, '$.criteria');
});

test('buildDealCreatedPayload step 8: criteria 2000 chars succeeds', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '10', deadlineDaysText: '1', criteriaText: 'x'.repeat(2000) },
  );
  assert.ok(result.ok);
});

test('buildDealCreatedPayload first failing step wins', async () => {
  const buyer = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer)];
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller: 'invalid', amountText: 'abc', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'FIELD_FORMAT');
  assert.strictEqual(result.error.path, '$.seller');
  assert.strictEqual(result.error.message, 'Seller pubkey is invalid');
});

// Step 9
test('buildDealCreatedPayload step 9: wrong length salt gives SIGNING', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const random: RandomPort = {
    bytes(n: number): Uint8Array {
      if (n === 16) return new Uint8Array(16);
      return new Uint8Array(31);
    },
  };
  const result = await buildDealCreatedPayload(
    { crypto: port, random, clock: fakeClock },
    entries,
    buyer,
    { seller, amountText: '10', deadlineDaysText: '1', criteriaText: 'x' },
  );
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'SIGNING');
  assert.strictEqual(result.error.path, '$.criteria_hash');
});

// Storage tests
test('saveDealSecret and loadDealSecrets round trip', () => {
  const storage = makeFakeStorage();
  const secret: DealSecret = {
    deal_id: '550e8400-e29b-41d4-a716-446655440000',
    salt: 'a'.repeat(64),
    criteria_text: 'test criteria',
    created_at: '2026-11-01T12:00:00.000Z',
  };
  const saveResult = saveDealSecret(storage, secret);
  assert.ok(saveResult.ok);
  const loadResult = loadDealSecrets(storage);
  assert.ok(loadResult.ok);
  assert.strictEqual(loadResult.value.length, 1);
  assert.deepStrictEqual(loadResult.value[0], secret);
  assert.notStrictEqual(loadResult.value[0], secret);
});

test('saveDealSecret twice with same deal_id keeps one entry', () => {
  const storage = makeFakeStorage();
  const secret1: DealSecret = {
    deal_id: 'same-id',
    salt: 'a'.repeat(64),
    criteria_text: 'first',
    created_at: '2026-11-01T12:00:00.000Z',
  };
  const secret2: DealSecret = {
    deal_id: 'same-id',
    salt: 'b'.repeat(64),
    criteria_text: 'second',
    created_at: '2026-11-01T13:00:00.000Z',
  };
  saveDealSecret(storage, secret1);
  saveDealSecret(storage, secret2);
  const result = loadDealSecrets(storage);
  assert.ok(result.ok);
  assert.strictEqual(result.value.length, 1);
  assert.strictEqual(result.value[0]?.criteria_text, 'second');
});

test('saveDealSecret with different ids keeps two entries', () => {
  const storage = makeFakeStorage();
  const secret1: DealSecret = {
    deal_id: 'id-1',
    salt: 'a'.repeat(64),
    criteria_text: 'first',
    created_at: '2026-11-01T12:00:00.000Z',
  };
  const secret2: DealSecret = {
    deal_id: 'id-2',
    salt: 'b'.repeat(64),
    criteria_text: 'second',
    created_at: '2026-11-01T13:00:00.000Z',
  };
  saveDealSecret(storage, secret1);
  saveDealSecret(storage, secret2);
  const result = loadDealSecrets(storage);
  assert.ok(result.ok);
  assert.strictEqual(result.value.length, 2);
});

test('loadDealSecrets corrupt: not json', () => {
  const storage = makeFakeStorage();
  storage.getMap().set(DEAL_SECRETS_KEY, 'not json');
  const result = loadDealSecrets(storage);
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STORE_FAILURE');
  assert.strictEqual(result.error.path, '$.storage');
});

test('loadDealSecrets corrupt: empty object', () => {
  const storage = makeFakeStorage();
  storage.getMap().set(DEAL_SECRETS_KEY, '{}');
  const result = loadDealSecrets(storage);
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STORE_FAILURE');
  assert.strictEqual(result.error.path, '$.storage');
});

test('loadDealSecrets corrupt: 63-char salt', () => {
  const storage = makeFakeStorage();
  const corrupt = JSON.stringify([{
    deal_id: 'x',
    salt: 'a'.repeat(63),
    criteria_text: 'y',
    created_at: '2026-11-01T12:00:00.000Z',
  }]);
  storage.getMap().set(DEAL_SECRETS_KEY, corrupt);
  const result = loadDealSecrets(storage);
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STORE_FAILURE');
  assert.strictEqual(result.error.path, '$.storage');
});

test('saveDealSecret returns STORE_FAILURE on corrupt data without overwriting', () => {
  const storage = makeFakeStorage();
  const corruptText = 'not json';
  storage.getMap().set(DEAL_SECRETS_KEY, corruptText);
  const secret: DealSecret = {
    deal_id: 'new-id',
    salt: 'a'.repeat(64),
    criteria_text: 'test',
    created_at: '2026-11-01T12:00:00.000Z',
  };
  const result = saveDealSecret(storage, secret);
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STORE_FAILURE');
  assert.strictEqual(result.error.path, '$.storage');
  assert.strictEqual(storage.getMap().get(DEAL_SECRETS_KEY), corruptText);
});

test('saveDealSecret with throwing set gives STORE_FAILURE', () => {
  const storage = makeThrowingSetStorage();
  const secret: DealSecret = {
    deal_id: 'x',
    salt: 'a'.repeat(64),
    criteria_text: 'y',
    created_at: '2026-11-01T12:00:00.000Z',
  };
  const result = saveDealSecret(storage, secret);
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STORE_FAILURE');
  assert.strictEqual(result.error.path, '$.storage');
});

test('loadDealSecrets with throwing get gives STORE_FAILURE', () => {
  const storage = makeThrowingGetStorage();
  const result = loadDealSecrets(storage);
  assert.ok(!result.ok);
  assert.strictEqual(result.error.code, 'STORE_FAILURE');
  assert.strictEqual(result.error.path, '$.storage');
});

test('removeDealSecret removes one entry', () => {
  const storage = makeFakeStorage();
  const secret1: DealSecret = {
    deal_id: 'id-1',
    salt: 'a'.repeat(64),
    criteria_text: 'first',
    created_at: '2026-11-01T12:00:00.000Z',
  };
  const secret2: DealSecret = {
    deal_id: 'id-2',
    salt: 'b'.repeat(64),
    criteria_text: 'second',
    created_at: '2026-11-01T13:00:00.000Z',
  };
  saveDealSecret(storage, secret1);
  saveDealSecret(storage, secret2);
  removeDealSecret(storage, 'id-1');
  const result = loadDealSecrets(storage);
  assert.ok(result.ok);
  assert.strictEqual(result.value.length, 1);
  assert.strictEqual(result.value[0]?.deal_id, 'id-2');
});

test('removeDealSecret removes key when list becomes empty', () => {
  const storage = makeFakeStorage();
  const secret: DealSecret = {
    deal_id: 'only-id',
    salt: 'a'.repeat(64),
    criteria_text: 'test',
    created_at: '2026-11-01T12:00:00.000Z',
  };
  saveDealSecret(storage, secret);
  removeDealSecret(storage, 'only-id');
  assert.strictEqual(storage.getMap().has(DEAL_SECRETS_KEY), false);
});

test('removeDealSecret leaves corrupt data untouched', () => {
  const storage = makeFakeStorage();
  const corruptText = 'not json';
  storage.getMap().set(DEAL_SECRETS_KEY, corruptText);
  removeDealSecret(storage, 'some-id');
  assert.strictEqual(storage.getMap().get(DEAL_SECRETS_KEY), corruptText);
});

// Mutation guard tests
test('loadDealSecrets returns copies that can be modified without affecting next load', () => {
  const storage = makeFakeStorage();
  const secret: DealSecret = {
    deal_id: 'id-1',
    salt: 'a'.repeat(64),
    criteria_text: 'original',
    created_at: '2026-11-01T12:00:00.000Z',
  };
  saveDealSecret(storage, secret);
  const result1 = loadDealSecrets(storage);
  assert.ok(result1.ok);
  const first = result1.value[0];
  assert.ok(first !== undefined);
  first.criteria_text = 'modified';
  const result2 = loadDealSecrets(storage);
  assert.ok(result2.ok);
  assert.strictEqual(result2.value[0]?.criteria_text, 'original');
});

test('saveDealSecret does not keep a reference to the given object', () => {
  const storage = makeFakeStorage();
  const secret: DealSecret = {
    deal_id: 'id-1',
    salt: 'a'.repeat(64),
    criteria_text: 'original',
    created_at: '2026-11-01T12:00:00.000Z',
  };
  saveDealSecret(storage, secret);
  secret.criteria_text = 'modified';
  const result = loadDealSecrets(storage);
  assert.ok(result.ok);
  assert.strictEqual(result.value[0]?.criteria_text, 'original');
});
test('buildDealCreatedPayload commits and stores the criteria text untrimmed', async () => {
  const buyer = makePubkey();
  const seller = makePubkey();
  const entries: LedgerEntry[] = [makeAccountCreatedEntry(buyer), makeAccountCreatedEntry(seller)];
  const text = '  keep my spaces \n';
  const result = await buildDealCreatedPayload(
    { crypto: port, random: makeFakeRandom(0), clock: fakeClock },
    entries,
    buyer,
    { seller: `  ${seller}  `, amountText: '10', deadlineDaysText: '1', criteriaText: text },
  );
  assert.ok(result.ok);
  assert.strictEqual(result.value.secret.criteria_text, text);
  assert.strictEqual(result.value.payload['seller'], seller);
  const expected = await criteriaCommitment(port, hexToBytesLower(result.value.secret.salt), text);
  assert.strictEqual(result.value.payload['criteria_hash'], expected);
});

test('uuidV4 sets version 4 and variant bits at fixed positions', () => {
  const zero = uuidV4({ bytes: () => new Uint8Array(16) });
  assert.strictEqual(zero, '00000000-0000-4000-8000-000000000000');
  const ff = uuidV4({ bytes: () => new Uint8Array(16).fill(0xff) });
  assert.strictEqual(ff, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});
