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
  },
});
