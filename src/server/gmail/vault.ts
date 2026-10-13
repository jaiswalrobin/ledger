import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Refresh-token envelope: [key version (1 byte)] [IV (12)] [GCM tag (16)] [ciphertext].
 * The mailbox row id is bound as additional authenticated data, so a ciphertext copied onto
 * another row fails to decrypt. Only modules under src/server/gmail may import this file;
 * tests/security.test.ts enforces that boundary.
 */
const CURRENT_VERSION = 1;
export class TokenUnreadableError extends Error {
  constructor() {
    super("TOKEN_UNREADABLE");
  }
}

export function encryptToken(
  key: Buffer,
  plaintext: string,
  aad: string,
  keyVersion = CURRENT_VERSION,
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([keyVersion]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

export function decryptToken(key: Buffer, blob: Buffer, aad: string): string {
  try {
    if (blob.length < 1 + 12 + 16 || blob[0] !== CURRENT_VERSION)
      throw new TokenUnreadableError();
    const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([
      decipher.update(blob.subarray(29)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new TokenUnreadableError();
  }
}
