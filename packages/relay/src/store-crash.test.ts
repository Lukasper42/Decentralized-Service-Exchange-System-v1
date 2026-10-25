import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, nodeFileOps } from './file-store.js';
import type { FileOps } from './file-store.js';
import { StoreError } from './store.js';
import { MemoryStore } from './memory-store.js';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import { eventHash } from '../../crypto/src/index.js';

function tempFile(): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-store-'));
  return { path: join(dir, 'ledger.ndjson'), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
/** FileOps that persist only the first `budget` bytes of the next write, then throw (a crash mid-write). */
function crashing(budget: { remaining: number }): FileOps {
  return { ...nodeFileOps, write(fd, bytes) {
    if (budget.remaining >= bytes.length) { nodeFileOps.write(fd, bytes); budget.remaining -= bytes.length; return; }
    nodeFileOps.write(fd, bytes.subarray(0, budget.remaining));
    budget.remaining = 0;
    throw new Error('simulated crash');
  } };
}
function sampleEntries(count: number): ReturnType<MemoryStore['all']> {
  const rig = new RelayRig();
  rig.bootstrap();
  for (let i = 1; rig.store.all().length < count; i += 1) rig.openDeal(i);
  return rig.store.all().slice(0, count);
}

test('crash at EVERY byte of the final record: recovery truncates the torn tail, readers never see it, the store works again', () => {
  const entries = sampleEntries(4);
  const probe = tempFile();
  const clean = new FileStore({ path: probe.path });
  clean.open();
  for (const entry of entries) clean.append(entry);
  clean.close();
  const full = readFileSync(probe.path);
  probe.dispose();
  const lastNewline = full.lastIndexOf(0x0a, full.length - 2);
  const finalLength = full.length - (lastNewline + 1);
  assert.ok(finalLength > 100);
  for (let k = 0; k < finalLength; k += 1) {
    const f = tempFile();
    try {
      const first = new FileStore({ path: f.path });
      first.open();
      for (const entry of entries.slice(0, 3)) first.append(entry);
      first.close();
      const budget = { remaining: k };
      const victim = new FileStore({ path: f.path, ops: crashing(budget) });
      victim.open();
      assert.throws(() => victim.append(entries[3] as never), StoreError);
      assert.throws(() => victim.append(entries[3] as never), /poisoned/);
      assert.equal(victim.tipSequence(), 3, 'a failed append is never visible to readers');
      victim.close();
      const reopened = new FileStore({ path: f.path });
      reopened.open();
      assert.equal(reopened.tipSequence(), 3, `k=${k}`);
      assert.equal(reopened.recoveredBytes, k);
      assert.deepEqual(reopened.all().map((e) => e.receipt.sequence), [1, 2, 3]);
      reopened.append(entries[3] as never);
      assert.equal(reopened.tipSequence(), 4);
      reopened.close();
      const again = new FileStore({ path: f.path });
      again.open();
      assert.deepEqual(again.all().map((e) => eventHash(e.event)), entries.map((e) => eventHash(e.event)));
      again.close();
    } finally { f.dispose(); }
  }
});

test('recovery stops at the first bad line: wrong checksum, altered bytes, non-contiguous sequence, garbage and a missing final newline', () => {
  const entries = sampleEntries(4);
  const mutations: Array<[string, (text: string) => string, number]> = [
    ['checksum', (t) => { const lines = t.split('\n'); lines[2] = `${'0'.repeat(64)}${(lines[2] ?? '').slice(64)}`; return lines.join('\n'); }, 2],
    ['payload byte flipped', (t) => { const lines = t.split('\n'); lines[1] = (lines[1] ?? '').replace('"type":', '"typE":'); return lines.join('\n'); }, 1],
    ['garbage line', (t) => { const lines = t.split('\n'); lines.splice(2, 0, 'not a record'); return lines.join('\n'); }, 2],
    ['missing final newline', (t) => t.slice(0, -1), 3],
    ['empty', () => '', 0],
  ];
  for (const [name, mutate, expectedTip] of mutations) {
    const f = tempFile();
    try {
      const store = new FileStore({ path: f.path });
      store.open();
      for (const entry of entries) store.append(entry);
      store.close();
      writeFileSync(f.path, mutate(readFileSync(f.path, 'utf8')));
      const reopened = new FileStore({ path: f.path });
      reopened.open();
      assert.equal(reopened.tipSequence(), expectedTip, name);
      reopened.close();
    } finally { f.dispose(); }
  }
  const skipped = tempFile();
  try {
    const store = new FileStore({ path: skipped.path });
    store.open();
    store.append(entries[0] as never);
    store.close();
    appendFileSync(skipped.path, '');
    const second = new FileStore({ path: skipped.path });
    second.open();
    assert.throws(() => second.append(entries[2] as never), /contiguous/);
    assert.throws(() => second.append(entries[0] as never), /contiguous|duplicate/);
    second.close();
  } finally { skipped.dispose(); }
});

test('both stores enforce the same contract; fsync policy "none" is accepted; a closed or double-opened store refuses', () => {
  const entries = sampleEntries(3);
  const f = tempFile();
  try {
    for (const store of [new MemoryStore(), new FileStore({ path: f.path, fsync: 'none' })]) {
      store.open();
      assert.equal(store.tipEntry(), null);
      assert.throws(() => store.append(entries[1] as never), /contiguous/);
      store.append(entries[0] as never);
      store.append(entries[1] as never);
      assert.throws(() => store.append(entries[1] as never), /contiguous|duplicate/);
      assert.equal(store.signerTip(entries[1]?.event.signer ?? ''), eventHash(entries[1]?.event as never));
      assert.equal(store.findByEventHash(eventHash(entries[0]?.event as never))?.receipt.sequence, 1);
      assert.deepEqual(store.readRange(1, 2).map((e) => e.receipt.sequence), [1, 2]);
      assert.deepEqual(store.readRange(5, 9), []);
      assert.deepEqual(store.readRange(2, 1), []);
    }
    const unopened = new FileStore({ path: join(f.path, '..', 'x.ndjson') });
    assert.throws(() => unopened.append(entries[0] as never), /not open/);
    const twice = new FileStore({ path: join(f.path, '..', 'y.ndjson') });
    twice.open();
    assert.throws(() => twice.open(), /already open/);
    twice.close();
  } finally { f.dispose(); }
});
