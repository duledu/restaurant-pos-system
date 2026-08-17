import { describe, expect, it } from "vitest";
import { loginThrottleKey, LOGIN_LOCKOUT_MINUTES, MAX_FAILED_LOGIN_ATTEMPTS } from "@rcs/auth";

describe("email login throttle", () => {
  it("uses a stable non-plaintext key", () => {
    const key = loginThrottleKey("owner@example.com");
    expect(key).toHaveLength(64);
    expect(key).not.toContain("owner@example.com");
    expect(loginThrottleKey("owner@example.com")).toBe(key);
  });

  it("has a bounded account lockout policy", () => {
    expect(MAX_FAILED_LOGIN_ATTEMPTS).toBe(5);
    expect(LOGIN_LOCKOUT_MINUTES).toBe(15);
  });
});
