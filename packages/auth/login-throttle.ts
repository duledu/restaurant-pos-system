import { createHash } from "crypto";

export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MINUTES = 15;

export function loginThrottleKey(normalizedEmail: string): string {
  return createHash("sha256").update(normalizedEmail).digest("hex");
}
