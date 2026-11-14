import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, eventHash, sha256Hex } from '../../crypto/src/index.js';
import { RelayRig } from '../../testing/src/relay-fixtures.js';
import type { SupabaseRpcPort } from '../../relay/src/supabase-ledger-store.js';
import { SupabaseLedgerStore } from '../../relay/src/supabase-ledger-store.js';
import type { LedgerEntry } from '../../relay/src/store.js';

interface Row {
  sequence: number;
  checksum: string;
  entry_json: string;
}

class FakeRpc implements SupabaseRpcPort {
  rows: Row[] = [];

  async rpc<T = unknown>(
    functionName: string,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    if (functionName === 'skillx_runtime_ledger_load') {
      return this.rows.map((row) => ({ ...row })) as T;
    }
    if (functionName !== 'skillx_runtime_ledger_append') {
      throw new Error('unexpected RPC function');
    }

    const sequence = args['p_sequence'];
    const eventHashHex = args['p_event_hash'];
    const signer = args['p_signer'];
    const prevHash = args['p_prev_hash'];
    const checksum = args['p_checksum'];
    const entryJson = args['p_entry_json'];

    assert.equal(typeof sequence, 'number');
    assert.equal(sequence, this.rows.length + 1);
    assert.equal(typeof eventHashHex, 'string');
    assert.equal(typeof signer, 'string');
    assert.equal(prevHash === null || typeof prevHash === 'string', true);
    assert.equal(typeof checksum, 'string');
    assert.equal(typeof entryJson, 'string');

    const parsed = JSON.parse(entryJson as string) as LedgerEntry;
    assert.equal(canonical(parsed), entryJson);
    assert.equal(eventHash(parsed.event), eventHashHex);

    const currentSignerTip = this.rows
      .map((row) => JSON.parse(row.entry_json) as LedgerEntry)
      .filter((entry) => entry.event.signer === signer)
      .at(-1);
    assert.equal(
      parsed.event.prevHash ?? null,
      currentSignerTip === undefined ? null : eventHash(currentSignerTip.event),
    );
    assert.equal(sha256Hex(entryJson as string), checksum);

    this.rows.push({
      sequence: sequence as number,
      checksum: checksum as string,
      entry_json: entryJson as string,
    });
    return undefined as T;
  }
}

function validEntries(): LedgerEntry[] {
  const rig = new RelayRig();
  rig.bootstrap();
  rig.openDeal(1);
  return rig.store.all();
}

test('Supabase ledger store persists and reloads verified canonical entries', async () => {
  const entries = validEntries();
  const rpc = new FakeRpc();
  const store = new SupabaseLedgerStore(rpc);

  await store.open();
  assert.equal(store.tipSequence(), 0);

  for (const entry of entries) await store.append(entry);
  assert.equal(store.tipSequence(), entries.length);
  assert.equal(rpc.rows.length, entries.length);
  await store.close();

  const reopened = new SupabaseLedgerStore(rpc);
  await reopened.open();
  assert.deepEqual(
    reopened.all().map((entry) => eventHash(entry.event)),
    entries.map((entry) => eventHash(entry.event)),
  );
  assert.equal(reopened.tipSequence(), entries.length);
  await reopened.close();
});

test('Supabase ledger store rejects a corrupted persisted checksum', async () => {
  const entries = validEntries();
  const rpc = new FakeRpc();
  const seeded = new SupabaseLedgerStore(rpc);
  await seeded.open();
  await seeded.append(entries[0]!);
  await seeded.close();

  rpc.rows[0]!.checksum = '0'.repeat(64);
  const reopened = new SupabaseLedgerStore(rpc);
  await assert.rejects(() => reopened.open(), /checksum mismatch/);
});

test('stale serverless instances cannot append competing sequence numbers', async () => {
  const firstEntry = validEntries()[0]!;
  const secondEntry = validEntries()[0]!;
  const rpc = new FakeRpc();
  const instanceA = new SupabaseLedgerStore(rpc);
  const instanceB = new SupabaseLedgerStore(rpc);

  await instanceA.open();
  await instanceB.open();

  await instanceA.append(firstEntry);
  await assert.rejects(
    () => instanceB.append(secondEntry),
    /Supabase rejected or could not confirm/,
  );
  assert.equal(rpc.rows.length, 1);
  assert.equal(instanceB.tipSequence(), 0);

  await instanceA.close();
  await instanceB.close();
});
