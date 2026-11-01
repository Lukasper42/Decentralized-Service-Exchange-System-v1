import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../state.js';
import { actionsBlocked, blockedReasons } from '../views/common.js';

test('subscribeNow calls the listener immediately and on every change, subscribe only on changes', () => {
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

test('blockedReasons names every applicable block reason individually', () => {
  const ok = { unlocked: true, verifierBroken: false, readOnly: false, transportError: false };
  assert.deepEqual(blockedReasons(ok), []);
  assert.equal(actionsBlocked(ok), false);
  assert.deepEqual(blockedReasons({ ...ok, unlocked: false }), ['key locked']);
  assert.deepEqual(blockedReasons({ ...ok, verifierBroken: true }), ['chain divergence']);
  assert.deepEqual(blockedReasons({ ...ok, readOnly: true }), ['relay is read-only']);
  assert.deepEqual(blockedReasons({ ...ok, transportError: true }), ['last sync failed']);
  const all = { unlocked: false, verifierBroken: true, readOnly: true, transportError: true };
  assert.equal(blockedReasons(all).length, 4);
  assert.equal(actionsBlocked({ ...ok, transportError: true }), true);
});
