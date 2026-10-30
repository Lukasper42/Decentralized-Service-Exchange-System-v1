// Gemeinsame Pfade und Hilfen für die Rauchtests (Repo-Wurzel = zwei Ebenen über diesem Ordner).
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const L = join(root, 'skill-exchange-ledger');
export const W = join(root, 'skillx-web');
export const M = join(root, 'skillx-mailbox');
export const workdir = (name) => mkdtempSync(join(tmpdir(), `skillx-smoke-${name}-`));

export async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    try {
      return createRequire(import.meta.url)('playwright').chromium;
    } catch {
      console.error('Playwright fehlt: im Repo-Wurzelordner "npm i --no-save playwright" und "npx playwright install chromium" ausführen.');
      process.exit(2);
    }
  }
}
