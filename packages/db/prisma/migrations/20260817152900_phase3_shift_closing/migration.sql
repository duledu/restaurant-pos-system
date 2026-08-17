-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "cardTotal" DECIMAL(12,2),
ADD COLUMN     "cashDifference" DECIMAL(12,2),
ADD COLUMN     "countedCash" DECIMAL(12,2),
ADD COLUMN     "expectedCash" DECIMAL(12,2),
ADD COLUMN     "orderCount" INTEGER,
ADD COLUMN     "totalRevenue" DECIMAL(12,2);

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

