// apps/relay/admin-cli.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createIdentity } from '../../packages/crypto/src/index.js';
import {
  buildGenesis,
  describeGenesis,
  generateRelayKey,
  parseGenesisConfig,
  type AdminFilePort
} from './admin.js';

export type ParsedCommand =
  | { readonly command: 'keygen'; readonly outPath: string }
  | {
      readonly command: 'genesis build';
      readonly configPath: string;
      readonly relayPublicKey: string;
      readonly outPath: string;
    }
  | { readonly command: 'genesis hash'; readonly filePath: string };

function collectFlags(
  args: readonly string[],
  allowed: readonly string[]
): Map<string, string> {
  if (args.length % 2 !== 0) {
    const last = args[args.length - 1];
    if (last !== undefined && last.startsWith('--')) {
      throw new Error(`usage: missing value for ${last}`);
    }
    throw new Error('usage: missing value');
  }

  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined) {
      throw new Error('usage: missing value');
    }
    if (!flag.startsWith('--')) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    const name = flag.slice(2);
    if (name.length === 0) {
      throw new Error('invalid flag');
    }
    if (values.has(name)) {
      throw new Error(`duplicate flag: --${name}`);
    }
    if (!allowed.includes(name)) {
      throw new Error(`unknown flag: --${name}`);
    }
    values.set(name, value);
  }
  return values;
}

function requireFlag(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined) {
    throw new Error(`usage: missing flag: --${name}`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (command === undefined) {
    throw new Error('usage: missing command');
  }

  const rest = argv.slice(1);

  if (command === 'keygen') {
    const flags = collectFlags(rest, ['out']);
    return { command: 'keygen', outPath: requireFlag(flags, 'out') };
  }

  if (command === 'genesis') {
    const subcommand = rest[0];
    if (subcommand === undefined) {
      throw new Error('usage: missing command');
    }

    const subArgs = rest.slice(1);

    if (subcommand === 'build') {
      const flags = collectFlags(subArgs, [
        'config',
        'relay-public-key',
        'out'
      ]);
      return {
        command: 'genesis build',
        configPath: requireFlag(flags, 'config'),
        relayPublicKey: requireFlag(flags, 'relay-public-key'),
        outPath: requireFlag(flags, 'out')
      };
    }

    if (subcommand === 'hash') {
      const flags = collectFlags(subArgs, ['file']);
      return {
        command: 'genesis hash',
        filePath: requireFlag(flags, 'file')
      };
    }

    throw new Error('usage: unknown command');
  }

  throw new Error('usage: unknown command');
}

const fsAdminFilePort: AdminFilePort = {
  exists(path: string): boolean {
    return existsSync(path);
  },
  writeTextExclusive(path: string, text: string, mode: number): void {
    writeFileSync(path, text, { flag: 'wx', mode });
  },
  readText(path: string): string {
    return readFileSync(path, 'utf8');
  }
};

const HELP_TEXT = [
  'Usage:',
  '  relay-admin keygen --out <file>',
  '  relay-admin genesis build --config <file> --relay-public-key <base64> --out <file>',
  '  relay-admin genesis hash --file <file>',
  ''
].join('\n');

function execute(command: ParsedCommand): void {
  switch (command.command) {
    case 'keygen': {
      const result = generateRelayKey({
        outPath: command.outPath,
        files: fsAdminFilePort,
        newIdentity: createIdentity
      });
      process.stdout.write(
        `public_key=${result.publicKey}\nkey_id=${result.keyId}\n`
      );
      process.stderr.write(
        `Private key written to ${command.outPath} (mode 0600). Keep it outside the repository.\n`
      );
      return;
    }
    case 'genesis build': {
      const configText = fsAdminFilePort.readText(command.configPath);
      const config = parseGenesisConfig(configText);
      const genesis = buildGenesis({
        config,
        relayPublicKey: command.relayPublicKey
      });
      fsAdminFilePort.writeTextExclusive(
        command.outPath,
        genesis.text,
        0o644
      );
      process.stdout.write(`GENESIS_SHA256=${genesis.sha256}\n`);
      return;
    }
    case 'genesis hash': {
      const info = describeGenesis({
        path: command.filePath,
        files: fsAdminFilePort
      });
      process.stdout.write(
        `GENESIS_SHA256=${info.sha256}\n` +
          `relay_key_id=${info.relayKeyId}\n` +
          `treasury=${info.treasury}\n` +
          `grant_count=${info.grantCount}\n` +
          `genesis_account_count=${info.genesisAccountCount}\n`
      );
      return;
    }
    default: {
      const _x: never = command;
      return _x;
    }
  }
}

function main(): void {
  try {
    const command = parseArgs(process.argv.slice(2));
    execute(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('usage:')) {
      process.stderr.write(HELP_TEXT + '\n');
      process.exitCode = 2;
    } else {
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    }
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}