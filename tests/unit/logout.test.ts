import { describe, expect, it } from "vitest";
import { POST } from "../../apps/web/app/api/auth/logout/route";

describe("logout", () => {
  it("expires the signed session cookie server-side", async () => {
    const response = await POST();
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(cookie).toContain("rcs_session=");
    expect(cookie).toMatch(/Max-Age=0/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\//i);
  });
});
