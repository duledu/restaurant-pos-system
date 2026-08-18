-- AlterTable: dodaj employeeId na Device za lični uređaj zaposlenog
-- Nullable — null = deljeni terminal, ne-null = lični uređaj
ALTER TABLE "devices" ADD COLUMN "employeeId" TEXT;

-- Unique: jedan zaposleni može imati samo jedan registrovan lični uređaj
CREATE UNIQUE INDEX "devices_employeeId_key" ON "devices"("employeeId");

-- FK prema employees (onDelete: SetNull — brisanje zaposlenog oslobađa uređaj)
ALTER TABLE "devices" ADD CONSTRAINT "devices_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
