/**
 * AES-256-GCM šifrovanje/dešifrovanje PIN-a za admin otkrivanje.
 *
 * Ključ se nikad ne čuva u bazi — dolazi isključivo iz PIN_ENCRYPTION_KEY env
 * promenljive (64 hex karaktera = 32 bajta). Bez postavljenog ključa encrypt
 * vraca null (feature nije dostupan), a decrypt baca grešku.
 *
 * Format storage stringa: "ivHex:authTagHex:ciphertextHex"
 * Svaki poziv encryptPin generiše nov nasumičan IV — isti PIN nikad ne
 * proizvodi isti šifrovan string (analogno soljenom hešu, ali reverzibilno).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";

function getPinEncryptionKey(): Buffer | null {
  const hex = process.env.PIN_ENCRYPTION_KEY;
  if (!hex) return null;
  if (hex.length !== 64) {
    throw new Error("PIN_ENCRYPTION_KEY mora biti 64-karakter hex string (32 bajta)");
  }
  return Buffer.from(hex, "hex");
}

export function encryptPin(pin: string): string | null {
  const key = getPinEncryptionKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

export function decryptPin(stored: string): string {
  const key = getPinEncryptionKey();
  if (!key) {
    throw new Error("PIN_ENCRYPTION_KEY nije konfigurisan — otkrivanje PIN-a nije dostupno");
  }
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("Neispravan format šifrovanog PIN-a");
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
