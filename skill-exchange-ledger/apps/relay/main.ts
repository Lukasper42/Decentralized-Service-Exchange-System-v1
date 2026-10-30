// apps/relay/main.ts
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { systemClock } from '../node-ports/index.js';
import { createPgSqlPort, pgConnectionOptions } from '../node-ports/pg-sql-port.js';
import type { PgPoolLike } from '../node-ports/pg-sql-port.js';
import {
  MemoryStore,
  PostgresStore,
  Projector,
  Relay,
  createRelayServer,
} from '../../packages/relay/src/index.js';
import type { HttpPolicy, RelayPolicy } from '../../packages/relay/src/index.js';
import { httpReportDelivery } from '../../packages/relay/src/report-delivery.js';
import { NdjsonReportOutbox, ReportReceiver, parseListenerAllowlist } from '../../packages/relay/src/report-receiver.js';
import { loadGenesis } from './genesis.js';
import { loadRelayKeySource } from './key-file.js';

export interface RelayConfig {
  port: number;
  host: string;
  mode: 'memory' | 'postgres';
  genesisFile: string;
  genesisSha256: string;
  policyDirectory: string | null;
  relayKeyFile: string;
  maxBodyBytes: number;
  maxEventBytes: number;
  checkpointEvery: number;
  ratePerIp: number;
  ratePerKey: number;
  rateWindowMs: number;
  maxPage: number;
  allowedOrigin: string | null;
  trustedProxies: string[];
  /** Off-ledger circular-trading report receiver (POST /v1/reports); null = disabled, the route answers 404. */
  reports: { allowlistFile: string; outboxFile: string; deliveryUrl: string | null } | null;
}

function readRequired(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return raw.trim();
}

function readOptional(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  const raw = env[name];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function readPositiveInt(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  defaultValue: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function readConfig(env: Readonly<Record<string, string | undefined>>): RelayConfig {
  const port = readPositiveInt(env, 'PORT', 3000);
  if (port > 65535) {
    throw new Error('PORT must be a positive integer between 1 and 65535');
  }

  const hostRaw = env['HOST'];
  const host = hostRaw === undefined || hostRaw.trim() === '' ? '127.0.0.1' : hostRaw.trim();

  const modeRaw = env['RELAY_MODE'];
  const modeValue = modeRaw === undefined || modeRaw.trim() === '' ? 'memory' : modeRaw.trim();
  let mode: 'memory' | 'postgres';
  if (modeValue === 'memory' || modeValue === 'postgres') {
    mode = modeValue;
  } else {
    throw new Error('RELAY_MODE must be memory or postgres');
  }

  const genesisFile = readRequired(env, 'GENESIS_FILE');
  const genesisSha256 = readRequired(env, 'GENESIS_SHA256');
  const policyDirectory = readOptional(env, 'POLICY_DIR');
  const relayKeyFile = readRequired(env, 'RELAY_KEY_FILE');

  const maxBodyBytes = readPositiveInt(env, 'MAX_BODY_BYTES', 65536);
  const maxEventBytes = readPositiveInt(env, 'MAX_EVENT_BYTES', 4096);
  const checkpointEvery = readPositiveInt(env, 'CHECKPOINT_EVERY', 100);
  const ratePerIp = readPositiveInt(env, 'RATE_PER_IP', 120);
  const ratePerKey = readPositiveInt(env, 'RATE_PER_KEY', 60);
  const rateWindowMs = readPositiveInt(env, 'RATE_WINDOW_MS', 60000);
  const maxPage = readPositiveInt(env, 'MAX_PAGE', 500);
  const allowedOrigin = readOptional(env, 'ALLOWED_ORIGIN');
  const trustedProxies = (readOptional(env, 'TRUSTED_PROXIES') ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);

  const allowlistFile = readOptional(env, 'LISTENER_ALLOWLIST_FILE');
  const outboxFile = readOptional(env, 'REPORT_OUTBOX_FILE');
  const deliveryUrl = readOptional(env, 'REPORT_DELIVERY_URL');
  if ((allowlistFile === null) !== (outboxFile === null)) {
    throw new Error('LISTENER_ALLOWLIST_FILE and REPORT_OUTBOX_FILE must be set together');
  }
  if (deliveryUrl !== null) {
    if (allowlistFile === null) {
      throw new Error('REPORT_DELIVERY_URL requires LISTENER_ALLOWLIST_FILE and REPORT_OUTBOX_FILE');
    }
    let protocol: string;
    try { protocol = new URL(deliveryUrl).protocol; } catch { throw new Error('REPORT_DELIVERY_URL must be an http(s) URL'); }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error('REPORT_DELIVERY_URL must be an http(s) URL');
    }
  }
  const reports = allowlistFile !== null && outboxFile !== null ? { allowlistFile, outboxFile, deliveryUrl } : null;

  return {
    port,
    host,
    mode,
    genesisFile,
    genesisSha256,
    policyDirectory,
    relayKeyFile,
    maxBodyBytes,
    maxEventBytes,
    checkpointEvery,
    ratePerIp,
    ratePerKey,
    rateWindowMs,
    maxPage,
    allowedOrigin,
    trustedProxies,
    reports,
  };
}

type PgConnectionOptions = ReturnType<typeof pgConnectionOptions>;
type PgPoolConstructor = new (options: PgConnectionOptions) => PgPoolLike;

function getPgPoolCtor(mod: unknown): PgPoolConstructor {
  if (typeof mod !== 'object' || mod === null) {
    throw new Error('pg is not installed');
  }
  const candidate = (mod as { Pool?: unknown }).Pool;
  if (typeof candidate !== 'function') {
    throw new Error('pg is not installed');
  }
  return candidate as PgPoolConstructor;
}

async function main(): Promise<void> {
  const config = readConfig(process.env);

  const projectorConfig = loadGenesis({
    path: config.genesisFile,
    expectedSha256: config.genesisSha256,
    files: {
      readText(path: string): string {
        return readFileSync(path, 'utf8');
      },
    },
    policyDirectory: config.policyDirectory,
  });

  const keySource = loadRelayKeySource({
    path: config.relayKeyFile,
    files: {
      statMode(path: string): number {
        return statSync(path).mode & 0o777;
      },
      readText(path: string): string {
        return readFileSync(path, 'utf8');
      },
    },
    expectedKeyId: projectorConfig.genesisRelayKey.keyId,
    expectedPublicKey: projectorConfig.genesisRelayKey.pubkey,
    platform: process.platform,
  });

  let sql: ReturnType<typeof createPgSqlPort> | null = null;
  let store: MemoryStore | PostgresStore;
  if (config.mode === 'memory') {
    store = new MemoryStore();
  } else {
    const pgModuleName = 'pg';
    const mod: unknown = await import(pgModuleName);
    const PoolCtor = getPgPoolCtor(mod);
    const pool = new PoolCtor(pgConnectionOptions(process.env));
    sql = createPgSqlPort(pool);
    store = new PostgresStore({ sql });
  }

  const relayPolicy: RelayPolicy = {
    maxEventBytes: config.maxEventBytes,
    checkpointEvery: config.checkpointEvery,
  };

  const httpPolicy: HttpPolicy = {
    maxBodyBytes: config.maxBodyBytes,
    perIpLimit: config.ratePerIp,
    perKeyLimit: config.ratePerKey,
    windowMs: config.rateWindowMs,
    maxPage: config.maxPage,
    allowedOrigin: config.allowedOrigin,
    trustedProxies: config.trustedProxies,
  };

  const log = (
    event: string,
    fields: Record<string, string | number | boolean | null>,
  ): void => {
    process.stdout.write(JSON.stringify({ event, ...fields }) + '\n');
  };

  let relay: Relay;
  try {
    relay = new Relay({
      store,
      keys: keySource,
      clock: systemClock,
      projector: new Projector(projectorConfig),
      policy: relayPolicy,
      log,
    });
  } catch (error) {
    if (sql !== null) {
      try {
        await sql.close();
      } catch {
        /* ignore cleanup failure */
      }
    }
    throw error;
  }

  const closeResources = async (): Promise<void> => {
    try {
      await relay.closeAsync();
    } catch {
      /* ignore cleanup failure */
    }
    if (sql !== null) {
      try {
        await sql.close();
      } catch {
        /* ignore cleanup failure */
      }
    }
  };

  try {
    const startResult = await relay.startAsync();
    if (!startResult.ok) {
      process.stderr.write(
        `relay failed to start: ${startResult.error.code} ${startResult.error.message}\n`,
      );
      process.exitCode = 1;
      await closeResources();
      return;
    }

    let reportReceiver: ReportReceiver | undefined;
    let reportOutbox: NdjsonReportOutbox | undefined;
    if (config.reports !== null) {
      const allowlist = parseListenerAllowlist(readFileSync(config.reports.allowlistFile, 'utf8'));
      reportOutbox = new NdjsonReportOutbox({
        path: config.reports.outboxFile,
        clock: systemClock,
        ...(config.reports.deliveryUrl === null ? {} : { deliver: httpReportDelivery(config.reports.deliveryUrl) }),
        onExhausted: (report) => { log('reports.delivery_exhausted', { finding_id: report.finding_id }); },
      });
      reportReceiver = new ReportReceiver({ allowlist, outbox: reportOutbox, knownFindingIds: await reportOutbox.loadFindingIds() });
      log('reports.enabled', { listeners: allowlist.length, delivery: config.reports.deliveryUrl !== null });
    }

    const server = createRelayServer(relay, systemClock, httpPolicy, reportReceiver);
    const actualPort = await server.listen(config.port, config.host);
    log('relay.listening', { port: actualPort, host: config.host });
    if (reportOutbox !== undefined) {
      void reportOutbox.replayPending().then((count) => { log('reports.replayed', { pending: count }); }, () => { log('reports.replay_failed', {}); });
    }

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) {
        process.exit(1);
      }
      shuttingDown = true;
      log('relay.shutdown', { signal });
      try {
        await server.shutdown();
      } catch {
        /* ignore shutdown failure */
      }
      await closeResources();
      process.exitCode = 0;
    };

    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
  } catch (error) {
    await closeResources();
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`fatal: ${message}\n`);
    process.exitCode = 1;
  });
}