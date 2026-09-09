-- Faza 2C — Admin "Test Print" dugme. Aditivno, sve nullable (null =
-- nikad zatraženo), bez izmene postojećih redova. Namerno odvojeno od
-- PrintJob (koje zahteva realan orderId FK) tako da test štampa nikad ne
-- dotiče Order/Payment/izveštaje.

-- AlterTable
ALTER TABLE "workstations" ADD COLUMN "testPrintRequestedAt" TIMESTAMP(3);
ALTER TABLE "workstations" ADD COLUMN "testPrintRequestedBy" TEXT;
ALTER TABLE "workstations" ADD COLUMN "testPrintStatus" TEXT;
ALTER TABLE "workstations" ADD COLUMN "testPrintCompletedAt" TIMESTAMP(3);
ALTER TABLE "workstations" ADD COLUMN "testPrintError" TEXT;
