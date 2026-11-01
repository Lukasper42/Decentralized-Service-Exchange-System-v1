export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Reads a response of at most `max` bytes; throws when exceeded. */
export async function readCappedText(res: Response, max: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    throw new Error('Response too large');
  }
  if (res.body === null) {
    return '';
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let received = 0;
  let out = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    received += chunk.value.byteLength;
    if (received > max) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    out += decoder.decode(chunk.value, { stream: true });
  }
  out += decoder.decode();
  return out;
}
