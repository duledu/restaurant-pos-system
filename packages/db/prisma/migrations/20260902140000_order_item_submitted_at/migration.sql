-- VISE-KRUZNO NARUCIVANJE (Faza 9) -- kad je KONKRETNA stavka poslata
-- kuhinji/sanku (DRAFT -> SUBMITTED), null dok je jos DRAFT. Order.submittedAt
-- ostaje vreme PRVOG slanja cele porudzbine; ovo polje razlikuje "stari" od
-- "novopristiglog" kruga po stavci, bez posebnog batch/round modela.
-- Potpuno aditivno -- nullable, nista se ne brise/prepisuje.
--
-- Rucno sastavljena iz `prisma migrate diff` izlaza -- SADRZI SAMO stvarno
-- novu izjavu ispod. Namerno iskljucuje (nije deo ove migracije) sav
-- ostatak sirovog diff izlaza (DROP/ADD FOREIGN KEY parovi -- Prisma samo
-- ponovo normalizuje vec postojece FK definicije, cist sum -- isti obrazac
-- kao svaka ranija migracija ovog projekta).

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN "submittedAt" TIMESTAMP(3);
