import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
 * AES-256-GCM for provider API keys.
 *
 * The key lives in `API_KEY_ENCRYPTION_SECRET` (base64, 32 bytes) and never in
 * the database. Rotating it means bumping CURRENT_KEY_VERSION, decrypting with
 * the previous key on read and re-encrypting immediately — that is why rows carry
 * `key_version`.
 */

export const CURRENT_KEY_VERSION = 1;

function loadKey(version: number): Buffer {
  const raw = process.env.API_KEY_ENCRYPTION_SECRET;

  if (!raw) {
    throw new Error('API_KEY_ENCRYPTION_SECRET is not set');
  }

  const key = Buffer.from(raw, 'base64');

  if (key.length !== 32) {
    throw new Error(`API_KEY_ENCRYPTION_SECRET must decode to 32 bytes (got ${key.length})`);
  }

  if (version !== CURRENT_KEY_VERSION) {
    /*
     * Only one key is configured today. When rotation happens this becomes a
     * lookup by version; failing loudly is correct until then, because silently
     * returning a wrong key would corrupt every stored secret.
     */
    throw new Error(`No encryption key configured for version ${version}`);
  }

  return key;
}

export interface EncryptedValue {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export function encryptSecret(plaintext: string): EncryptedValue {
  const key = loadKey(CURRENT_KEY_VERSION);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export function decryptSecret(value: { ciphertext: Buffer; iv: Buffer; authTag: Buffer; keyVersion: number }): string {
  const key = loadKey(value.keyVersion);
  const decipher = createDecipheriv('aes-256-gcm', key, value.iv);

  decipher.setAuthTag(value.authTag);

  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Last four characters, for showing which key is stored without revealing it.
 * Anything shorter than 8 characters gets no hint at all — a 4-character key
 * would be entirely exposed by its own hint.
 */
export function keyHint(plaintext: string): string | null {
  if (plaintext.length < 8) {
    return null;
  }

  return `…${plaintext.slice(-4)}`;
}
