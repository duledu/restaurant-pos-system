import { defineConfig } from "vitest/config";
import { sharedAlias } from "./vitest.shared";

// INTEGRATION testovi — protiv realne Postgres baze. tests/setup/
// require-test-database.ts (safety gate) MORA biti prvi setupFile: aborta
// ceo run ako TEST_DATABASE_URL nije eksplicitno postavljen na već
// obeleženu test bazu. Vidi docs/database-safety.md.
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/setup/require-test-database.ts"],
    hookTimeout: 20000,
    // Podignuto sa vitest default-a (5000ms) — Deljeni POS anonimni PIN
    // login (pin-login/route.ts) skenira SVE aktivne zaposlene restorana i
    // za svakog radi scrypt verifyPin, pa testovi sa više zaposlenih/više
    // login ciklusa (tests/integration/shared-pos-lock.test.ts) mogu
    // premašiti 5s čisto na trošku hashiranja, bez ikakvog bug-a.
    testTimeout: 15000,
    // tests/integration/* deli JEDNU Postgres bazu i svaki fajl radi
    // TRUNCATE ... CASCADE u beforeEach — paralelno izvršavanje fajlova
    // dovodi do deadlock-a među njima. Sekvencijalno izvršavanje fajlova
    // ne staje ozbiljno na performanse (testovi su brzi).
    fileParallelism: false,
  },
});
