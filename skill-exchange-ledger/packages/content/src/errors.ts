export const CONTENT_ERROR_CODES = [
  'UNAVAILABLE', 'CORRUPT', 'OVERSIZE', 'BAD_HASH', 'REVEAL_WINDOW', 'COMMITMENT_MISMATCH', 'BAD_SALT', 'RETENTION',
  'ENVELOPE_FORMAT', 'DECRYPT_FAILED', 'BAD_INPUT',
] as const;
export type ContentErrorCode = typeof CONTENT_ERROR_CODES[number];

/** Stable, non-secret errors. `UNAVAILABLE` (deleted or never stored) is always distinct from `CORRUPT` (bytes do not match their hash). */
export class ContentError extends Error {
  readonly code: ContentErrorCode;
  constructor(code: ContentErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'ContentError';
    this.code = code;
  }
}
