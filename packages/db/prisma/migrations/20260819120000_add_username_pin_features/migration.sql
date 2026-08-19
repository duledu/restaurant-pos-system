-- Add username to users table (replaces email as the login identifier shown to staff)
-- Migration is safe for existing rows: populate username = email before adding NOT NULL constraint.
ALTER TABLE "users" ADD COLUMN "username" TEXT;
UPDATE "users" SET "username" = "email";
ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- Make email nullable: after this migration email is an internal system field,
-- not the login identifier. Existing rows keep their email value unchanged.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- Add encrypted recoverable PIN for admin-controlled reveal (AES-256-GCM, key in env)
ALTER TABLE "employees" ADD COLUMN "encryptedPin" TEXT;

-- Add per-employee PIN login toggle (default enabled for all existing employees)
ALTER TABLE "employees" ADD COLUMN "pinLoginEnabled" BOOLEAN NOT NULL DEFAULT true;
