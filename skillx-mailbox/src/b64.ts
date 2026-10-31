const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function b64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function b64Decode(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string') {
    throw new Error('B64_INVALID');
  }
  if (text.length % 4 !== 0) {
    throw new Error('B64_INVALID');
  }
  if (!B64_RE.test(text)) {
    throw new Error('B64_INVALID');
  }
  const buf = Buffer.from(text, 'base64');
  if (buf.toString('base64') !== text) {
    throw new Error('B64_INVALID');
  }
  return new Uint8Array(buf);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}
