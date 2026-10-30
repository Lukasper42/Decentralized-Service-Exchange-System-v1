/**
 * RFC 8032 section 5.1 pre-checks that Node/OpenSSL does not guarantee (spec section 1):
 * S < L, canonical decodable A and R, and A, R not of small order.
 * Pure BigInt twisted-Edwards arithmetic in extended coordinates; no dependencies.
 */

export const P = (1n << 255n) - 19n;
/** Order of the base-point subgroup. */
export const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function mod(a: bigint): bigint { const r = a % P; return r >= 0n ? r : r + P; }
function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}
function inv(a: bigint): bigint { return pow(a, P - 2n); }

/** Curve constant d = -121665/121666 mod p. */
export const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

export interface Point { readonly X: bigint; readonly Y: bigint; readonly Z: bigint; readonly T: bigint }
export const IDENTITY: Point = { X: 0n, Y: 1n, Z: 1n, T: 0n };

export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i] ?? 0);
  return value;
}
function bigIntToBytesLE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = 0; i < length; i += 1) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/** RFC 8032 5.1.3 decoding. Returns null for non-canonical y, no square root, or x = 0 with sign bit 1. */
export function decodePoint(bytes: Uint8Array): Point | null {
  if (bytes.length !== 32) return null;
  const last = bytes[31] ?? 0;
  const sign = last >> 7;
  const copy = Uint8Array.from(bytes);
  copy[31] = last & 0x7f;
  const y = bytesToBigIntLE(copy);
  if (y >= P) return null;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = mod(u * inv(v));
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
  if (mod(x * x - x2) !== 0n) return null;
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = mod(-x);
  return { X: x, Y: y, Z: 1n, T: mod(x * y) };
}

export function encodePoint(point: Point): Uint8Array {
  const zInv = inv(point.Z);
  const x = mod(point.X * zInv);
  const y = mod(point.Y * zInv);
  const out = bigIntToBytesLE(y, 32);
  out[31] = (out[31] ?? 0) | (Number(x & 1n) << 7);
  return out;
}

/** Unified addition (a = -1, complete because d is a non-square). */
export function add(p: Point, q: Point): Point {
  const a = mod((p.Y - p.X) * (q.Y - q.X));
  const b = mod((p.Y + p.X) * (q.Y + q.X));
  const c = mod(p.T * 2n * D * q.T);
  const d = mod(p.Z * 2n * q.Z);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return { X: mod(e * f), Y: mod(g * h), T: mod(e * h), Z: mod(f * g) };
}

export function mul(point: Point, scalar: bigint): Point {
  let result = IDENTITY;
  let addend = point;
  let k = scalar;
  while (k > 0n) {
    if ((k & 1n) === 1n) result = add(result, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return result;
}

export function isIdentity(point: Point): boolean { return mod(point.X) === 0n && mod(point.Y - point.Z) === 0n; }
export function equals(p: Point, q: Point): boolean {
  return mod(p.X * q.Z - q.X * p.Z) === 0n && mod(p.Y * q.Z - q.Y * p.Z) === 0n;
}
/** Small order means [8]P is the identity. */
export function isSmallOrder(point: Point): boolean { return isIdentity(mul(point, 8n)); }
/** True iff the affine point satisfies -x^2 + y^2 = 1 + d x^2 y^2. */
export function isOnCurve(point: Point): boolean {
  const zInv = inv(point.Z);
  const x = mod(point.X * zInv);
  const y = mod(point.Y * zInv);
  const x2 = mod(x * x);
  const y2 = mod(y * y);
  return mod(y2 - x2) === mod(1n + D * x2 * y2);
}

/** RFC 8032 base point: y = 4/5, x even. */
export const BASE_Y = mod(4n * inv(5n));
export const BASE: Point = (() => {
  const point = decodePoint(bigIntToBytesLE(BASE_Y, 32));
  if (point === null) throw new Error('Ed25519 base point failed to decode');
  return point;
})();

/**
 * Structural RFC 8032 strictness checks on a raw 32-byte public key and 64-byte signature.
 * Returns false for anything crypto.verify must not be asked about.
 */
export function strictEd25519Precheck(publicKey: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (bytesToBigIntLE(signature.subarray(32)) >= L) return false;
  const a = decodePoint(publicKey);
  const r = decodePoint(signature.subarray(0, 32));
  if (a === null || r === null) return false;
  return !isSmallOrder(a) && !isSmallOrder(r);
}
