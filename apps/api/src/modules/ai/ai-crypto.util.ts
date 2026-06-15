import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Cifra/decifra chaves de API de IA em repouso (AES-256-GCM).
 *
 * A chave de 32 bytes é derivada de `AI_ENCRYPTION_KEY` via SHA-256, então o
 * env pode ser qualquer segredo forte (não precisa ter exatamente 32 bytes).
 * Formato armazenado: `base64(iv):base64(authTag):base64(ciphertext)`.
 *
 * IMPORTANTE: trocar `AI_ENCRYPTION_KEY` invalida todas as chaves já cifradas
 * (precisariam ser recadastradas). Guardar o segredo junto do JWT_SECRET.
 */
const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // recomendado p/ GCM

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(plaintext: string, envKey: string | undefined): string {
  if (!envKey) {
    throw new Error('AI_ENCRYPTION_KEY ausente — não é possível cifrar a chave de IA');
  }
  const key = deriveKey(envKey);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(stored: string, envKey: string | undefined): string {
  if (!envKey) {
    throw new Error('AI_ENCRYPTION_KEY ausente — não é possível decifrar a chave de IA');
  }
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('Formato de chave cifrada inválido');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const key = deriveKey(envKey);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** Máscara p/ exibir no client (nunca retornar a chave real). Ex.: "sk-…a1b2". */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) return '••••';
  return `${plaintext.slice(0, 3)}…${plaintext.slice(-4)}`;
}
