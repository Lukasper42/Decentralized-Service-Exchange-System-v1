import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T0, iso, newIdentity } from '../../testing/src/fixtures.js';
import { deterministicEntropy, fixedClock, testWordlist } from '../../testing/src/keystore-fixtures.js';
import { Keystore } from './keystore.js';
import { RecoveryFlow } from './recovery.js';
import { KEYSTORE_ERROR_CODES, KeystoreError } from './errors.js';
import { generateSeedPhrase } from './bip39.js';

const PASS = 'a very secret passphrase';

test('no failure message, error object or result contains a passphrase, a word, a seed or a key', async () => {
  const entropy = deterministicEntropy('leak');
  const { mnemonic, seed } = generateSeedPhrase(entropy, testWordlist());
  const { keystore, file } = await Keystore.create({ seed, passphrase: PASS, entropy, clock: fixedClock(T0), kdf: { N: 1024 }, policy: { confirm: () => false } });
  const secrets = [PASS, seed.toString('hex'), seed.toString('base64'), ...new Set(mnemonic.split(' '))];
  const collected: string[] = [];
  const note = (value: unknown): void => { collected.push(JSON.stringify(value) ?? String(value)); };

  note(await Keystore.open({ file, passphrase: `${PASS} wrong` }));
  note(await Keystore.open({ file: file.replace('"version":1', '"version":9'), passphrase: PASS }));
  note(await Keystore.open({ file: 'garbage', passphrase: PASS }));
  const me = keystore.identity.accountPublicKey;
  note(await keystore.signEvent({ type: 'EscrowFunded', version: 1, signer: me, timestamp: iso(T0), prevHash: null, payload: {} }));
  note(await keystore.signEvent({ type: 'Nope', signer: me }));
  note(await keystore.signEvent({ type: 'DealAccepted', signer: newIdentity().publicKey }));
  note(await keystore.signAttestation('precheck\n', {}));
  note(await keystore.signAttestation('key-rotation', {}));
  note(Keystore.fromMnemonic({ mnemonic: `${mnemonic} extra`, wordlist: testWordlist() }));
  const flow = new RecoveryFlow({ entropy: deterministicEntropy('leak-flow'), clock: fixedClock(T0), wordlist: testWordlist(), kdf: { N: 1024 } });
  note(flow.beginRecovery({ mnemonic, expectedCommitment: 'a'.repeat(64) }));
  for (const make of [
    () => Keystore.create({ seed: Buffer.alloc(10), passphrase: PASS, entropy, clock: fixedClock(T0) }),
    () => Keystore.create({ seed, passphrase: 'x', entropy, clock: fixedClock(T0) }),
    async () => flow.acknowledgeSeed(),
  ]) {
    try { await make(); } catch (error) {
      assert.ok(error instanceof KeystoreError);
      assert.ok(KEYSTORE_ERROR_CODES.includes(error.code));
      collected.push(error.message, (error.stack ?? '').split('\n')[0] ?? '');
    }
  }
  keystore.destroy();
  assert.ok(collected.length >= 10);
  for (const text of collected) for (const secret of secrets) assert.ok(!text.includes(secret), `leaked into: ${text.slice(0, 80)}`);
});

test('the keystore object does not expose secrets through enumeration or serialization', async () => {
  const entropy = deterministicEntropy('leak2');
  const { seed } = generateSeedPhrase(entropy, testWordlist());
  const { keystore } = await Keystore.create({ seed, passphrase: PASS, entropy, clock: fixedClock(T0), kdf: { N: 1024 } });
  const dump = JSON.stringify(keystore) + Object.getOwnPropertyNames(keystore).join() + Object.getOwnPropertySymbols(keystore).length.toString();
  assert.ok(!dump.includes(seed.toString('hex')));
  assert.ok(!dump.includes(seed.toString('base64')));
  assert.equal(Object.keys(keystore).length, 0);
});
