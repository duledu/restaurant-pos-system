/**
 * Email + lozinka autentifikacija (admin/owner/manager nalozi).
 * PIN autentifikacija za konobare/kuhinju/šank je u pin-auth.ts — namerno
 * odvojeno jer su bezbednosni zahtevi različiti (lozinka nema lockout na
 * uređaju, ali ima globalni rate limit po nalogu — implementira se u API
 * ruti, ne ovde).
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCallback);

const MIN_PASSWORD_LENGTH = 10;

export class WeakPasswordError extends Error {
  constructor(message = `Lozinka mora imati najmanje ${MIN_PASSWORD_LENGTH} karaktera`) {
    super(message);
    this.name = "WeakPasswordError";
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError();
  }
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(":");
  if (!salt || !key) return false;
  const keyBuffer = Buffer.from(key, "hex");
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  if (derivedKey.length !== keyBuffer.length) return false;
  return timingSafeEqual(derivedKey, keyBuffer);
}
