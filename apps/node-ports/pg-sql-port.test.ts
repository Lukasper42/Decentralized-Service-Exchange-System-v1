import test from 'node:test';
import assert from 'node:assert/strict';
import type { SqlTx } from '../../packages/relay/src/postgres-store.js';
import {
  createPgSqlPort,
  pgConnectionOptions,
  type PgClientLike,
  type PgPoolLike,
  type PgQueryResult,
} from './pg-sql-port.js';

type ReleaseArg = Error | boolean | undefined;

class FakePool implements PgPoolLike {
  readonly log: string[] = [];
  readonly releases: ReleaseArg[] = [];
  maxConcurrent = 0;
  connectCalls = 0;
  endCalls = 0;

  private readonly failures = new Map<string, Error>();
  private activeQueries = 0;

  failOn(text: string, error: Error): void {
    this.failures.set(text, error);
  }

  async connect(): Promise<PgClientLike> {
    this.log.push('connect');
    this.connectCalls += 1;
    await Promise.resolve();
    return new FakeClient(this);
  }

  async query(text: string, _params?: unknown[]): Promise<PgQueryResult> {
    return this.runQuery(text);
  }

  async end(): Promise<void> {
    this.log.push('end');
    this.endCalls += 1;
    await Promise.resolve();
  }

  async runQuery(text: string): Promise<PgQueryResult> {
    this.log.push(`query:${text}`);
    this.activeQueries += 1;
    if (this.activeQueries > this.maxConcurrent) {
      this.maxConcurrent = this.activeQueries;
    }
    try {
      await Promise.resolve();
      const failure = this.failures.get(text);
      if (failure !== undefined) {
        throw failure;
      }
      return { rows: [] };
    } finally {
      this.activeQueries -= 1;
    }
  }

  release(error?: Error | boolean): void {
    this.log.push('release');
    this.releases.push(error);
  }
}

class FakeClient implements PgClientLike {
  constructor(private readonly pool: FakePool) {}

  query(text: string, _params?: unknown[]): Promise<PgQueryResult> {
    return this.pool.runQuery(text);
  }

  release(error?: Error | boolean): void {
    this.pool.release(error);
  }
}

function sqlError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function hasStringCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected function to throw');
}

function assertTransactionLog(log: readonly string[]): void {
  let inTransaction = false;
  for (const entry of log) {
    if (entry === 'query:BEGIN') {
      assert.equal(inTransaction, false, 'nested BEGIN');
      inTransaction = true;
      continue;
    }
    if (entry === 'query:COMMIT' || entry === 'query:ROLLBACK') {
      assert.equal(inTransaction, true, 'transaction end without BEGIN');
      inTransaction = false;
      continue;
    }
    if (entry.startsWith('query:')) {
      const text = entry.slice('query:'.length);
      if (inTransaction) {
        assert.ok(text.startsWith('tx-'), `foreign query in transaction: ${text}`);
      } else {
        assert.ok(text.startsWith('plain-'), `foreign query outside transaction: ${text}`);
      }
    }
  }
  assert.equal(inTransaction, false, 'unterminated transaction');
}

class Lcg {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state;
  }

  nextInt(maxExclusive: number): number {
    return this.next() % maxExclusive;
  }
}

function randomError(rng: Lcg, label: string): Error {
  if (rng.nextInt(2) === 0) {
    return new Error(`broken-${label}`);
  }
  return sqlError(`sql-${label}`, rng.nextInt(2) === 0 ? '23505' : '40000');
}

test('query uses one dedicated connection for parallel calls', async () => {
  const pool = new FakePool();
  const port = createPgSqlPort(pool);
  const texts = Array.from({ length: 10 }, (_, index) => `q-${index}`);

  const results = await Promise.all(texts.map((text) => port.query(text)));

  assert.equal(results.length, 10);
  assert.equal(pool.connectCalls, 1);
  assert.equal(pool.maxConcurrent, 1);
  assert.equal(pool.log.filter((entry) => entry === 'connect').length, 1);

  await port.close();
});

test('transaction runs BEGIN, work queries, and COMMIT on the same connection', async () => {
  const pool = new FakePool();
  const port = createPgSqlPort(pool);

  const result = await port.transaction(async (tx) => {
    await tx.query('first', [1]);
    await tx.query('second');
    return 42;
  });

  assert.equal(result, 42);
  assert.deepEqual(pool.log, [
    'connect',
    'query:BEGIN',
    'query:first',
    'query:second',
    'query:COMMIT',
  ]);

  await port.close();
});

test('work error triggers ROLLBACK and preserves original error identity', async () => {
  const pool = new FakePool();
  const port = createPgSqlPort(pool);
  const original = sqlError('duplicate', '23505');
  pool.failOn('boom', original);

  let caught: unknown;
  try {
    await port.transaction(async (tx) => {
      await tx.query('ok');
      await tx.query('boom');
    });
  } catch (error: unknown) {
    caught = error;
  }

  assert.equal(caught, original);
  assert.equal(hasStringCode(caught), true);
  if (caught instanceof Error) {
    assert.equal((caught as { code?: unknown }).code, '23505');
  }
  assert.deepEqual(pool.log, [
    'connect',
    'query:BEGIN',
    'query:ok',
    'query:boom',
    'query:ROLLBACK',
  ]);
  assert.equal(pool.connectCalls, 1);
  assert.equal(pool.releases.length, 0);

  await port.close();
});

test('COMMIT failure triggers ROLLBACK and throws the COMMIT error', async () => {
  const pool = new FakePool();
  const port = createPgSqlPort(pool);
  const commitError = sqlError('commit failed', '40000');
  pool.failOn('COMMIT', commitError);

  let caught: unknown;
  try {
    await port.transaction(async (tx) => {
      await tx.query('work');
      return 1;
    });
  } catch (error: unknown) {
    caught = error;
  }

  assert.equal(caught, commitError);
  assert.deepEqual(pool.log, [
    'connect',
    'query:BEGIN',
    'query:work',
    'query:COMMIT',
    'query:ROLLBACK',
  ]);

  await port.close();
});

test('ROLLBACK failure does not replace the original work error', async () => {
  const pool = new FakePool();
  const port = createPgSqlPort(pool);
  const original = sqlError('work failed', '23505');
  const rollbackError = new Error('rollback failed');
  pool.failOn('work', original);
  pool.failOn('ROLLBACK', rollbackError);

  let caught: unknown;
  try {
    await port.transaction(async (tx) => {
      await tx.query('work');
    });
  } catch (error: unknown) {
    caught = error;
  }

  assert.equal(caught, original);
  assert.deepEqual(pool.log, [
    'connect',
    'query:BEGIN',
    'query:work',
    'query:ROLLBACK',
    'release',
  ]);
  assert.equal(pool.releases.length, 1);
  assert.equal(pool.releases[0], rollbackError);

  await port.close();
});

test('parallel transactions and queries run strictly serially', async () => {
  const pool = new FakePool();
  const port = createPgSqlPort(pool);

  const first = port.transaction(async (tx) => {
    await tx.query('t1a');
    await tx.query('t1b');
    return 1;
  });
  const second = port.transaction(async (tx) => {
    await tx.query('t2a');
    return 2;
  });
  const plain = port.query('plain');

  await Promise.all([first, second, plain]);

  assert.equal(pool.maxConcurrent, 1);
  assert.deepEqual(pool.log, [
    'connect',
    'query:BEGIN',
    'query:t1a',
    'query:t1b',
    'query:COMMIT',
    'query:BEGIN',
    'query:t2a',
    'query:COMMIT',
    'query:plain',
  ]);

  await port.close();
});

test('connection errors without code release and reconnect', async () => {
  const pool = new FakePool();
  const port = createPgSqlPort(pool);
  const broken = new Error('socket closed');
  pool.failOn('bad', broken);

  await assert.rejects(port.query('bad'), (error: unknown) => error === broken);

  assert.equal(pool.connectCalls, 1);
  assert.equal(pool.releases.length, 1);
  assert.equal(pool.releases[0], broken);

  await port.query('ok');

  assert.equal(pool.connectCalls, 2);
  assert.deepEqual(pool.log, [
    'connect',
    'query:bad',
    'release',
    'connect',
    'query:ok',
  ]);

  await port.close();
});

test('SQL errors with code do not release or reconnect', async () => {
  const pool = new FakePool();
  const port = createPgSqlPort(pool);
  const duplicate = sqlError('duplicate', '23505');
  pool.failOn('dup', duplicate);

  await assert.rejects(port.query('dup'), (error: unknown) => error === duplicate);

  assert.equal(pool.releases.length, 0);

  await port.query('ok');

  assert.equal(pool.connectCalls, 1);
  assert.deepEqual(pool.log, ['connect', 'query:dup', 'query:ok']);

  await port.close();
});

test('tx.query after transaction end throws transaction is closed', async () => {
  const pool = new FakePool();
  const port = createPgSqlPort(pool);
  let saved: SqlTx | undefined;

  await port.transaction(async (tx) => {
    saved = tx;
    await tx.query('inside');
    return 1;
  });

  if (saved === undefined) {
    throw new Error('transaction was not captured');
  }

  await assert.rejects(saved.query('after'), /transaction is closed/);

  await port.close();
});

test('close releases once, ends once, and is idempotent', async () => {
  const pool = new FakePool();
  const port = createPgSqlPort(pool);

  await port.query('one');
  await port.close();

  assert.equal(pool.log.filter((entry) => entry === 'release').length, 1);
  assert.equal(pool.log.filter((entry) => entry === 'end').length, 1);

  await port.close();

  assert.equal(pool.log.filter((entry) => entry === 'release').length, 1);
  assert.equal(pool.log.filter((entry) => entry === 'end').length, 1);

  await assert.rejects(port.query('two'), /sql port is closed/);
  await assert.rejects(port.transaction(() => Promise.resolve(1)), /sql port is closed/);
});

test('pgConnectionOptions validates DATABASE_URL without leaking it', () => {
  const success = pgConnectionOptions({
    DATABASE_URL: 'postgres://u:p@h:5432/d',
  });
  assert.deepEqual(success, {
    connectionString: 'postgres://u:p@h:5432/d',
    max: 2,
  });

  assert.throws(() => pgConnectionOptions({}), /DATABASE_URL is required/);
  assert.throws(
    () => pgConnectionOptions({ DATABASE_URL: '' }),
    /DATABASE_URL is required/
  );

  assert.equal(
    pgConnectionOptions({ DATABASE_URL: 'postgresql://u:p@h/d' }).max,
    2
  );

  const password = ['s', 'e', 'c', 'r', 'e', 't', String(4321)].join('');
  const badUrl = `mysql://user:${password}@host:5432/db`;
  const error = captureError(() =>
    pgConnectionOptions({ DATABASE_URL: badUrl })
  );

  assert.match(error.message, /postgres:\/\/ URL/);
  assert.equal(error.message.includes(password), false);
  assert.equal(error.message.includes(badUrl), false);
});

test('seeded random operations keep connection and transaction invariants', async () => {
  const rng = new Lcg(20240517);

  for (let run = 0; run < 100; run += 1) {
    const pool = new FakePool();
    const port = createPgSqlPort(pool);
    let errorsWithoutCode = 0;
    const tasks: Array<Promise<void>> = [];
    const operationCount = 3 + rng.nextInt(5);

    for (let op = 0; op < operationCount; op += 1) {
      const isTransaction = rng.nextInt(2) === 1;

      if (!isTransaction) {
        const text = `plain-${run}-${op}`;
        if (rng.nextInt(3) === 0) {
          pool.failOn(text, randomError(rng, `${run}-${op}`));
        }
        tasks.push(
          port.query(text).then(
            () => undefined,
            (error: unknown) => {
              if (!hasStringCode(error)) {
                errorsWithoutCode += 1;
              }
            }
          )
        );
      } else {
        const workCount = 1 + rng.nextInt(3);
        const texts: string[] = [];
        for (let index = 0; index < workCount; index += 1) {
          texts.push(`tx-${run}-${op}-${index}`);
        }

        const failIndex = rng.nextInt(workCount + 1);
        if (failIndex < workCount) {
          const failingText = texts[failIndex];
          if (failingText !== undefined) {
            pool.failOn(
              failingText,
              randomError(rng, `${run}-${op}-${failIndex}`)
            );
          }
        }

        tasks.push(
          port
            .transaction(async (tx) => {
              for (const text of texts) {
                await tx.query(text);
              }
              return op;
            })
            .then(
              () => undefined,
              (error: unknown) => {
                if (!hasStringCode(error)) {
                  errorsWithoutCode += 1;
                }
              }
            )
        );
      }
    }

    await Promise.all(tasks);
    await port.close();

    assert.equal(pool.maxConcurrent, 1);
    assert.ok(
      pool.connectCalls <= errorsWithoutCode + 1,
      `run ${run}: connects ${pool.connectCalls} > errorsWithoutCode ${errorsWithoutCode} + 1`
    );
    assertTransactionLog(pool.log);
  }
});