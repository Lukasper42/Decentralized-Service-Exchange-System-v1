import { createCipheriv, createDecipheriv, scrypt } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import type { Approval, EventCore, EventType, Hash, Pubkey, Sig, SignedEvent } from '../../domain/src/protocol.js';
import { EVENT_TYPES } from '../../domain/src/protocol.js';
import {
  ATTESTATION_KINDS, CanonicalError, CryptoInputError, actionHash, approvalActionFor, canonical, hashCanonical, recoveryCommitment,
  signApproval, signAttestation, signEvent,
} from '../../crypto/src/index.js';
import type { ApprovalSource, AttestationKind } from '../../crypto/src/index.js';
import { edPublicToX25519, edSeedToX25519Scalar, x25519SharedSecret } from '../../crypto/src/x25519.js';
import { KeystoreError, kerr, kok } from './errors.js';
import type { KResult } from './errors.js';
import { takeBytes, wipe } from './bytes.js';
import { keyPairFromSeed } from './keys.js';
import type { KeyPairB64 } from './keys.js';
import { PATH_ACCOUNT, PATH_RECOVERY, derivePath } from './slip10.js';
import { mnemonicToEntropy, mnemonicToSeed } from './bip39.js';
import type { Wordlist } from './bip39.js';
import type { ClockPort, ConfirmRequest, EntropyPort, SigningPolicy } from './ports.js';

export const FORMAT = 'keystore';
export const VERSION = 1;
export type Role = 'account' | 'recovery';

export interface KdfParams { name: 'scrypt'; N: number; r: number; p: number; dkLen: 32 }
export const DEFAULT_KDF: KdfParams = Object.freeze({ name: 'scrypt', N: 131072, r: 8, p: 1, dkLen: 32 });
/** Bounds enforced on every opened file so a hostile file cannot demand unbounded memory. */
export const KDF_BOUNDS = Object.freeze({ minN: 1024, maxN: 1 << 20, maxR: 16, maxP: 4 });
export const MIN_PASSPHRASE_LENGTH = 8;

/** Event types that move or lock value or change identity: a confirmation is mandatory (spec: signing policy hook). */
export const CONFIRM_REQUIRED: ReadonlySet<EventType> = new Set<EventType>(['EscrowFunded', 'EscrowReleased', 'AppealOpened', 'TreasurySpend', 'CurrencyIssued', 'KeyRotated']);
/** Which role signs which attestation kind through signAttestation. treasury-approval and checkpoint have no role here. */
const ATTESTATION_ROLE: Readonly<Record<AttestationKind, Role | null>> = {
  'deal-consent': 'account', precheck: 'account', 'jury-vote': 'account', 'key-rotation': 'recovery', 'treasury-approval': null, checkpoint: null,
};

interface KeystoreFile {
  format: string; version: number; id: string;
  kdf: KdfParams & { salt: string };
  cipher: { name: string; iv: string; tag: string };
  identity: { accountPublicKey: string; recoveryCommitment: string };
  ciphertext: string;
}

const MAGIC = Buffer.from('KSP1', 'ascii');
const HEADER = 14;
function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function isEventType(value: unknown): value is EventType {
  for (const known of EVENT_TYPES) if (value === known) return true;
  return false;
}
function isAttestationKind(value: unknown): value is AttestationKind {
  for (const known of ATTESTATION_KINDS) if (value === known) return true;
  return false;
}
function strictB64(value: unknown, length: number): Buffer | null {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value && bytes.length === length ? bytes : null;
}

function encodePlaintext(seed: Uint8Array, createdAtMs: number, label: string): Buffer {
  const labelBytes = Buffer.from(label, 'utf8');
  if (labelBytes.length > 64) throw new KeystoreError('E_BAD_INPUT', 'label exceeds 64 bytes');
  const out = Buffer.alloc(HEADER + labelBytes.length + 64);
  MAGIC.copy(out, 0);
  out.writeUInt8(1, 4);
  out.writeBigInt64BE(BigInt(createdAtMs), 5);
  out.writeUInt8(labelBytes.length, 13);
  labelBytes.copy(out, HEADER);
  Buffer.from(seed).copy(out, HEADER + labelBytes.length);
  return out;
}
function decodePlaintext(buffer: Buffer): { seed: Buffer; createdAtMs: number; label: string } | null {
  if (buffer.length < HEADER + 64 || !buffer.subarray(0, 4).equals(MAGIC) || buffer.readUInt8(4) !== 1) return null;
  const labelLength = buffer.readUInt8(13);
  if (buffer.length !== HEADER + labelLength + 64) return null;
  return {
    createdAtMs: Number(buffer.readBigInt64BE(5)), label: buffer.subarray(HEADER, HEADER + labelLength).toString('utf8'),
    seed: Buffer.from(buffer.subarray(HEADER + labelLength)),
  };
}

function headerAad(file: Omit<KeystoreFile, 'ciphertext' | 'cipher'> & { cipher: { name: string; iv: string } }): Buffer {
  return Buffer.from(canonical({ format: file.format, version: file.version, id: file.id, kdf: file.kdf, cipher: { name: file.cipher.name, iv: file.cipher.iv }, identity: file.identity }), 'utf8');
}

function checkKdf(kdf: unknown): KResult<{ params: KdfParams; salt: Buffer }> {
  if (!isObject(kdf) || kdf.name !== 'scrypt') return kerr('E_KDF_PARAMS', 'kdf name');
  const { N, r, p, dkLen } = kdf;
  if (typeof N !== 'number' || !Number.isInteger(N) || N < KDF_BOUNDS.minN || N > KDF_BOUNDS.maxN || (N & (N - 1)) !== 0) return kerr('E_KDF_PARAMS', 'N');
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > KDF_BOUNDS.maxR) return kerr('E_KDF_PARAMS', 'r');
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > KDF_BOUNDS.maxP) return kerr('E_KDF_PARAMS', 'p');
  if (dkLen !== 32) return kerr('E_KDF_PARAMS', 'dkLen');
  const salt = strictB64(kdf.salt, 32);
  if (salt === null) return kerr('E_KDF_PARAMS', 'salt');
  return kok({ params: { name: 'scrypt', N, r, p, dkLen: 32 }, salt });
}

function deriveKey(passphrase: Buffer, salt: Buffer, params: KdfParams): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r };
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, params.dkLen, options, (error, key) => { if (error !== null) reject(error); else resolve(key); });
  });
}
function passphraseBytes(passphrase: unknown): Buffer | null {
  return typeof passphrase === 'string' ? Buffer.from(passphrase.normalize('NFKD'), 'utf8') : null;
}

interface Internals { seed: Buffer; roles: ReadonlySet<Role>; file: string | null; policy: SigningPolicy }

export class Keystore {
  #seed: Buffer | null;
  readonly #roles: ReadonlySet<Role>;
  readonly #file: string | null;
  readonly #policy: SigningPolicy;
  readonly #accountPublicKey: Pubkey;
  readonly #recoveryPublicKey: Pubkey;

  private constructor(internals: Internals) {
    this.#seed = internals.seed;
    this.#roles = internals.roles;
    this.#file = internals.file;
    this.#policy = internals.policy;
    this.#accountPublicKey = Keystore.#keyFor(internals.seed, 'account').publicKey;
    this.#recoveryPublicKey = Keystore.#keyFor(internals.seed, 'recovery').publicKey;
  }

  static #keyFor(seed: Buffer, role: Role): KeyPairB64 {
    const node = derivePath(seed, role === 'account' ? PATH_ACCOUNT : PATH_RECOVERY);
    try { return keyPairFromSeed(node.key); } finally { wipe(node.key, node.chainCode); }
  }

  /** Create a new encrypted keystore from a 64-byte BIP39 seed. Programmer errors throw; the seed is copied, not kept. */
  static async create(args: { seed: Uint8Array; passphrase: string; entropy: EntropyPort; clock: ClockPort; policy?: SigningPolicy; label?: string; kdf?: Partial<KdfParams> }): Promise<{ keystore: Keystore; file: string }> {
    if (args.seed.length !== 64) throw new KeystoreError('E_BAD_INPUT', 'seed must be 64 bytes');
    if (typeof args.clock?.nowMs !== 'function') throw new KeystoreError('E_NO_PORT', 'clock port is required');
    const passBytes = passphraseBytes(args.passphrase);
    if (passBytes === null || args.passphrase.length < MIN_PASSPHRASE_LENGTH) throw new KeystoreError('E_WEAK_PASSPHRASE', `at least ${MIN_PASSPHRASE_LENGTH} characters`);
    const params: KdfParams = { ...DEFAULT_KDF, ...args.kdf };
    const salt = takeBytes(args.entropy, 32);
    const iv = takeBytes(args.entropy, 12);
    const id = takeBytes(args.entropy, 16).toString('hex');
    const checked = checkKdf({ ...params, salt: salt.toString('base64') });
    if (!checked.ok) throw new KeystoreError(checked.code, checked.message);
    const seed = Buffer.from(args.seed);
    const account = Keystore.#keyFor(seed, 'account');
    const recovery = Keystore.#keyFor(seed, 'recovery');
    let key: Buffer | null = null;
    let plaintext: Buffer | null = null;
    try {
      key = await deriveKey(passBytes, salt, params);
      const head = {
        format: FORMAT, version: VERSION, id, kdf: { ...params, salt: salt.toString('base64') }, cipher: { name: 'aes-256-gcm', iv: iv.toString('base64') },
        identity: { accountPublicKey: account.publicKey, recoveryCommitment: recoveryCommitment(recovery.publicKey) },
      };
      plaintext = encodePlaintext(seed, args.clock.nowMs(), args.label ?? '');
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(headerAad(head));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const file: KeystoreFile = { ...head, cipher: { ...head.cipher, tag: cipher.getAuthTag().toString('base64') }, ciphertext: ciphertext.toString('base64') };
      const text = JSON.stringify(file);
      return { keystore: new Keystore({ seed, roles: new Set<Role>(['account']), file: text, policy: args.policy ?? {} }), file: text };
    } finally { wipe(passBytes, key, plaintext, salt, iv); }
  }

  /** Open an encrypted file. Wrong passphrase and a tampered file are indistinguishable by design (AES-GCM). */
  static async open(args: { file: unknown; passphrase: unknown; policy?: SigningPolicy }): Promise<KResult<{ keystore: Keystore; meta: { createdAtMs: number; label: string } }>> {
    let parsed: unknown = args.file;
    if (typeof parsed === 'string') {
      if (parsed.length > 65536) return kerr('E_BAD_INPUT', 'keystore file too large');
      try { parsed = JSON.parse(parsed); } catch { return kerr('E_BAD_INPUT', 'keystore file is not JSON'); }
    }
    if (!isObject(parsed) || parsed.format !== FORMAT) return kerr('E_UNSUPPORTED_VERSION', 'not a keystore file');
    if (parsed.version !== VERSION) return kerr('E_UNSUPPORTED_VERSION', 'unsupported version');
    const kdf = checkKdf(parsed.kdf);
    if (!kdf.ok) return kdf;
    const cipherField = parsed.cipher;
    if (!isObject(cipherField) || cipherField.name !== 'aes-256-gcm') return kerr('E_UNSUPPORTED_VERSION', 'unsupported cipher');
    const iv = strictB64(cipherField.iv, 12);
    const tag = strictB64(cipherField.tag, 16);
    const identity = parsed.identity;
    if (iv === null || tag === null || typeof parsed.ciphertext !== 'string' || typeof parsed.id !== 'string' || !isObject(identity)
      || typeof identity.accountPublicKey !== 'string' || typeof identity.recoveryCommitment !== 'string') return kerr('E_DECRYPT_FAILED', 'cipher parameters');
    const passBytes = passphraseBytes(args.passphrase);
    if (passBytes === null) return kerr('E_BAD_INPUT', 'passphrase must be a string');
    let key: Buffer | null = null;
    let plaintext: Buffer | null = null;
    try {
      key = await deriveKey(passBytes, kdf.value.salt, kdf.value.params);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(headerAad({
        format: parsed.format, version: VERSION, id: parsed.id, kdf: { ...kdf.value.params, salt: kdf.value.salt.toString('base64') },
        cipher: { name: 'aes-256-gcm', iv: iv.toString('base64') }, identity: { accountPublicKey: identity.accountPublicKey, recoveryCommitment: identity.recoveryCommitment },
      }));
      decipher.setAuthTag(tag);
      try { plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, 'base64')), decipher.final()]); }
      catch { return kerr('E_DECRYPT_FAILED'); }
      const decoded = decodePlaintext(plaintext);
      if (decoded === null) return kerr('E_DECRYPT_FAILED', 'plaintext header');
      const keystore = new Keystore({ seed: decoded.seed, roles: new Set<Role>(['account']), file: JSON.stringify(parsed), policy: args.policy ?? {} });
      if (keystore.#accountPublicKey !== identity.accountPublicKey) { keystore.destroy(); return kerr('E_DECRYPT_FAILED', 'identity mismatch'); }
      return kok({ keystore, meta: { createdAtMs: decoded.createdAtMs, label: decoded.label } });
    } catch (error) {
      if (error instanceof KeystoreError) return kerr(error.code);
      throw error;
    } finally { wipe(passBytes, key, plaintext); }
  }

  /** Ephemeral keystore from a mnemonic, for recovery. It is never written to disk and can hold the recovery role. */
  static fromMnemonic(args: { mnemonic: unknown; wordlist: Wordlist; roles?: readonly Role[]; policy?: SigningPolicy }): KResult<Keystore> {
    const entropy = mnemonicToEntropy(args.mnemonic, args.wordlist);
    if (!entropy.ok) return entropy;
    wipe(entropy.value);
    const seed = mnemonicToSeed(args.mnemonic as string);
    return kok(new Keystore({ seed, roles: new Set<Role>(args.roles ?? ['recovery']), file: null, policy: args.policy ?? {} }));
  }

  get identity(): { readonly accountPublicKey: Pubkey; readonly recoveryPublicKey: Pubkey | null; readonly recoveryCommitment: Hash } {
    return Object.freeze({
      accountPublicKey: this.#accountPublicKey,
      recoveryPublicKey: this.#roles.has('recovery') ? this.#recoveryPublicKey : null,
      recoveryCommitment: recoveryCommitment(this.#recoveryPublicKey),
    });
  }
  /** Encrypted file text. There is no plaintext export function. */
  exportFile(): string {
    if (this.#file === null) throw new KeystoreError('E_STATE', 'ephemeral keystore has no file');
    return this.#file;
  }
  destroy(): void { wipe(this.#seed); this.#seed = null; }

  #key(role: Role): KResult<KeyPairB64> {
    if (this.#seed === null) return kerr('E_DESTROYED');
    if (!this.#roles.has(role)) return kerr('E_ROLE_UNAVAILABLE', role);
    return kok(Keystore.#keyFor(this.#seed, role));
  }

  async #confirm(request: ConfirmRequest): Promise<KResult<true>> {
    const confirm = this.#policy.confirm;
    if (confirm === undefined) return kerr('E_POLICY_DENIED', `confirmation required for ${request.type}`);
    let approved: boolean;
    try { approved = await confirm(Object.freeze({ ...request })); }
    catch { return kerr('E_POLICY_DENIED', `confirmation failed for ${request.type}`); }
    return approved ? kok(true) : kerr('E_POLICY_DENIED', `denied for ${request.type}`);
  }

  /**
   * X25519 shared secret with a peer's Ed25519 public key (SPKI Base64), computed inside the keystore so the account
   * seed never leaves it. The caller derives its transport key from the secret and wipes it.
   */
  sharedSecretWith(peerPublicKey: unknown): KResult<Buffer> {
    if (this.#seed === null) return kerr('E_DESTROYED');
    if (!this.#roles.has('account')) return kerr('E_ROLE_UNAVAILABLE', 'account');
    const peer = strictB64(peerPublicKey, 44);
    if (peer === null || peer.subarray(0, 12).toString('hex') !== '302a300506032b6570032100') return kerr('E_BAD_INPUT', 'peer key');
    const node = derivePath(this.#seed, PATH_ACCOUNT);
    try {
      return kok(Buffer.from(x25519SharedSecret(edSeedToX25519Scalar(node.key), edPublicToX25519(peer.subarray(12)))));
    } catch (error) {
      if (error instanceof RangeError) return kerr('E_BAD_INPUT', 'peer key is not usable');
      throw error;
    } finally { wipe(node.key, node.chainCode); }
  }

  /** Sign an event core with the account key. Refuses unknown types and any signer other than this account. */
  async signEvent(core: unknown): Promise<KResult<SignedEvent>> {
    if (this.#seed === null) return kerr('E_DESTROYED');
    if (!isObject(core)) return kerr('E_BAD_INPUT', 'event core must be a plain object');
    const type = core.type;
    if (!isEventType(type)) return kerr('E_UNKNOWN_EVENT_TYPE', typeof type === 'string' ? type.slice(0, 64) : typeof type);
    if (core.signer !== this.#accountPublicKey) return kerr('E_SIGNER_MISMATCH', 'core.signer is not this account');
    let digest: Hash;
    try { digest = hashCanonical(core); }
    catch (error) { if (error instanceof CanonicalError) return kerr('E_BAD_INPUT', 'core is not canonically representable'); throw error; }
    if (CONFIRM_REQUIRED.has(type)) {
      const confirmed = await this.#confirm({ kind: 'event', type, digest });
      if (!confirmed.ok) return confirmed;
    }
    const key = this.#key('account');
    if (!key.ok) return key;
    try { return kok(signEvent(core as unknown as EventCore, key.value.privateKey)); }
    catch (error) { if (error instanceof CryptoInputError || error instanceof CanonicalError) return kerr('E_BAD_INPUT', 'event could not be signed'); throw error; }
  }

  /** Sign a domain-separated attestation. Only kinds assigned to a role of this keystore are accepted. */
  async signAttestation(kind: unknown, body: unknown): Promise<KResult<Sig>> {
    if (this.#seed === null) return kerr('E_DESTROYED');
    if (!isAttestationKind(kind)) return kerr('E_UNKNOWN_ATTESTATION_KIND', typeof kind === 'string' ? kind.slice(0, 64) : typeof kind);
    const role = ATTESTATION_ROLE[kind];
    if (role === null) return kerr('E_UNKNOWN_ATTESTATION_KIND', `${kind} is not signable through the keystore`);
    if (kind === 'key-rotation') {
      let digest: Hash;
      try { digest = hashCanonical(body); } catch (error) { if (error instanceof CanonicalError) return kerr('E_BAD_INPUT'); throw error; }
      const confirmed = await this.#confirm({ kind: 'key-rotation', type: 'key-rotation', digest });
      if (!confirmed.ok) return confirmed;
    }
    const key = this.#key(role);
    if (!key.ok) return key;
    try { return kok(signAttestation(kind, body, key.value.privateKey)); }
    catch (error) { if (error instanceof CryptoInputError || error instanceof CanonicalError) return kerr('E_BAD_INPUT', 'attestation body is not canonically representable'); throw error; }
  }

  /** Multisig approval of a treasury/issuance/relay-key/policy action; always needs confirmation. */
  async approve(source: ApprovalSource): Promise<KResult<Approval>> {
    if (this.#seed === null) return kerr('E_DESTROYED');
    const governed: readonly string[] = ['TreasurySpend', 'CurrencyIssued', 'RelayKeyRotated', 'PolicyUpdated'];
    if (!isObject(source) || typeof source.type !== 'string' || !governed.includes(source.type) || !isObject(source.payload)) return kerr('E_BAD_INPUT', 'approval source is invalid');
    let hash: Hash;
    try { hash = actionHash(approvalActionFor(source)); }
    catch { return kerr('E_BAD_INPUT', 'approval source is invalid'); }
    const confirmed = await this.#confirm({ kind: 'approval', type: source.type, digest: hash });
    if (!confirmed.ok) return confirmed;
    const key = this.#key('account');
    if (!key.ok) return key;
    return kok(signApproval(hash, key.value.publicKey, key.value.privateKey));
  }
}
