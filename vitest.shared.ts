import path from "node:path";

export const sharedAlias = {
  "@rcs/db": path.resolve(__dirname, "packages/db/index.ts"),
  "@rcs/auth": path.resolve(__dirname, "packages/auth/index.ts"),
  "@rcs/domain": path.resolve(__dirname, "packages/domain/index.ts"),
  "@rcs/shared": path.resolve(__dirname, "packages/shared/index.ts"),
};
