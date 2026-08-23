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
    // Global teardown disconnects the shared Prisma singleton once after ALL
    // test files complete. Individual afterAll calls have been removed from
    // each test file — calling $disconnect() after each file forces Prisma
    // to re-establish its connection pool for the next file, which on Windows
    // with embedded PostgreSQL can exceed hookTimeout.
    globalSetup: ["./tests/setup/global-teardown.ts"],
    // Windows embedded Postgres can still have a one-off cold-start/reset hook
    // just above 20s even with the corrected single-disconnect lifecycle.
    hookTimeout: 30000,
    // Podignuto sa vitest default-a (5000ms) — Deljeni POS anonimni PIN
    // login (pin-login/route.ts) skenira SVE aktivne zaposlene restorana i
    // za svakog radi scrypt verifyPin, pa testovi sa više zaposlenih/više
    // login ciklusa (tests/integration/shared-pos-lock.test.ts) mogu
    // premašiti 5s čisto na trošku hashiranja, bez ikakvog bug-a. Dalje
    // podignuto na 30000ms kada TEST_DATABASE_URL cilja pravu Neon granu
    // (a ne lokalni embedded Postgres) — svaki upit nosi stvarno mrežno
    // kašnjenje, a testovi koji rade više uzastopnih porudžbina (npr. 5
    // punih submit+void ciklusa) inače mogu isteći na samoj mrežnoj ceni,
    // bez ikakvog bug-a u kodu.
    testTimeout: process.env.TEST_DATABASE_URL?.includes("localhost") ? 15000 : 30000,
    // tests/integration/* deli JEDNU Postgres bazu i svaki fajl radi
    // TRUNCATE ... CASCADE u beforeEach — paralelno izvršavanje fajlova
    // dovodi do deadlock-a među njima. Sekvencijalno izvršavanje fajlova
    // ne staje ozbiljno na performanse (testovi su brzi).
    fileParallelism: false,
    // NAPOMENA (isprobano i odbačeno): isolate:false je isprobano da bi se
    // smanjio broj Prisma connection-pool ciklusa ka Neon-u kroz ~34 fajla,
    // ali je pokvario samu TEST_DATABASE_URL bezbednosnu proveru
    // (tests/setup/assert-test-database.ts) — sa deljenim modul-registry-jem
    // između fajlova, provera je od DRUGOG fajla nadalje netačno detektovala
    // "TEST_DATABASE_URL == DATABASE_URL" i ispravno (bezbedno) prekidala
    // run. Provera je uradila svoj posao — nijedan nebezbedan pristup se
    // nije desio — ali je vitest-ova podrazumevana izolacija po fajlu
    // (isolate: true, default) neophodna da bi ta provera ostala tačna.
    // Ne dirati ovo bez ponovnog rešavanja tog sukoba.
  },
});
