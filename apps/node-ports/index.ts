/** Composition root: the only place that touches the OS entropy source and the wall clock. */
import { randomBytes } from 'node:crypto';
import type { ClockPort, EntropyPort } from '../../packages/keystore/src/ports.js';

export const nodeEntropy: EntropyPort = { bytes: (count: number): Uint8Array => randomBytes(count) };
export const systemClock: ClockPort = { nowMs: (): number => Date.now() };

/** Unique temporary file names for FsContentStore (OS entropy lives only in this composition root). */
export const nodeUniqueName = (): string => randomBytes(12).toString('hex');
