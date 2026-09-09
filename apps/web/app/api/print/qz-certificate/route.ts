import { NextResponse } from "next/server";
import { withApiAuth } from "../../../../lib/api-helpers";

/**
 * P0.16/P0.18 — QZ Tray sertifikat (qz.security.setCertificatePromise).
 * Vraća JAVNI sertifikat iz env promenljive — nikad privatni ključ, nikad
 * hardkodovan/izmišljen ovde. Iza withApiAuth samo iz opreza (dosledno
 * ostatku API-ja) — sam sertifikat nije osetljiv (to je upravo ono što se
 * pokazuje QZ Tray-u).
 *
 * `signingConfigured` (P0.18 — ispravka "Failed to sign request" bez
 * podešenih kredencijala): eksplicitan, bezbedan boolean — NIKAD detalj
 * osim true/false — koji qz-client.ts čita PRE nego što uopšte registruje
 * BILO KOJI security promise kod QZ-a. Bez ovoga, klijent je ranije
 * bezuslovno pozivao qz.security.setSignaturePromise, a QZ Tray tumači
 * REGISTROVAN ali prazan potpis (kad QZ_PRIVATE_KEY nije podešen) kao
 * NEUSPEO pokušaj potpisivanja ("Failed to sign request"), ne kao "nema
 * potpisivanja, koristi podrazumevani nepotpisan tok" — potpuno druga (i
 * pogrešna) grana QZ Tray internog ponašanja od one koju koristi zvaničan
 * QZ demo sajt (koji NIKAD ne registruje sopstveni signature promise).
 */
export const GET = withApiAuth(async () => {
  const signingConfigured = Boolean(process.env.QZ_CERTIFICATE) && Boolean(process.env.QZ_PRIVATE_KEY);
  return NextResponse.json({
    certificate: process.env.QZ_CERTIFICATE ?? "",
    signingConfigured,
  });
});
