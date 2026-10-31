import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ClockPort, RandomPort, StoreFilePort } from './ports.js';
import { MailboxStore } from './store.js';
import { createMailboxServer } from './server.js';

class AtomicFilePort implements StoreFilePort {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<string | null> {
    try {
      return await readFile(this.#path, 'utf8');
    } catch (err: unknown) {
      if (isErrnoCode(err, 'ENOENT')) {
        return null;
      }
      throw err;
    }
  }

  async write(text: string): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = this.#path + '.tmp';
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.#path);
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  if (!Object.hasOwn(err, 'code')) {
    return false;
  }
  const value = (err as { code?: unknown }).code;
  return value === code;
}

async function main(): Promise<void> {
  const origin = process.env['ALLOWED_ORIGIN'];
  if (origin === undefined || origin.length === 0) {
    console.error('skillx-mailbox: ALLOWED_ORIGIN ist nicht gesetzt');
    process.exitCode = 1;
    return;
  }

  const portRaw = process.env['PORT'] ?? '8787';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('skillx-mailbox: ungültiger PORT');
    process.exitCode = 1;
    return;
  }

  const clock: ClockPort = {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };
  const random: RandomPort = {
    bytes: (n: number): Uint8Array => new Uint8Array(randomBytes(n)),
  };
  const file = new AtomicFilePort('data/mailbox.json');

  const store = await MailboxStore.load({ clock, random, file });
  const server = createMailboxServer({ store, clock, allowedOrigin: origin });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });

  console.log('skillx-mailbox: bereit auf 127.0.0.1:' + String(port));
}

main().catch(() => {
  console.error('skillx-mailbox: Start fehlgeschlagen');
  process.exitCode = 1;
});
