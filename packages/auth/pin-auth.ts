/**
 * PIN autentifikacija za konobare/kuhinju/šank na registrovanim uređajima.
 *
 * Pravila:
 * - PIN se NIKAD ne čuva kao plain text — samo hash (bcrypt/argon2).
 * - Nakon MAX_FAILED_ATTEMPTS pogrešnih pokušaja, nalog se zaključava na
 *   LOCKOUT_DURATION_MS.
 * - PIN prijava je dozvoljena samo sa Device koji je registrovan za taj
 *   restaurantId/locationId (device mora biti unapred registrovan od strane
 *   admina — sprečava probanje PIN-ova sa nepoznatih uređaja).
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCallback);

export const MAX_FAILED_PIN_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minuta

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(pin, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

export async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(":");
  if (!salt || !key) return false;
  const keyBuffer = Buffer.from(key, "hex");
  const derivedKey = (await scrypt(pin, salt, 64)) as Buffer;
  if (derivedKey.length !== keyBuffer.length) return false;
  return timingSafeEqual(derivedKey, keyBuffer);
}

export interface PinLoginAttemptResult {
  success: boolean;
  locked: boolean;
  remainingAttempts?: number;
}

/**
 * Poziva se iz servisnog sloja nakon što se učita Employee sa
 * failedPinAttempts/pinLockedUntil iz baze. Ova funkcija je čista logika
 * (bez DB pristupa) — DB update radi pozivalac unutar transakcije.
 */
export function evaluatePinAttempt(params: {
  isCorrect: boolean;
  currentFailedAttempts: number;
  lockedUntil: Date | null;
  now?: Date;
}): PinLoginAttemptResult & { newFailedAttempts: number; newLockedUntil: Date | null } {
  const now = params.now ?? new Date();

  if (params.lockedUntil && params.lockedUntil > now) {
    return {
      success: false,
      locked: true,
      newFailedAttempts: params.currentFailedAttempts,
      newLockedUntil: params.lockedUntil,
    };
  }

  if (params.isCorrect) {
    return {
      success: true,
      locked: false,
      newFailedAttempts: 0,
      newLockedUntil: null,
    };
  }

  const newFailedAttempts = params.currentFailedAttempts + 1;
  const shouldLock = newFailedAttempts >= MAX_FAILED_PIN_ATTEMPTS;

  return {
    success: false,
    locked: shouldLock,
    remainingAttempts: Math.max(0, MAX_FAILED_PIN_ATTEMPTS - newFailedAttempts),
    newFailedAttempts: shouldLock ? 0 : newFailedAttempts,
    newLockedUntil: shouldLock ? new Date(now.getTime() + LOCKOUT_DURATION_MS) : null,
  };
}
