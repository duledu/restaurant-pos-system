-- BRANDED QR MENU V1 — public, guest-facing digital menu. RUČNO sastavljena
-- migracija (isti obrazac kao svaka ranija migracija ove sesije),
-- verifikovana preko `prisma migrate diff` (bez razlike u odnosu na ovaj
-- fajl). Potpuno ADITIVNA — dve nove kolone (nullable, bez default-a koji
-- bi menjao ponašanje), jedna nova tabela, četiri nova enuma. Ni jedna
-- postojeća tabela/kolona/red nije obrisan niti izmenjen.
--
--   1. restaurants.slug — opcioni javni identifikator (/m/{slug}). NULL za
--      sve postojeće restorane dok ih Admin eksplicitno ne postavi — javna
--      ruta tada vraća 404, nikad ne pogađa slug.
--   2. restaurant_tables.publicQrToken — opcioni neproziran token za
--      sto-svesan QR, generiše se lenjo (na zahtev iz Admin ekrana), NIKAD
--      bulk-backfill.
--   3. qr_menu_settings — nova 1:1 tabela (kao restaurant_settings), red ne
--      postoji dok Admin prvi put ne sačuva — podrazumevane vrednosti se
--      primenjuju na aplikativnom sloju, isti obrazac kao
--      settings-service.ts getRestaurantSettings.
--
-- Vidi schema.prisma napomenu uz model QrMenuSettings za potpuno
-- obrazloženje.

-- CreateEnum
CREATE TYPE "QrThemePreset" AS ENUM ('LIGHT', 'DARK', 'WARM', 'ELEGANT');

-- CreateEnum
CREATE TYPE "QrTypographyPreset" AS ENUM ('ELEGANT', 'MODERN', 'CLASSIC', 'CASUAL');

-- CreateEnum
CREATE TYPE "QrCardStyle" AS ENUM ('IMAGE_DOMINANT', 'BALANCED', 'COMPACT');

-- CreateEnum
CREATE TYPE "QrImageShape" AS ENUM ('ROUNDED', 'SOFT', 'SQUARE');

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "restaurant_tables" ADD COLUMN     "publicQrToken" TEXT;

-- CreateTable
CREATE TABLE "qr_menu_settings" (
    "restaurantId" TEXT NOT NULL,
    "tagline" TEXT,
    "coverImageUrl" TEXT,
    "themePreset" "QrThemePreset" NOT NULL DEFAULT 'WARM',
    "accentColor" TEXT,
    "typographyPreset" "QrTypographyPreset" NOT NULL DEFAULT 'MODERN',
    "cardStyle" "QrCardStyle" NOT NULL DEFAULT 'BALANCED',
    "imageShape" "QrImageShape" NOT NULL DEFAULT 'ROUNDED',
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qr_menu_settings_pkey" PRIMARY KEY ("restaurantId")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurants_slug_key" ON "restaurants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_tables_publicQrToken_key" ON "restaurant_tables"("publicQrToken");

-- AddForeignKey
ALTER TABLE "qr_menu_settings" ADD CONSTRAINT "qr_menu_settings_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
