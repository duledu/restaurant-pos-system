import { prisma } from "@rcs/db";
import { LOGIN_LOCKOUT_MINUTES, MAX_FAILED_LOGIN_ATTEMPTS } from "@rcs/auth";

interface ThrottleRow {
  failedAttempts: number;
  lockedUntil: Date | null;
}

export async function getActiveLoginThrottle(key: string): Promise<Date | null> {
  const throttle = await prisma.loginThrottle.findUnique({ where: { key } });
  return throttle?.lockedUntil && throttle.lockedUntil > new Date() ? throttle.lockedUntil : null;
}

export async function recordFailedLogin(key: string): Promise<ThrottleRow> {
  const rows = await prisma.$queryRaw<ThrottleRow[]>`
    INSERT INTO "login_throttles" ("key", "failedAttempts", "lockedUntil", "updatedAt")
    VALUES (${key}, 1, NULL, NOW())
    ON CONFLICT ("key") DO UPDATE SET
      "failedAttempts" = CASE
        WHEN "login_throttles"."lockedUntil" IS NOT NULL
          AND "login_throttles"."lockedUntil" <= NOW() THEN 1
        ELSE "login_throttles"."failedAttempts" + 1
      END,
      "lockedUntil" = CASE
        WHEN "login_throttles"."lockedUntil" > NOW() THEN "login_throttles"."lockedUntil"
        WHEN (CASE
          WHEN "login_throttles"."lockedUntil" IS NOT NULL
            AND "login_throttles"."lockedUntil" <= NOW() THEN 1
          ELSE "login_throttles"."failedAttempts" + 1
        END) >= ${MAX_FAILED_LOGIN_ATTEMPTS}
          THEN NOW() + (${LOGIN_LOCKOUT_MINUTES} * INTERVAL '1 minute')
        ELSE NULL
      END,
      "updatedAt" = NOW()
    RETURNING "failedAttempts", "lockedUntil"
  `;
  return rows[0];
}

export async function clearLoginThrottle(key: string): Promise<void> {
  await prisma.loginThrottle.deleteMany({ where: { key } });
}
