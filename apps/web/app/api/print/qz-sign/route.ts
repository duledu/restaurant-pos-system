import { NextResponse } from "next/server";
import { createSign } from "crypto";
import { withApiAuth } from "../../../../lib/api-helpers";

/**
 * P0.16 — QZ Tray potpisivanje zahteva (qz.security.setSignaturePromise,
 * algoritam SHA512 — vidi qz-client.ts wireSecurityPromises). Privatni
 * ključ ŽIVI ISKLJUČIVO ovde (env promenljiva QZ_PRIVATE_KEY, server-only —
 * NIKAD NEXT_PUBLIC_, nikad u klijentskom bundle-u, isti obrazac kao
 * PIN_ENCRYPTION_KEY/fiscalization ključevi). Ako ključ nije podešen, vraća
 * prazan potpis (400 nije potrebno — QZ Tray tumači neuspešan/prazan
 * potpis kao "nepotpisano" i sam prikazuje svoj poverenja-prompt, isti
 * bezbedan fallback kao qz-certificate ruta) umesto da baci grešku koja bi
 * mogla da prekine ceo pokušaj štampe.
 */
// QZ-ov signature promise šalje kratak nonce/timestamp string za
// potpisivanje (vidi qz-client.ts wireSecurityPromises) — ne stvarni
// sadržaj tiketa. Gornja granica je namerno velikodušna za taj legitiman
// slučaj, a postoji da autentifikovan pozivalac ne može ovu rutu da
// zloupotrebi kao proizvoljan "potpiši mi bilo šta veliko" servis.
const MAX_SIGN_PAYLOAD_LENGTH = 4096;

export const POST = withApiAuth(async (_ctx, request) => {
  const body = await request.json();
  const rawToSign = typeof body?.toSign === "string" ? body.toSign : "";
  const toSign = rawToSign.length <= MAX_SIGN_PAYLOAD_LENGTH ? rawToSign : "";

  const privateKey = process.env.QZ_PRIVATE_KEY;
  if (!privateKey || !toSign) {
    return NextResponse.json({ signature: "" });
  }

  try {
    const signer = createSign("SHA512");
    signer.update(toSign, "utf8");
    signer.end();
    const signature = signer.sign(privateKey, "base64");
    return NextResponse.json({ signature });
  } catch {
    // Loše formatiran ključ i sl. — isti bezbedan "prazan potpis" fallback,
    // nikad ne obara ceo pokušaj štampe zbog problema sa potpisivanjem.
    return NextResponse.json({ signature: "" });
  }
});
