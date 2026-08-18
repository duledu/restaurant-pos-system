import { describe, it, expect } from "vitest";
import { looksLikeTestDatabaseName, parseDbIdentity, sameDatabase } from "../setup/db-identity";

// Pure logika iza tests/setup/require-test-database.ts (bezbednosna kapija
// koja je trebalo da postoji PRE incidenta u avgustu 2026 — integration
// testovi su TRUNCATE-ovali istu Neon bazu koju koristi razvojna
// aplikacija). Ovi testovi ne dodiruju bazu — dokazuju samo poređenje/
// prepoznavanje connection string-ova.

describe("sameDatabase", () => {
  it("prepoznaje istu bazu čak i sa različitim kredencijalima/query parametrima", () => {
    expect(
      sameDatabase(
        "postgresql://user:pass@ep-xyz-pooler.eu-central-1.aws.neon.tech/rcs_dev?pgbouncer=true&sslmode=require",
        "postgresql://otheruser:otherpass@ep-xyz-pooler.eu-central-1.aws.neon.tech/rcs_dev?sslmode=require"
      )
    ).toBe(true);
  });

  it("razlikuje različite baze na istom hostu", () => {
    expect(
      sameDatabase(
        "postgresql://u:p@127.0.0.1:5432/rcs_dev",
        "postgresql://u:p@127.0.0.1:5432/rcs_test"
      )
    ).toBe(false);
  });

  it("razlikuje isti naziv baze na različitim portovima (embedded DEV vs TEST)", () => {
    expect(
      sameDatabase(
        "postgresql://rcs:pw@127.0.0.1:55432/rcs_dev",
        "postgresql://rcs_test:pw@127.0.0.1:55433/rcs_test"
      )
    ).toBe(false);
  });

  it("razlikuje različite hostove sa istim imenom baze", () => {
    expect(
      sameDatabase(
        "postgresql://u:p@ep-dev.neon.tech/rcs?sslmode=require",
        "postgresql://u:p@ep-test.neon.tech/rcs?sslmode=require"
      )
    ).toBe(false);
  });
});

describe("looksLikeTestDatabaseName", () => {
  it("prihvata imena koja sadrže 'test' kao odvojenu reč", () => {
    expect(looksLikeTestDatabaseName("rcs_test")).toBe(true);
    expect(looksLikeTestDatabaseName("test_db")).toBe(true);
    expect(looksLikeTestDatabaseName("my-test-branch")).toBe(true);
    expect(looksLikeTestDatabaseName("test")).toBe(true);
  });

  it("odbija imena gde je 'test' samo deo druge reči", () => {
    expect(looksLikeTestDatabaseName("contest_data")).toBe(false);
    expect(looksLikeTestDatabaseName("attestation")).toBe(false);
    expect(looksLikeTestDatabaseName("latest")).toBe(false);
  });

  it("odbija dev/prod imena", () => {
    expect(looksLikeTestDatabaseName("rcs_dev")).toBe(false);
    expect(looksLikeTestDatabaseName("production")).toBe(false);
    expect(looksLikeTestDatabaseName("rcs_prod")).toBe(false);
  });
});

describe("parseDbIdentity", () => {
  it("izvlači host/port/ime baze, ignorišući kredencijale", () => {
    const id = parseDbIdentity("postgresql://user:secret@host.example.com:5432/mydb?sslmode=require");
    expect(id).toEqual({ host: "host.example.com", port: "5432", database: "mydb" });
  });

  it("podrazumeva port 5432 kad nije eksplicitno naveden", () => {
    const id = parseDbIdentity("postgresql://user:secret@host.example.com/mydb");
    expect(id.port).toBe("5432");
  });
});
