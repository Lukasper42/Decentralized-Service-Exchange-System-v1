// packages/relay/src/postgres-store.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { eventHash, sha256Hex } from '../../crypto/src/index.js';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import {
  MIGRATIONS,
  PostgresStore,
  SQL,
  type SqlPort,
  type SqlRows,
  type SqlTx,
  type SqlValue,
} from './postgres-store.js';
import { StoreError, type LedgerEntry } from './store.js';

interface FakeMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

interface FakeLedgerRow {
  sequence: number;
  event_hash: string;
  signer: string;
  prev_hash: string | null;
  checksum: string;
  entry_json: string;
}

interface FakeSnapshot {
  rows: FakeLedgerRow[];
  migrations: FakeMigrationRow[];
}

class FakeSql implements SqlPort {
  public rows: FakeLedgerRow[] = [];
  public migrations: FakeMigrationRow[] = [];
  public lockHeld = false;
  public lockHeldElsewhere = false;
  public insertEntryCount = 0;

  private nextQueryFailure: string | null = null;
  private nextCommitFailure = false;
  private readonly migrationStatements: ReadonlySet<string>;

  constructor() {
    this.migrationStatements = new Set(
      MIGRATIONS.flatMap((migration) => migration.statements),
    );
  }

  public failNextQuery(text: string): void {
    this.nextQueryFailure = text;
  }

  public failNextCommit(): void {
    this.nextCommitFailure = true;
  }

  async query(
    text: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlRows> {
    if (this.nextQueryFailure === text) {
      this.nextQueryFailure = null;
      throw new Error('injected query failure');
    }

    if (text === SQL.createMigrations) {
      return { rows: [] };
    }

    if (text === SQL.selectMigrations) {
      return {
        rows: this.migrations
          .slice()
          .sort((left, right) => left.version - right.version)
          .map((migration) => ({
            version: migration.version,
            name: migration.name,
            checksum: migration.checksum,
          })),
      };
    }

    if (text === SQL.insertMigration) {
      const version = paramNumber(params, 0);
      const name = paramString(params, 1);
      const checksum = paramString(params, 2);

      this.migrations.push({ version, name, checksum });

      return { rows: [] };
    }

    if (text === SQL.advisoryLock) {
      const locked = !this.lockHeldElsewhere && !this.lockHeld;

      if (locked) {
        this.lockHeld = true;
      }

      return { rows: [{ locked }] };
    }

    if (text === SQL.advisoryUnlock) {
      this.lockHeld = false;
      return { rows: [] };
    }

    if (text === SQL.selectAll) {
      return {
        rows: this.rows
          .slice()
          .sort((left, right) => left.sequence - right.sequence)
          .map((row) => ({ ...row })),
      };
    }

    if (text === SQL.insertEntry) {
      this.insertEntryCount += 1;

      const sequence = paramNumber(params, 0);
      const eventHashValue = paramString(params, 1);
      const signer = paramString(params, 2);
      const prevHash = paramNullableString(params, 3);
      const checksum = paramString(params, 4);
      const entryJson = paramString(params, 5);

      if (this.rows.some((row) => row.sequence === sequence)) {
        throw this.duplicate();
      }

      if (this.rows.some((row) => row.event_hash === eventHashValue)) {
        throw this.duplicate();
      }

      if (prevHash === null) {
        if (
          this.rows.some(
            (row) => row.signer === signer && row.prev_hash === null,
          )
        ) {
          throw this.duplicate();
        }
      } else if (
        this.rows.some(
          (row) => row.signer === signer && row.prev_hash === prevHash,
        )
      ) {
        throw this.duplicate();
      }

      this.rows.push({
        sequence,
        event_hash: eventHashValue,
        signer,
        prev_hash: prevHash,
        checksum,
        entry_json: entryJson,
      });

      return { rows: [] };
    }

    if (this.migrationStatements.has(text)) {
      return { rows: [] };
    }

    throw new Error(`unexpected SQL: ${text}`);
  }

  async transaction<T>(work: (tx: SqlTx) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot();

    try {
      const result = await work(this);

      if (this.nextCommitFailure) {
        this.nextCommitFailure = false;
        this.restore(snapshot);
        throw new Error('injected commit failure');
      }

      return result;
    } catch (error) {
      this.nextCommitFailure = false;
      this.restore(snapshot);
      throw error;
    }
  }

  async close(): Promise<void> {
    // The connection belongs to the caller of the real port.
  }

  private duplicate(): Error {
    return Object.assign(new Error('duplicate key'), { code: '23505' });
  }

  private snapshot(): FakeSnapshot {
    return {
      rows: this.rows.map((row) => ({ ...row })),
      migrations: this.migrations.map((migration) => ({ ...migration })),
    };
  }

  private restore(snapshot: FakeSnapshot): void {
    this.rows = snapshot.rows;
    this.migrations = snapshot.migrations;
  }
}

async function makeEntries(count: number): Promise<LedgerEntry[]> {
  const rig = new RelayRig();
  rig.bootstrap();
  for (let i = 1; rig.store.all().length < count; i += 1) rig.openDeal(i);
  return rig.store.all().slice(0, count);
}

async function appendAll(
  store: PostgresStore,
  entries: readonly LedgerEntry[],
): Promise<void> {
  for (const entry of entries) {
    await store.append(entry);
  }
}

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function paramAt(params: readonly SqlValue[], index: number): SqlValue {
  const value = params[index];

  if (value === undefined) {
    throw new Error('missing SQL parameter');
  }

  return value;
}

function paramNumber(params: readonly SqlValue[], index: number): number {
  const value = paramAt(params, index);

  if (typeof value !== 'number') {
    throw new Error('invalid numeric SQL parameter');
  }

  return value;
}

function paramString(params: readonly SqlValue[], index: number): string {
  const value = paramAt(params, index);

  if (typeof value !== 'string') {
    throw new Error('invalid string SQL parameter');
  }

  return value;
}

function paramNullableString(
  params: readonly SqlValue[],
  index: number,
): string | null {
  const value = paramAt(params, index);

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('invalid nullable string SQL parameter');
  }

  return value;
}

test('open applies migration 1 once', async () => {
  const fake = new FakeSql();
  const store = new PostgresStore({ sql: fake });

  await store.open();
  assert.equal(fake.migrations.length, 1);

  await store.close();

  const second = new PostgresStore({ sql: fake });

  await second.open();
  assert.equal(fake.migrations.length, 1);

  await second.close();
});

test('entries survive close and reopen', async () => {
  const entries = await makeEntries(4);
  const fake = new FakeSql();
  const store = new PostgresStore({ sql: fake });

  await store.open();
  await appendAll(store, entries);
  await store.close();

  const reopened = new PostgresStore({ sql: fake });

  await reopened.open();

  assert.deepEqual(
    reopened.all().map((entry) => eventHash(entry.event)),
    entries.map((entry) => eventHash(entry.event)),
  );
  assert.equal(reopened.tipSequence(), 4);
  assert.equal(
    reopened.signerTip(entries[3]!.event.signer),
    eventHash(entries[3]!.event),
  );

  await reopened.close();
});

test('append rejects invalid entries before SQL', async () => {
  const entries = await makeEntries(2);
  const fake = new FakeSql();
  const store = new PostgresStore({ sql: fake });

  await store.open();

  const before = fake.insertEntryCount;

  await assert.rejects(() => store.append(entries[1]!), StoreError);
  assert.equal(fake.insertEntryCount, before);

  const badReceipt: LedgerEntry = {
    ...entries[0]!,
    receipt: {
      ...entries[0]!.receipt,
      eventHash: 'x',
    },
  };

  await assert.rejects(() => store.append(badReceipt), StoreError);
  assert.equal(fake.insertEntryCount, before);

  await store.append(entries[0]!);
  assert.equal(fake.insertEntryCount, before + 1);

  await assert.rejects(() => store.append(entries[0]!), StoreError);
  assert.equal(fake.insertEntryCount, before + 1);

  await store.append(entries[1]!);
  assert.equal(store.tipSequence(), 2);

  await store.close();
});

test('I/O failure during append poisons the store', async () => {
  const entries = await makeEntries(2);
  const fake = new FakeSql();
  const store = new PostgresStore({ sql: fake });

  await store.open();
  await store.append(entries[0]!);

  fake.failNextQuery(SQL.insertEntry);

  await assert.rejects(
    () => store.append(entries[1]!),
    /I\/O failure during append/,
  );

  assert.equal(store.tipSequence(), 1);
  assert.equal(fake.rows.length, 1);
  assert.equal(store.poisoned, true);

  await assert.rejects(() => store.append(entries[1]!), /poisoned/);

  await store.close();

  const reopened = new PostgresStore({ sql: fake });

  await reopened.open();
  await reopened.append(entries[1]!);

  assert.equal(reopened.tipSequence(), 2);

  await reopened.close();
});

test('unique violation during append poisons the store', async () => {
  const entries = await makeEntries(2);
  const fake = new FakeSql();
  const store = new PostgresStore({ sql: fake });

  await store.open();
  await store.append(entries[0]!);

  await fake.query(SQL.insertEntry, [
    2,
    'other',
    'other-signer',
    null,
    'checksum',
    '{}',
  ]);

  await assert.rejects(
    () => store.append(entries[1]!),
    /concurrent writer/,
  );

  assert.equal(store.poisoned, true);

  await store.close();
});

test('open fails when advisory lock is held elsewhere', async () => {
  const fake = new FakeSql();
  fake.lockHeldElsewhere = true;

  const store = new PostgresStore({ sql: fake });

  await assert.rejects(() => store.open(), /lock/);
  await store.close();
});

test('open rejects manipulated ledger rows', async () => {
  const entries = await makeEntries(3);

  const corruptions: ReadonlyArray<(row: FakeLedgerRow) => void> = [
    (row) => {
      row.checksum = 'x';
    },
    (row) => {
      row.entry_json = `${row.entry_json} `;
    },
    (row) => {
      row.sequence += 1;
    },
    (row) => {
      const parsed = JSON.parse(row.entry_json) as unknown;
      const nonCanonical = JSON.stringify(parsed, null, 2);

      if (nonCanonical === undefined) {
        throw new Error('could not create non-canonical JSON');
      }

      row.entry_json = nonCanonical;
      row.checksum = sha256Hex(nonCanonical);
    },
  ];

  for (const corrupt of corruptions) {
    const fake = new FakeSql();
    const store = new PostgresStore({ sql: fake });

    await store.open();
    await appendAll(store, entries);
    await store.close();

    const row = fake.rows[0];

    if (row === undefined) {
      throw new Error('missing seeded row');
    }

    corrupt(row);

    const reopened = new PostgresStore({ sql: fake });

    await assert.rejects(() => reopened.open(), /corrupt ledger at row 1/);
    assert.equal(fake.lockHeld, false);

    await reopened.close();
  }
});

test('open rejects migration checksum mismatch and unknown versions', async () => {
  const fake = new FakeSql();
  const store = new PostgresStore({ sql: fake });

  await store.open();
  await store.close();

  const migration = fake.migrations[0];

  if (migration === undefined) {
    throw new Error('missing migration');
  }

  migration.checksum = 'x';

  const checksumStore = new PostgresStore({ sql: fake });

  await assert.rejects(() => checksumStore.open(), /checksum/);
  await checksumStore.close();

  const higherFake = new FakeSql();
  const higherStore = new PostgresStore({ sql: higherFake });

  await higherStore.open();
  await higherStore.close();

  higherFake.migrations.push({
    version: 2,
    name: 'future',
    checksum: 'x',
  });

  const unknownStore = new PostgresStore({ sql: higherFake });

  await assert.rejects(() => unknownStore.open(), /unknown migration version/);
  await unknownStore.close();
});

test('commit failure leaves no visible row', async () => {
  const entries = await makeEntries(2);
  const fake = new FakeSql();
  const store = new PostgresStore({ sql: fake });

  await store.open();
  await store.append(entries[0]!);

  const beforeRows = fake.rows.length;
  const beforeTip = store.tipSequence();

  fake.failNextCommit();

  await assert.rejects(
    () => store.append(entries[1]!),
    /I\/O failure during append/,
  );

  assert.equal(fake.rows.length, beforeRows);
  assert.equal(store.tipSequence(), beforeTip);
  assert.equal(store.poisoned, true);

  await store.close();
});

test('seeded randomized appends keep store and database consistent', async () => {
  const entries = await makeEntries(6);
  const next = makeLcg(123456789);

  for (let run = 0; run < 50; run += 1) {
    const fake = new FakeSql();
    let store = new PostgresStore({ sql: fake });

    await store.open();

    for (let index = 0; index < 6; index += 1) {
      const choice = Math.floor(next() * 3);

      if (choice === 1) {
        fake.failNextQuery(SQL.insertEntry);

        await assert.rejects(
          () => store.append(entries[index]!),
          /I\/O failure during append/,
        );

        await store.close();
        store = new PostgresStore({ sql: fake });
        await store.open();
        await store.append(entries[index]!);
      } else if (choice === 2) {
        fake.failNextCommit();

        await assert.rejects(
          () => store.append(entries[index]!),
          /I\/O failure during append/,
        );

        await store.close();
        store = new PostgresStore({ sql: fake });
        await store.open();
        await store.append(entries[index]!);
      } else {
        await store.append(entries[index]!);
      }

      assert.equal(store.tipSequence(), fake.rows.length);
    }

    const before = store.all().map((entry) => eventHash(entry.event));

    await store.close();

    const reopened = new PostgresStore({ sql: fake });

    await reopened.open();

    assert.equal(reopened.tipSequence(), fake.rows.length);
    assert.deepEqual(
      reopened.all().map((entry) => eventHash(entry.event)),
      before,
    );

    await reopened.close();
  }
});

test('prototype pollution in entry_json is rejected', async () => {
  const fake = new FakeSql();
  const entryJson = '{"__proto__":{"polluted":true}}';

  fake.rows.push({
    sequence: 1,
    event_hash: 'x',
    signer: 'x',
    prev_hash: null,
    checksum: sha256Hex(entryJson),
    entry_json: entryJson,
  });

  const store = new PostgresStore({ sql: fake });

  await assert.rejects(() => store.open(), /corrupt ledger at row 1/);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);

  await store.close();
});