import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const KEY_PREFIX = 'crmk_';
/** Tamanho do prefixo exibível guardado em claro (ex.: "crmk_a1b2c3d4"). */
const DISPLAY_PREFIX_LEN = KEY_PREFIX.length + 8;

export interface GeneratedApiKey {
  /** Token em claro — exibido UMA vez ao cliente, nunca persistido. */
  token: string;
  /** Prefixo exibível para identificar a chave na UI (não é segredo). */
  prefix: string;
  /** SHA-256 do token — o que vai pro banco. */
  hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const raw = randomBytes(32).toString('base64url');
  const token = `${KEY_PREFIX}${raw}`;
  return {
    token,
    prefix: token.slice(0, DISPLAY_PREFIX_LEN),
    hash: hashApiKey(token),
  };
}

export function hashApiKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Comparação de hashes em tempo constante (defesa contra timing attacks). */
export function safeHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
