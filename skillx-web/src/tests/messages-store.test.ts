import test from 'node:test';
import assert from 'node:assert/strict';
import type { CryptoPort, RandomPort, StoragePort } from '../ports.js';
import { MessagesStore } from '../messages-store.js';
import type { StoredMessage } from '../messages-store.js';

const port: CryptoPort = { subtle: globalThis.crypto.subtle };

function randomPort(seed: number): RandomPort {
  let counter = seed;
  return {
    bytes(n: number): Uint8Array {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) {
        out[i] = (counter + i) & 0xff;
      }
      counter = (counter + n) & 0xffff;
      return out;
    }
  };
}

function memoryStorage(): { storage: StoragePort; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      get(key: string): string | null {
        return map.get(key) ?? null;
      },
      set(key: string, value: string): void {
        map.set(key, value);
      },
      remove(key: string): void {
        map.delete(key);
      }
    }
  };
}

function message(
  serverId: string,
  peer: string,
  sentAt: string,
  body: string,
  direction: 'in' | 'out'
): StoredMessage {
  return { serverId, peer, direction, sentAt, body, seq: direction === 'in' ? 1 : null };
}

test('messages store deduplicates by server id and sorts by sent_at', () => {
  const { storage } = memoryStorage();
  const store = new MessagesStore(port, storage, randomPort(1));
  store.add(message('1', 'bob', '2023-11-14T22:13:21.000Z', 'later', 'in'));
  store.add(message('1', 'bob', '2023-11-14T22:13:20.000Z', 'earlier', 'in'));
  store.add(message('2', 'bob', '2023-11-14T22:13:19.000Z', 'first', 'out'));
  store.add(message('3', 'alice', '2023-11-14T22:13:22.000Z', 'other', 'in'));

  const groups = store.listByPeer();
  const bob = groups.get('bob');
  assert.ok(bob !== undefined);
  if (bob === undefined) return;
  assert.equal(bob.length, 2);
  assert.equal(bob[0]?.body, 'first');
  assert.equal(bob[1]?.body, 'earlier');
  assert.equal(groups.get('alice')?.length, 1);
});

test('messages store encrypted persistence roundtrip and wrong password', async () => {
  const { storage, map } = memoryStorage();
  const store = new MessagesStore(port, storage, randomPort(2));
  store.add(message('1', 'bob', '2023-11-14T22:13:20.000Z', 'secret body', 'in'));

  const persisted = await store.persist('correct horse');
  assert.ok(persisted.ok);
  const blob = map.get('skillx.messages.v1');
  assert.ok(blob !== undefined);
  if (blob === undefined) return;
  assert.equal(blob.includes('secret body'), false);

  store.clear();
  assert.equal(store.listByPeer().size, 0);

  const loaded = await store.load('correct horse');
  assert.ok(loaded.ok);
  if (!loaded.ok) return;
  assert.equal(loaded.value, true);
  const groups = store.listByPeer();
  assert.equal(groups.get('bob')?.[0]?.body, 'secret body');

  store.clear();
  const wrong = await store.load('wrong password');
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.error.code, 'POLICY');
  assert.equal(store.listByPeer().size, 0);
});

test('messages store clear removes plaintext from memory', () => {
  const { storage } = memoryStorage();
  const store = new MessagesStore(port, storage, randomPort(3));
  store.add(message('1', 'bob', '2023-11-14T22:13:20.000Z', 'body', 'in'));
  assert.equal(store.listByPeer().size, 1);
  store.clear();
  assert.equal(store.listByPeer().size, 0);
});
