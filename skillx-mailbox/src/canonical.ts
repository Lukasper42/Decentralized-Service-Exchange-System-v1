export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

export function canonical(value: JsonValue): string {
  return encodeValue(value);
}

function encodeValue(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalError('NON_SAFE_INTEGER');
      }
      return String(value);
    }
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (const item of value) {
          parts.push(encodeValue(item));
        }
        return '[' + parts.join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalError('NOT_PLAIN_OBJECT');
      }
      const obj = value as JsonObject;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const item = obj[key];
        if (item === undefined) {
          throw new CanonicalError('UNDEFINED_VALUE');
        }
        parts.push(JSON.stringify(key) + ':' + encodeValue(item));
      }
      return '{' + parts.join(',') + '}';
    }
    default: {
      const neverValue: never = value;
      throw new CanonicalError('UNSUPPORTED_TYPE:' + typeof neverValue);
    }
  }
}

export function sigMsg(domain: string, body: JsonValue): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(domain + canonical(body));
}
