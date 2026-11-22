interface GenesisFilePort {
  readText(path: string): string;
}

const POLICY_PATH = /^policies\/([a-f0-9]{64})\.json$/;
const MAX_MANIFEST_BYTES = 49_152;
const MAX_DOCUMENT_BYTES = 32_768;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSafeDocument(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeDocument(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error('Unsafe policy document key');
    assertSafeDocument(child);
  }
}

/**
 * Exposes immutable policy documents from SKILLX_POLICY_DOCUMENTS_JSON through
 * the same hash-addressed file port used by the filesystem relay.
 *
 * Manifest format: { "<policyParamsHash>": <PolicyParams>, ... }
 */
export function createPolicyDocumentFiles(
  genesisText: string,
  manifestText: string | undefined,
): GenesisFilePort {
  const source = manifestText?.trim() || '{}';
  if (new TextEncoder().encode(source).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('Policy document manifest exceeds size limit');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('Invalid policy document manifest JSON');
  }
  if (!isRecord(parsed)) throw new Error('Policy document manifest must be an object');

  const documents = new Map<string, string>();
  for (const [hash, document] of Object.entries(parsed)) {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error('Invalid policy document manifest hash');
    }
    assertSafeDocument(document);
    if (!isRecord(document)) throw new Error('Policy document must be an object');
    const serialized = JSON.stringify(document);
    if (new TextEncoder().encode(serialized).byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error('Policy document exceeds size limit');
    }
    documents.set(hash, serialized);
  }

  return {
    readText(path: string): string {
      if (path === 'SKILLX_GENESIS_JSON') return genesisText;
      const match = POLICY_PATH.exec(path);
      if (match === null) throw new Error('Unknown relay configuration file');
      const hash = match[1];
      if (hash === undefined) throw new Error('Invalid policy document path');
      const content = documents.get(hash);
      if (content === undefined) throw new Error('Policy document not configured');
      return content;
    },
  };
}





