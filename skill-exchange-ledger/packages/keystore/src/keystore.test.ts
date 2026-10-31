import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicEntropy, fixedClock, testWordlist } from '../../testing/src/keystore-fixtures.js';
import { Keystore, DEFAULT_KDF, KDF_BOUNDS } from './keystore.js';
import { generateSeedPhrase } from './bip39.js';

const FAST = { N: 1024 };
const PASS = 'correct horse battery';
async function fresh(label = 'ks'): Promise<{ keystore: Keystore; file: string; mnemonic: string; seed: Buffer }> {
  const entropy = deterministicEntropy(label);
  const { mnemonic, seed } = generateSeedPhrase(entropy, testWordlist());
  const created = await Keystore.create({ seed, passphrase: PASS, entropy, clock: fixedClock(1_700_000_000_000), kdf: FAST, label: 'phone' });
  return { ...created, mnemonic, seed };
}

test('create then open roundtrips: same identity, label and creation time', async () => {
  const { keystore, file } = await fresh();
  const opened = await Keystore.open({ file, passphrase: PASS });
  assert.ok(opened.ok);
  if (!opened.ok) return;
  assert.equal(opened.value.keystore.identity.accountPublicKey, keystore.identity.accountPublicKey);
  assert.equal(opened.value.keystore.identity.recoveryCommitment, keystore.identity.recoveryCommitment);
  assert.deepEqual(opened.value.meta, { createdAtMs: 1_700_000_000_000, label: 'phone' });
  assert.equal(opened.value.keystore.identity.recoveryPublicKey, null, 'a file-opened keystore never holds the recovery role');
});

test('wrong passphrase and any tampering fail with the same code and no detail', async () => {
  const { file } = await fresh();
  const wrong = await Keystore.open({ file, passphrase: 'not the passphrase' });
  assert.ok(!wrong.ok && wrong.code === 'E_DECRYPT_FAILED');
  const parsed = JSON.parse(file) as Record<string, any>;
  const flip = (text: string): string => { const b = Buffer.from(text, 'base64'); b[0] = (b[0] ?? 0) ^ 1; return b.toString('base64'); };
  const mutations: Array<(f: Record<string, any>) => void> = [
    (f) => { f.ciphertext = flip(f.ciphertext); },
    (f) => { f.cipher.tag = flip(f.cipher.tag); },
    (f) => { f.cipher.iv = flip(f.cipher.iv); },
    (f) => { f.id = 'f'.repeat(32); },
    (f) => { f.identity.accountPublicKey = flip(f.identity.accountPublicKey); },
    (f) => { f.identity.recoveryCommitment = 'a'.repeat(64); },
    (f) => { f.kdf.salt = flip(f.kdf.salt); },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(parsed);
    mutate(copy);
    const result = await Keystore.open({ file: JSON.stringify(copy), passphrase: PASS });
    assert.ok(!result.ok && result.code === 'E_DECRYPT_FAILED', JSON.stringify(result));
  }
});

test('version, format, cipher and hostile KDF parameters are rejected before any key derivation', async () => {
  const { file } = await fresh();
  const base = JSON.parse(file) as Record<string, any>;
  const code = async (mutate: (f: Record<string, any>) => void): Promise<string> => {
    const copy = structuredClone(base); mutate(copy);
    const result = await Keystore.open({ file: copy, passphrase: PASS });
    return result.ok ? 'OK' : result.code;
  };
  assert.equal(await code((f) => { f.version = 2; }), 'E_UNSUPPORTED_VERSION');
  assert.equal(await code((f) => { f.format = 'other'; }), 'E_UNSUPPORTED_VERSION');
  assert.equal(await code((f) => { f.cipher.name = 'aes-128-cbc'; }), 'E_UNSUPPORTED_VERSION');
  assert.equal(await code((f) => { f.kdf.N = 2 ** 30; }), 'E_KDF_PARAMS');
  assert.equal(await code((f) => { f.kdf.N = 1000; }), 'E_KDF_PARAMS');
  assert.equal(await code((f) => { f.kdf.r = 1000; }), 'E_KDF_PARAMS');
  assert.equal(await code((f) => { f.kdf.p = 99; }), 'E_KDF_PARAMS');
  assert.equal(await code((f) => { f.kdf.dkLen = 64; }), 'E_KDF_PARAMS');
  assert.equal(await code((f) => { f.kdf.salt = 'AAAA'; }), 'E_KDF_PARAMS');
  for (const hostile of [null, 42, [], 'not json', 'x'.repeat(70000), {}]) {
    const result = await Keystore.open({ file: hostile, passphrase: PASS });
    assert.equal(result.ok, false);
  }
  const noPass = await Keystore.open({ file, passphrase: 12345 });
  assert.ok(!noPass.ok && noPass.code === 'E_BAD_INPUT');
  assert.ok(KDF_BOUNDS.maxN >= DEFAULT_KDF.N, 'the default parameters sit inside the accepted bounds');
});

test('create refuses weak passphrases, short seeds, a missing clock and short entropy', async () => {
  const entropy = deterministicEntropy('create');
  const seed = Buffer.alloc(64, 1);
  await assert.rejects(Keystore.create({ seed, passphrase: 'short', entropy, clock: fixedClock(1), kdf: FAST }), /E_WEAK_PASSPHRASE/);
  await assert.rejects(Keystore.create({ seed: Buffer.alloc(32), passphrase: PASS, entropy, clock: fixedClock(1), kdf: FAST }), /E_BAD_INPUT/);
  await assert.rejects(Keystore.create({ seed, passphrase: PASS, entropy, clock: undefined as never, kdf: FAST }), /E_NO_PORT/);
  await assert.rejects(Keystore.create({ seed, passphrase: PASS, entropy: { bytes: () => new Uint8Array(3) }, clock: fixedClock(1), kdf: FAST }), /E_NO_PORT/);
  await assert.rejects(Keystore.create({ seed, passphrase: PASS, entropy, clock: fixedClock(1), kdf: { N: 1000 } }), /E_KDF_PARAMS/);
});

test('the file holds neither the seed, nor the mnemonic words, nor any private key bytes', async () => {
  const { file, seed, mnemonic } = await fresh('scan');
  assert.ok(!file.includes(seed.toString('hex')));
  assert.ok(!file.includes(seed.toString('base64')));
  for (const word of new Set(mnemonic.split(' '))) assert.ok(!file.toLowerCase().includes(`"${word}"`));
  assert.equal(Object.keys(JSON.parse(file) as object).sort().join(), 'cipher,ciphertext,format,id,identity,kdf,version');
});

test('destroy wipes: every later operation reports E_DESTROYED; there is no plaintext export', async () => {
  const { keystore } = await fresh('destroy');
  assert.equal(typeof (keystore as unknown as Record<string, unknown>).exportSeed, 'undefined');
  assert.equal(typeof (keystore as unknown as Record<string, unknown>).exportPrivateKey, 'undefined');
  keystore.destroy();
  const signed = await keystore.signEvent({ type: 'DealAccepted' });
  assert.ok(!signed.ok && signed.code === 'E_DESTROYED');
  const attested = await keystore.signAttestation('precheck', {});
  assert.ok(!attested.ok && attested.code === 'E_DESTROYED');
});

test('encrypted export/import: the exported text opens elsewhere, an ephemeral keystore has nothing to export', async () => {
  const { keystore, file } = await fresh('export');
  assert.equal(keystore.exportFile(), file);
  const entropy = deterministicEntropy('eph');
  const { mnemonic } = generateSeedPhrase(entropy, testWordlist());
  const eph = Keystore.fromMnemonic({ mnemonic, wordlist: testWordlist(), roles: ['recovery'] });
  assert.ok(eph.ok);
  if (eph.ok) assert.throws(() => eph.value.exportFile(), /E_STATE/);
});
