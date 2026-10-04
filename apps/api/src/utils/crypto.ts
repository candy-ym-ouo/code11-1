import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 邀请码 / 分享 token：URL 安全、可粘贴给家人。 */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function slugify(input: string, fallback = 'family'): string {
  const ascii = input
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return ascii || fallback;
}

