import { describe, expect, it } from "vitest";
import { getR2Config } from "../../packages/domain/media/storage/r2-config";
import { keyFromOwnedUrl } from "../../packages/domain/media/storage/r2-media-storage";

const VALID_ENV = {
  R2_ACCOUNT_ID: "test-account-id",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET_NAME: "tablecore-production-media",
  R2_PUBLIC_BASE_URL: "https://media.tablecore.net",
};

describe("getR2Config — fails safely, never leaks secrets, never at import time", () => {
  it("resolves a complete, normalized config when every variable is set", () => {
    const config = getR2Config(VALID_ENV);
    expect(config.accountId).toBe("test-account-id");
    expect(config.bucketName).toBe("tablecore-production-media");
    expect(config.publicBaseUrl).toBe("https://media.tablecore.net"); // no trailing slash
    expect(config.endpoint).toBe("https://test-account-id.r2.cloudflarestorage.com"); // derived, never hardcoded
  });

  it("normalizes away a trailing slash on R2_PUBLIC_BASE_URL", () => {
    const config = getR2Config({ ...VALID_ENV, R2_PUBLIC_BASE_URL: "https://media.tablecore.net/" });
    expect(config.publicBaseUrl).toBe("https://media.tablecore.net");
  });

  it("throws naming exactly which variables are missing, and the error never contains any configured secret value", () => {
    const env = { ...VALID_ENV, R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" };
    let message = "";
    try {
      getR2Config(env);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("R2_ACCESS_KEY_ID");
    expect(message).toContain("R2_SECRET_ACCESS_KEY");
    expect(message).not.toContain(VALID_ENV.R2_ACCESS_KEY_ID);
    expect(message).not.toContain(VALID_ENV.R2_SECRET_ACCESS_KEY);
  });

  it("throws when every variable is missing (fresh/misconfigured environment)", () => {
    expect(() => getR2Config({})).toThrow(/R2_ACCOUNT_ID/);
  });

  it("rejects a malformed R2_PUBLIC_BASE_URL", () => {
    expect(() => getR2Config({ ...VALID_ENV, R2_PUBLIC_BASE_URL: "not a url" })).toThrow(/URL/);
  });

  it("requires https in production", () => {
    expect(() => getR2Config({ ...VALID_ENV, R2_PUBLIC_BASE_URL: "http://media.tablecore.net", NODE_ENV: "production" })).toThrow(/https/);
  });
});

describe("keyFromOwnedUrl — the gate that makes 'never delete an arbitrary URL' enforceable", () => {
  const base = "https://media.tablecore.net";

  it("extracts the key for a URL genuinely issued under our own public base URL", () => {
    expect(keyFromOwnedUrl(`${base}/restaurants/r1/menu-items/i1/abc-123.webp`, base)).toBe("restaurants/r1/menu-items/i1/abc-123.webp");
  });

  it("returns null for a legacy Vercel Blob URL (pre-migration data) — never attempts to delete it", () => {
    expect(keyFromOwnedUrl("https://abc123.public.blob.vercel-storage.com/restaurants/r1/photo-xyz.webp", base)).toBeNull();
  });

  it("returns null for an arbitrary external URL", () => {
    expect(keyFromOwnedUrl("https://evil.example.com/restaurants/r1/menu-items/i1/x.webp", base)).toBeNull();
  });

  it("returns null for a URL that merely starts similarly but isn't actually under our base (prefix confusion)", () => {
    expect(keyFromOwnedUrl("https://media.tablecore.net.evil.com/x.webp", base)).toBeNull();
  });

  it("returns null for the base URL with nothing after it", () => {
    expect(keyFromOwnedUrl(`${base}/`, base)).toBeNull();
    expect(keyFromOwnedUrl(base, base)).toBeNull();
  });
});
