import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH } from '@ce/protocol';

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 6 chars from the unambiguous alphabet, e.g. "K7Q4M2" (31^6 ≈ 887M codes). */
export function generateCode(rand: (max: number) => number = randomInt): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return s;
}

/** URL-safe random id, e.g. for pairingId (short, so the QR stays small). */
export function randomId(length = 10): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return s;
}

/** Long-lived secret (device token, poll secret). */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Constant-time string comparison; hashing first makes the lengths equal. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
