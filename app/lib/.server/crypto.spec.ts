import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_KEY_VERSION, decryptSecret, encryptSecret, keyHint } from './crypto';

/*
 * `randomBytes(...).toString('base64')` does not typecheck here: the root
 * tsconfig has no Node types, so Buffer resolves to the browser shim whose
 * toString() takes no arguments. Going through Uint8Array keeps the types honest
 * without adding @types/node just for a test.
 */
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const KEY = b64(randomBytes(32));

/*
 * Compare as hex strings: the main tsconfig has no Node Buffer types, so the
 * crypto spec stays free of Buffer instance methods.
 */
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

beforeEach(() => {
  process.env.API_KEY_ENCRYPTION_SECRET = KEY;
});

afterEach(() => {
  delete process.env.API_KEY_ENCRYPTION_SECRET;
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a key', () => {
    const value = encryptSecret('sk-test-1234567890');

    expect(decryptSecret(value)).toBe('sk-test-1234567890');
    expect(value.keyVersion).toBe(CURRENT_KEY_VERSION);
  });

  it('produces different ciphertext for the same input', () => {
    // A fresh IV per call; identical output would leak that two accounts share a key.
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');

    expect(toHex(a.ciphertext)).not.toBe(toHex(b.ciphertext));
    expect(toHex(a.iv)).not.toBe(toHex(b.iv));
  });

  it('does not leave the plaintext in the ciphertext', () => {
    const value = encryptSecret('sk-super-secret-value');

    // Hex, not utf8: the tsconfig resolves Buffer to the browser shim.
    expect(toHex(value.ciphertext)).not.toContain('736563726574');
  });

  it('refuses a tampered ciphertext or auth tag', () => {
    const value = encryptSecret('sk-test-1234567890');

    const flipped = Buffer.from(value.ciphertext);

    flipped[0] ^= 0xff;

    expect(() => decryptSecret({ ...value, ciphertext: flipped })).toThrow();

    const badTag = Buffer.from(value.authTag);

    badTag[0] ^= 0xff;

    expect(() => decryptSecret({ ...value, authTag: badTag })).toThrow();
  });

  it('refuses to decrypt under a different key', () => {
    const value = encryptSecret('sk-test-1234567890');

    process.env.API_KEY_ENCRYPTION_SECRET = b64(randomBytes(32));

    expect(() => decryptSecret(value)).toThrow();
  });

  it('throws a clear error when the secret is missing or the wrong length', () => {
    delete process.env.API_KEY_ENCRYPTION_SECRET;
    expect(() => encryptSecret('x')).toThrow(/API_KEY_ENCRYPTION_SECRET is not set/);

    process.env.API_KEY_ENCRYPTION_SECRET = 'c2hvcnQ='; // "short"
    expect(() => encryptSecret('x')).toThrow(/32 bytes/);
  });

  it('accepts ciphertext produced outside this module for the same key', () => {
    /*
     * Guards against a future change to the wire format silently breaking rows
     * written today.
     */
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'base64'), iv);
    const ciphertext = Buffer.concat([cipher.update('external', 'utf8'), cipher.final()]);

    expect(decryptSecret({ ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: CURRENT_KEY_VERSION })).toBe(
      'external',
    );
  });
});

describe('keyHint', () => {
  it('shows only the last four characters', () => {
    expect(keyHint('sk-ant-api03-abcdefgh')).toBe('…efgh');
  });

  it('gives no hint for short values, which would be fully exposed', () => {
    expect(keyHint('short')).toBeNull();
    expect(keyHint('1234567')).toBeNull();
  });
});
