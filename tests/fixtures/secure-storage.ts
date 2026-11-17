import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export function encryptedStorage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString(value: string) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([
        iv,
        cipher.update(value),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        value.subarray(0, 12),
      );
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([
        decipher.update(value.subarray(12, -16)),
        decipher.final(),
      ]).toString();
    },
  };
}
