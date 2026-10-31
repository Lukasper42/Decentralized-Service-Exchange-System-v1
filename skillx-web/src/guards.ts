export type Guard<T> = (value: unknown, path: string) => T;

export class GuardError extends Error {
  readonly code: string;
  readonly gpath: string;

  constructor(code: string, message: string, path: string) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
    this.gpath = path;
  }
}

export function fail(code: string, message: string, path: string): never {
  throw new GuardError(code, message, path);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(obj, key);
}

export function guardString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail('FIELD_FORMAT', 'Zeichenkette erwartet', path);
  }
  return value;
}

export function guardSafeInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail('FIELD_FORMAT', 'Sichere Ganzzahl erwartet', path);
  }
  return value;
}

export function guardPositiveInt(value: unknown, path: string): number {
  const n = guardSafeInt(value, path);
  if (n < 0) {
    fail('FIELD_FORMAT', 'Nicht-negative Ganzzahl erwartet', path);
  }
  return n;
}

export const AMOUNT_MIN = 2;
export const AMOUNT_MAX = Math.floor(Number.MAX_SAFE_INTEGER / 10000);

export function guardAmount(value: unknown, path: string): number {
  const n = guardSafeInt(value, path);
  if (n < AMOUNT_MIN || n > AMOUNT_MAX) {
    fail('AMOUNT', 'Betrag außerhalb von AMOUNT_MIN..AMOUNT_MAX', path);
  }
  return n;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function guardHash(value: unknown, path: string): string {
  const s = guardString(value, path);
  if (!HEX64.test(s)) {
    fail('FIELD_FORMAT', '64-stelliges lowercase Hex erwartet', path);
  }
  return s;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function guardIso(value: unknown, path: string): string {
  const s = guardString(value, path);
  if (!ISO_RE.test(s)) {
    fail('TIMESTAMP', 'Format YYYY-MM-DDTHH:mm:ss.sssZ erwartet', path);
  }
  return s;
}

export function guardNullable<T>(
  value: unknown,
  path: string,
  inner: Guard<T>,
): T | null {
  if (value === null) {
    return null;
  }
  return inner(value, path);
}

export function guardArray<T>(
  value: unknown,
  path: string,
  inner: Guard<T>,
): T[] {
  if (!Array.isArray(value)) {
    fail('FIELD_FORMAT', 'Array erwartet', path);
  }
  const out: T[] = [];
  for (let i = 0; i < value.length; i++) {
    out.push(inner(value[i] as unknown, `${path}[${i}]`));
  }
  return out;
}

export function guardLiteral<L extends string>(
  value: unknown,
  path: string,
  allowed: readonly L[],
): L {
  const s = guardString(value, path);
  for (const a of allowed) {
    if (s === a) {
      return a;
    }
  }
  fail('FIELD_FORMAT', `Einer von: ${allowed.join(', ')}`, path);
}

export function field<T>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  guard: Guard<T>,
): T {
  if (!hasOwn(obj, key)) {
    fail('MISSING_FIELD', `Feld "${key}" fehlt`, `${path}.${key}`);
  }
  return guard(obj[key], `${path}.${key}`);
}

export function optField<T>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  guard: Guard<T>,
): T | undefined {
  if (!hasOwn(obj, key)) {
    return undefined;
  }
  const v = obj[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  return guard(v, `${path}.${key}`);
}

export function payloadRecord(
  obj: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  return field(obj, 'payload', path, (v, p) => {
    if (!isRecord(v)) {
      fail('PAYLOAD', 'Payload muss ein Objekt sein', p);
    }
    return v;
  });
}
