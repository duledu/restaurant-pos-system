import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@rcs/db": path.resolve(__dirname, "packages/db/index.ts"),
      "@rcs/auth": path.resolve(__dirname, "packages/auth/index.ts"),
      "@rcs/domain": path.resolve(__dirname, "packages/domain/index.ts"),
      "@rcs/shared": path.resolve(__dirname, "packages/shared/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    hookTimeout: 20000,
    // tests/integration/* deli JEDNU Postgres bazu i svaki fajl radi
    // TRUNCATE ... CASCADE u beforeEach — paralelno izvršavanje fajlova
    // dovodi do deadlock-a među njima. Testovi su brzi (57 unit + 18
    // integration testova u par sekundi), pa sekvencijalno izvršavanje
    // fajlova ne staje ozbiljno na performanse.
    fileParallelism: false,
  },
});
