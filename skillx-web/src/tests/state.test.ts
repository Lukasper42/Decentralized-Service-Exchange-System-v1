import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../state.js';

test('subscribeNow ruft den Listener sofort und bei jeder Änderung auf, subscribe nur bei Änderungen', () => {
  const store = new Store();
  const nowSeen: Array<number | null> = [];
  const lateSeen: Array<number | null> = [];
  const offNow = store.subscribeNow((s) => nowSeen.push(s.tipSequence));
  const offLate = store.subscribe((s) => lateSeen.push(s.tipSequence));
  assert.deepEqual(nowSeen, [null]);
  assert.deepEqual(lateSeen, []);
  store.set({ tipSequence: 3 });
  assert.deepEqual(nowSeen, [null, 3]);
  assert.deepEqual(lateSeen, [3]);
  offNow();
  offLate();
  store.set({ tipSequence: 4 });
  assert.deepEqual(nowSeen, [null, 3]);
  assert.deepEqual(lateSeen, [3]);
});
