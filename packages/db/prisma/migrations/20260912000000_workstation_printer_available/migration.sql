-- Faza 2B — agent lokalno prijavljuje da li je configuredPrinterName
-- zaista dostupan u Windows spisku štampača. Aditivno, nullable (null =
-- još nije prijavljeno), bez izmene postojećih redova.

-- AlterTable
ALTER TABLE "workstations" ADD COLUMN "printerAvailable" BOOLEAN;
