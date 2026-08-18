import { defineConfig } from "vitest/config";
import { sharedAlias } from "./vitest.shared";

// UNIT testovi — čista logika, NIKAD ne dodiruju bazu. Namerno bez
// tests/setup/require-test-database.ts: taj setup zahteva TEST_DATABASE_URL
// i pravi live DB konekciju, što bi nepotrebno usporilo/zakomplikovalo
// pokretanje testova koji ni ne koriste bazu. Integration testovi (koji
// jesu protiv prave baze) žive u vitest.integration.config.ts.
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 15000,
  },
});
