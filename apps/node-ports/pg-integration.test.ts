// apps/node-ports/pg-integration.test.ts
import { test } from 'node:test';
import { createPgSqlPort, pgConnectionOptions } from './pg-sql-port.js';
import { canonical, eventHash, sha256Hex } from '../../packages/crypto/src/index.js';
import { PostgresStore } from '../../packages/relay/src/postgres-store.js';
import { StoreError, type LedgerEntry } from '../../packages/relay/src/store.js';
import { RelayRig } from '../../packages/testing/src/relay-fixtures.js';

type SqlPortParam = Parameters<typeof createPgSqlPort>[0];
type Port = ReturnType<typeof createPgSqlPort>;
type PoolCtor = new (options: { connectionString: string; max: number }) => SqlPortParam;

const skip = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

let schemaCounter = 0;
function nextSchemaName(): string {
  schemaCounter += 1;
  return `schema_${process.pid}_${schemaCounter}`;
}

let lockKeyCounter = 9_000_000;
function nextLockKey(): number {
  const value = lockKeyCounter;
  lockKeyCounter += 1;
  return value;
}

function hasMethod(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[name] === 'function';
}

function isPoolCtor(value: unknown): value is PoolCtor {
  return typeof value === 'function';
}

let poolCtorPromise: Promise<PoolCtor> | undefined;
async function getPoolCtor(): Promise<PoolCtor> {
  if (poolCtorPromise === undefined) {
    poolCtorPromise = loadPoolCtor();
  }
  return poolCtorPromise;
}

async function loadPoolCtor(): Promise<PoolCtor> {
  const pgModuleName = 'pg';
  const mod: unknown = await import(pgModuleName);
  if (typeof mod !== 'object' || mod === null) {
    throw new Error('pg module not found');
  }
  const PoolUnknown = (mod as { Pool?: unknown }).Pool;
  if (!isPoolCtor(PoolUnknown)) {
    throw new Error('pg.Pool is not a constructor');
  }
  return PoolUnknown;
}

async function createPoolAndPort(): Promise<{ pool: SqlPortParam; port: Port }> {
  const Pool = await getPoolCtor();
  const options = pgConnectionOptions({ DATABASE_URL: process.env.TEST_DATABASE_URL });
  const pool = new Pool(options);
  if (!hasMethod(pool, 'connect') || !hasMethod(pool, 'end')) {
    throw new Error('pg.Pool did not produce a PgPoolLike');
  }
  const port = createPgSqlPort(pool);
  return { pool, port };
}

async function createSchema(port: Port, schema: string): Promise<void> {
  await port.query(`CREATE SCHEMA ${schema}`);
}

async function setSearchPath(port: Port, schema: string): Promise<void> {
  await port.query(`SET search_path TO ${schema}`);
}

async function cleanupSchema(schema: string): Promise<void> {
  try {
    const { port } = await createPoolAndPort();
    try {
      await port.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await port.close();
    }
  } catch {
    // ignore cleanup errors
  }
}

function extractCount(result: unknown): number {
  if (typeof result !== 'object' || result === null) {
    throw new Error('unexpected query result');
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('expected one row');
  }
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null) {
    throw new Error('expected row object');
  }
  const count = (row as { c?: unknown }).c;
  if (typeof count !== 'number') {
    throw new Error('expected numeric count');
  }
  return count;
}

async function countRows(port: Port, table: string): Promise<number> {
  const result: unknown = await port.query(`SELECT count(*)::int AS c FROM ${table}`);
  return extractCount(result);
}

async function expectErrorContains(promise: Promise<unknown>, needle: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes(needle)) {
      throw new Error(`expected error containing ${needle}`, { cause: err });
    }
    return;
  }
  throw new Error(`expected error containing ${needle}`);
}

async function expectStoreError(fn: () => Promise<unknown>, needle: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof StoreError)) {
      throw new Error('expected StoreError', { cause: err });
    }
    if (!err.message.includes(needle)) {
      throw new Error(`expected StoreError containing ${needle}`, { cause: err });
    }
    return;
  }
  throw new Error('expected StoreError');
}

function sampleEntries(count: number): LedgerEntry[] {
  const rig = new RelayRig();
  rig.bootstrap();
  for (let i = 1; rig.store.all().length < count; i += 1) {
    rig.openDeal(i);
  }
  return rig.store.all().slice(0, count);
}

function checksumOf(entry: LedgerEntry): string {
  return sha256Hex(canonical(entry));
}

test('migration is idempotent', { skip }, async () => {
  const schema = nextSchemaName();
  const lockKey = nextLockKey();
  const { port } = await createPoolAndPort();
  try {
    await createSchema(port, schema);
    await setSearchPath(port, schema);
    const store1 = new PostgresStore({ sql: port, lockKey });
    await store1.open();
    const ledgerCount = await countRows(port, 'ledger_entries');
    if (ledgerCount !== 0) {
      throw new Error('expected empty ledger_entries');
    }
    const migrations1 = await countRows(port, 'schema_migrations');
    if (migrations1 !== 1) {
      throw new Error('expected one migration row');
    }
    await store1.close();

    const store2 = new PostgresStore({ sql: port, lockKey });
    await store2.open();
    const migrations2 = await countRows(port, 'schema_migrations');
    if (migrations2 !== 1) {
      throw new Error('migration applied twice');
    }
    await store2.close();
  } finally {
    await port.close().catch(() => {});
    await cleanupSchema(schema);
  }
});

test('append and reload', { skip }, async () => {
  const schema = nextSchemaName();
  const lockKey = nextLockKey();
  const { port } = await createPoolAndPort();
  try {
    await createSchema(port, schema);
    await setSearchPath(port, schema);
    const entries = sampleEntries(4);
    const store1 = new PostgresStore({ sql: port, lockKey });
    await store1.open();
    for (const entry of entries) {
      await store1.append(entry);
    }
    await store1.close();

    const store2 = new PostgresStore({ sql: port, lockKey });
    await store2.open();
    const all = store2.all();
    if (all.length !== 4) {
      throw new Error('expected four entries');
    }
    const expected = entries.map((entry) => eventHash(entry.event));
    const actual = all.map((entry) => eventHash(entry.event));
    if (expected.length !== actual.length || expected.some((hash, index) => hash !== actual[index])) {
      throw new Error('event hashes do not match');
    }
    if (store2.tipSequence() !== 4) {
      throw new Error('expected tip sequence 4');
    }
    await store2.close();
  } finally {
    await port.close().catch(() => {});
    await cleanupSchema(schema);
  }
});

test('append-only trigger', { skip }, async () => {
  const schema = nextSchemaName();
  const lockKey = nextLockKey();
  const { port } = await createPoolAndPort();
  try {
    await createSchema(port, schema);
    await setSearchPath(port, schema);
    const [entry] = sampleEntries(1);
    if (entry === undefined) {
      throw new Error('expected one entry');
    }
    const store1 = new PostgresStore({ sql: port, lockKey });
    await store1.open();
    await store1.append(entry);
    await store1.close();

    await expectErrorContains(port.query("UPDATE ledger_entries SET signer = 'x'"), 'append-only');
    await expectErrorContains(port.query('DELETE FROM ledger_entries'), 'append-only');

    const store2 = new PostgresStore({ sql: port, lockKey });
    await store2.open();
    const all = store2.all();
    if (all.length !== 1) {
      throw new Error('expected one entry after failed mutations');
    }
    const [row] = all;
    if (row === undefined || row.event.signer !== entry.event.signer) {
      throw new Error('entry changed');
    }
    await store2.close();
  } finally {
    await port.close().catch(() => {});
    await cleanupSchema(schema);
  }
});

test('unique violation poisons store', { skip }, async () => {
  const schema = nextSchemaName();
  const lockKey1 = nextLockKey();
  const lockKey2 = nextLockKey();
  const { port: port1 } = await createPoolAndPort();
  const { port: port2 } = await createPoolAndPort();
  try {
    await createSchema(port1, schema);
    await setSearchPath(port1, schema);
    await setSearchPath(port2, schema);
    const entries = sampleEntries(2);
    const [first, second] = entries;
    if (first === undefined || second === undefined) {
      throw new Error('expected two entries');
    }
    const store1 = new PostgresStore({ sql: port1, lockKey: lockKey1 });
    await store1.open();
    const tipBefore = store1.tipSequence();
    await port2.query(
      `INSERT INTO ledger_entries (sequence, event_hash, signer, prev_hash, checksum, entry_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [first.receipt.sequence, eventHash(first.event), first.event.signer, first.event.prevHash ?? null, checksumOf(first), canonical(first)],
    );
    await expectStoreError(() => store1.append(first), 'concurrent writer');
    if (!store1.poisoned) {
      throw new Error('store should be poisoned');
    }
    if (store1.tipSequence() !== tipBefore) {
      throw new Error('tip sequence changed after failed append');
    }
    await store1.close().catch(() => {});

    const store2 = new PostgresStore({ sql: port1, lockKey: lockKey2 });
    await store2.open();
    await store2.append(second);
    const all = store2.all();
    if (all.length !== 2) {
      throw new Error('expected two entries after reopen');
    }
    await store2.close();
  } finally {
    await port1.close().catch(() => {});
    await port2.close().catch(() => {});
    await cleanupSchema(schema);
  }
});

test('advisory lock', { skip }, async () => {
  const schema = nextSchemaName();
  const lockKey = nextLockKey();
  const { port: port1 } = await createPoolAndPort();
  const { port: port2 } = await createPoolAndPort();
  try {
    await createSchema(port1, schema);
    await setSearchPath(port1, schema);
    await setSearchPath(port2, schema);
    const store1 = new PostgresStore({ sql: port1, lockKey });
    await store1.open();
    const store2 = new PostgresStore({ sql: port2, lockKey });
    await expectStoreError(() => store2.open(), 'lock');
    await store1.close();
    await store2.open();
    await store2.close();
  } finally {
    await port1.close().catch(() => {});
    await port2.close().catch(() => {});
    await cleanupSchema(schema);
  }
});

test('corrupt ledger is detected', { skip }, async () => {
  const schema = nextSchemaName();
  const lockKey = nextLockKey();
  const { port } = await createPoolAndPort();
  try {
    await createSchema(port, schema);
    await setSearchPath(port, schema);
    const [entry] = sampleEntries(1);
    if (entry === undefined) {
      throw new Error('expected one entry');
    }
    const store1 = new PostgresStore({ sql: port, lockKey });
    await store1.open();
    await store1.append(entry);
    await store1.close();

    const originalChecksum = checksumOf(entry);
    const badChecksum = (originalChecksum[0] === '0' ? '1' : '0') + originalChecksum.slice(1);

    await port.query('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_immutable_trigger');
    try {
      await port.query('UPDATE ledger_entries SET checksum = $1', [badChecksum]);
    } finally {
      await port.query('ALTER TABLE ledger_entries ENABLE TRIGGER ledger_immutable_trigger');
    }

    const store2 = new PostgresStore({ sql: port, lockKey });
    await expectStoreError(() => store2.open(), 'corrupt ledger at row 1');

    await port.query('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_immutable_trigger');
    try {
      await port.query('UPDATE ledger_entries SET checksum = $1', [originalChecksum]);
    } finally {
      await port.query('ALTER TABLE ledger_entries ENABLE TRIGGER ledger_immutable_trigger');
    }

    const store3 = new PostgresStore({ sql: port, lockKey });
    await store3.open();
    await store3.close();
  } finally {
    await port.close().catch(() => {});
    await cleanupSchema(schema);
  }
});

test('connection abort is contained', { skip }, async () => {
  const schema = nextSchemaName();
  const lockKey = nextLockKey();
  const { port: port1 } = await createPoolAndPort();
  try {
    await createSchema(port1, schema);
    await setSearchPath(port1, schema);
    const entries = sampleEntries(4);
    const [e0, e1, e2, e3] = entries;
    if (e0 === undefined || e1 === undefined || e2 === undefined || e3 === undefined) {
      throw new Error('expected four entries');
    }
    const store1 = new PostgresStore({ sql: port1, lockKey });
    await store1.open();
    await store1.append(e0);
    await store1.append(e1);
    await port1.query('SELECT pg_terminate_backend(pg_backend_pid())').catch(() => {});
    await expectStoreError(() => store1.append(e2), 'I/O failure');
    if (!store1.poisoned) {
      throw new Error('store should be poisoned');
    }
    await store1.close().catch(() => {});

    const { port: port2 } = await createPoolAndPort();
    try {
      await setSearchPath(port2, schema);
      const store2 = new PostgresStore({ sql: port2, lockKey });
      await store2.open();
      const existing = store2.all();
      if (existing.length !== 2) {
        throw new Error('expected two entries after abort');
      }
      await store2.append(e2);
      await store2.append(e3);
      const all = store2.all();
      if (all.length !== 4) {
        throw new Error('expected four entries after recovery');
      }
      const expected = entries.map((entry) => eventHash(entry.event));
      const actual = all.map((entry) => eventHash(entry.event));
      if (expected.length !== actual.length || expected.some((hash, index) => hash !== actual[index])) {
        throw new Error('event hashes do not match after recovery');
      }
      await store2.close();
    } finally {
      await port2.close().catch(() => {});
    }
  } finally {
    await port1.close().catch(() => {});
    await cleanupSchema(schema);
  }
});