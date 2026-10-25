// packages/relay/src/postgres-store.ts
import { canonical, sha256Hex } from '../../crypto/src/index.js';
import type { Receipt, SignedEvent } from '../../domain/src/protocol.js';
import { MemoryStore } from './memory-store.js';
import { StoreError, type LedgerEntry } from './store.js';

export type SqlValue = string | number | null;

export interface SqlRows {
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface SqlTx {
  query(text: string, params?: readonly SqlValue[]): Promise<SqlRows>;
}

export interface SqlPort extends SqlTx {
  transaction<T>(work: (tx: SqlTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const SQL = {
  createMigrations:
    'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  selectMigrations:
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  insertMigration:
    'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
  advisoryLock: 'SELECT pg_try_advisory_lock($1) AS locked',
  advisoryUnlock: 'SELECT pg_advisory_unlock($1)',
  selectAll:
    'SELECT sequence, checksum, entry_json FROM ledger_entries ORDER BY sequence',
  insertEntry:
    'INSERT INTO ledger_entries (sequence, event_hash, signer, prev_hash, checksum, entry_json) VALUES ($1, $2, $3, $4, $5, $6)',
} as const;

export const MIGRATIONS: readonly {
  version: number;
  name: string;
  statements: readonly string[];
}[] = [
  {
    version: 1,
    name: 'ledger_entries',
    statements: [
      'CREATE TABLE ledger_entries (sequence bigint PRIMARY KEY, event_hash char(64) NOT NULL UNIQUE, signer text NOT NULL, prev_hash char(64) NULL, checksum char(64) NOT NULL, entry_json text NOT NULL)',
      'CREATE UNIQUE INDEX ledger_signer_prev ON ledger_entries (signer, prev_hash) WHERE prev_hash IS NOT NULL',
      'CREATE UNIQUE INDEX ledger_signer_genesis ON ledger_entries (signer) WHERE prev_hash IS NULL',
      "CREATE FUNCTION ledger_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'ledger_entries is append-only'; END; $$ LANGUAGE plpgsql",
      'CREATE TRIGGER ledger_immutable_trigger BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_immutable()',
    ],
  },
];

export const DEFAULT_LOCK_KEY = 1;

export interface PostgresStoreOptions {
  sql: SqlPort;
  lockKey?: number;
}

export class PostgresStore extends MemoryStore {
  private readonly sql: SqlPort;
  private readonly lockKey: number;
  private isOpenFlag = false;
  private lockHeld = false;
  private poisonedFlag = false;

  constructor(options: PostgresStoreOptions) {
    super();
    this.sql = options.sql;
    this.lockKey = options.lockKey ?? DEFAULT_LOCK_KEY;
  }

  override async open(): Promise<void> {
    if (this.isOpenFlag) {
      throw new StoreError('already open');
    }

    this.#reset();
    let locked = false;

    try {
      const lockRows = await this.sql.query(SQL.advisoryLock, [this.lockKey]);
      const acquired = readLocked(lockRows);

      if (!acquired) {
        throw new StoreError('another relay holds the ledger lock');
      }

      this.lockHeld = true;
      locked = true;

      await this.applyMigrations();

      const rows = await this.sql.query(SQL.selectAll);

      for (let index = 0; index < rows.rows.length; index += 1) {
        const row = rows.rows[index];

        if (row === undefined) {
          throw new StoreError(
            `corrupt ledger at row ${index + 1}: missing row`,
          );
        }

        try {
          const sequence = readPositiveInt(own(row, 'sequence'), 'sequence');

          if (sequence !== index + 1) {
            throw new StoreError(`sequence mismatch: expected ${index + 1}`);
          }

          const checksum = readString(own(row, 'checksum'), 'checksum');
          const entryJson = readString(own(row, 'entry_json'), 'entry_json');

          if (sha256Hex(entryJson) !== checksum) {
            throw new StoreError('checksum mismatch');
          }

          const parsed: unknown = JSON.parse(entryJson);

          if (canonical(parsed) !== entryJson) {
            throw new StoreError('entry_json is not canonical');
          }

          const entry = toLedgerEntry(parsed);
          const hash = this.check(entry);

          this.index(entry, hash);
        } catch (error) {
          if (error instanceof StoreError) {
            throw new StoreError(
              `corrupt ledger at row ${index + 1}: ${error.message}`,
            );
          }

          throw new StoreError(
            `corrupt ledger at row ${index + 1}: ${messageOf(error)}`,
          );
        }
      }

      this.poisonedFlag = false;
      this.isOpenFlag = true;
    } catch (error) {
      if (locked) {
        await this.releaseLock();
      }

      this.#reset();
      this.isOpenFlag = false;

      if (error instanceof StoreError) {
        throw error;
      }

      throw new StoreError(`failed to open store: ${messageOf(error)}`);
    }
  }

  override async append(entry: LedgerEntry): Promise<void> {
    if (!this.isOpenFlag) {
      throw new StoreError('store is not open');
    }

    if (this.poisonedFlag) {
      throw new StoreError(
        'store is poisoned by an earlier I/O failure; reopen it',
      );
    }

    const hash = this.check(entry);

    let entryJson: string;

    try {
      entryJson = canonical(entry);
    } catch (error) {
      throw new StoreError(`cannot encode entry: ${messageOf(error)}`);
    }

    const checksum = sha256Hex(entryJson);
    const sequence = this.tipSequence() + 1;
    const signer = entry.event.signer;
    const prevHash = entry.event.prevHash ?? null;

    try {
      await this.sql.transaction(async (tx) => {
        await tx.query(SQL.insertEntry, [
          sequence,
          hash,
          signer,
          prevHash,
          checksum,
          entryJson,
        ]);
      });
    } catch (error) {
      this.poisonedFlag = true;

      if (isUniqueViolation(error)) {
        throw new StoreError('append conflicts with a concurrent writer');
      }

      throw new StoreError(`I/O failure during append: ${messageOf(error)}`);
    }

    this.index(entry, hash);
  }

  override async close(): Promise<void> {
    this.isOpenFlag = false;
    this.poisonedFlag = false;

    await this.releaseLock();
  }

  get poisoned(): boolean {
    return this.poisonedFlag;
  }

  private async applyMigrations(): Promise<void> {
    await this.sql.query(SQL.createMigrations);

    const rows = await this.sql.query(SQL.selectMigrations);
    let expectedVersion = 1;

    for (const row of rows.rows) {
      const version = readPositiveInt(
        own(row, 'version'),
        'migration version',
      );

      if (version > MIGRATIONS.length) {
        throw new StoreError(
          `database has unknown migration version ${version}`,
        );
      }

      if (version !== expectedVersion) {
        throw new StoreError(`migration history gap at version ${version}`);
      }

      const known = MIGRATIONS[version - 1];

      if (known === undefined) {
        throw new StoreError(`unknown migration version ${version}`);
      }

      const name = readString(own(row, 'name'), 'migration name');
      const checksum = readString(own(row, 'checksum'), 'migration checksum');

      if (name !== known.name) {
        throw new StoreError(`migration ${version} name mismatch`);
      }

      if (checksum !== migrationChecksum(known)) {
        throw new StoreError(`migration ${version} checksum mismatch`);
      }

      expectedVersion += 1;
    }

    for (
      let index = expectedVersion - 1;
      index < MIGRATIONS.length;
      index += 1
    ) {
      const migration = MIGRATIONS[index];

      if (migration === undefined) {
        throw new StoreError(`unknown migration index ${index}`);
      }

      const checksum = migrationChecksum(migration);

      await this.sql.transaction(async (tx) => {
        for (const statement of migration.statements) {
          await tx.query(statement);
        }

        await tx.query(SQL.insertMigration, [
          migration.version,
          migration.name,
          checksum,
        ]);
      });
    }
  }

  #reset(): void {
    this.entries.length = 0;
    this.byEventHash.clear();
    this.tips.clear();
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) {
      return;
    }

    this.lockHeld = false;

    try {
      await this.sql.query(SQL.advisoryUnlock, [this.lockKey]);
    } catch {
      // Closing must remain idempotent and must not mask earlier failures.
    }
  }
}

function migrationChecksum(migration: {
  readonly statements: readonly string[];
}): string {
  return sha256Hex(migration.statements.join('\n'));
}

function readLocked(rows: SqlRows): boolean {
  if (rows.rows.length !== 1) {
    throw new StoreError('invalid advisory lock result');
  }

  const row = rows.rows[0];

  if (row === undefined) {
    throw new StoreError('invalid advisory lock result');
  }

  const value = own(row, 'locked');

  if (typeof value !== 'boolean') {
    throw new StoreError('invalid advisory lock result');
  }

  return value;
}

function toLedgerEntry(value: unknown): LedgerEntry {
  if (!isRecord(value)) {
    throw new StoreError('entry is not an object');
  }

  if (!Object.hasOwn(value, 'event') || !Object.hasOwn(value, 'receipt')) {
    throw new StoreError('entry must contain event and receipt');
  }

  const event = value.event;
  const receipt = value.receipt;

  if (!isRecord(event)) {
    throw new StoreError('entry.event is not an object');
  }

  if (!isRecord(receipt)) {
    throw new StoreError('entry.receipt is not an object');
  }

  return {
    event: event as unknown as SignedEvent,
    receipt: receipt as unknown as Receipt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(
  record: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readPositiveInt(value: unknown, name: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new StoreError(`invalid ${name}`);
    }

    return value;
  }

  if (typeof value === 'string') {
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new StoreError(`invalid ${name}`);
    }

    const parsed = Number(value);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new StoreError(`invalid ${name}`);
    }

    return parsed;
  }

  throw new StoreError(`invalid ${name}`);
}

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new StoreError(`invalid ${name}`);
  }

  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Object.hasOwn(error, 'code') &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}