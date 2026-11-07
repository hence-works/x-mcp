import { createHash, randomBytes } from 'node:crypto';

/** Unpredictable URL-safe token (base64url of `bytes` random bytes). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export interface Pkce {
  /** 43-character code verifier (RFC 7636 section 4.1). */
  verifier: string;
  /** BASE64URL(SHA256(verifier)), sent with code_challenge_method=S256. */
  challenge: string;
}

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createPkce(): Pkce {
  const verifier = randomToken(32);
  return { verifier, challenge: s256(verifier) };
}
