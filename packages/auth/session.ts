/**
 * Session kao potpisan JWT u httpOnly cookie-ju — bez server-side session
 * store-a (Redis) u MVP-u. Session sadrži samo stabilne identifikatore
 * (userId/employeeId/restaurantId); role/permission se UVEK učitavaju sveže
 * iz baze na svakom zahtevu (rbac.ts requireAuth), nikad iz JWT payload-a —
 * ovo sprečava da oduzeta dozvola i dalje "važi" dok token ne istekne.
 */

import { SignJWT, jwtVerify } from "jose";

const SESSION_COOKIE_NAME = "rcs_session";
const SESSION_DURATION_SECONDS = 12 * 60 * 60; // 12h — pokriva jednu smenu

export interface SessionPayload {
  userId: string;
  employeeId: string;
  restaurantId: string;
  deviceId?: string;
}

const PLACEHOLDER_SECRETS = new Set(["change-me-in-production", "replace-with-a-long-random-secret"]);

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  const isWeak = !secret || PLACEHOLDER_SECRETS.has(secret) || secret.length < 32;
  if (isWeak && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET mora biti podešen na jaku vrednost (min. 32 karaktera) u produkciji");
  }
  return new TextEncoder().encode(secret ?? "dev-only-insecure-secret");
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (
      typeof payload.userId !== "string" ||
      typeof payload.employeeId !== "string" ||
      typeof payload.restaurantId !== "string"
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      employeeId: payload.employeeId,
      restaurantId: payload.restaurantId,
      deviceId: typeof payload.deviceId === "string" ? payload.deviceId : undefined,
    };
  } catch {
    // Istekao, nevalidan potpis, ili malformisan token — sve tretiramo kao
    // "nema sesije", ne bacamo grešku ka pozivaocu.
    return null;
  }
}

export const sessionCookieOptions = {
  name: SESSION_COOKIE_NAME,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_DURATION_SECONDS,
};
