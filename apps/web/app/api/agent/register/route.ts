import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { consumeWorkstationPairingSchema } from "@rcs/shared";
import { clearLoginThrottle, getActiveLoginThrottle, recordFailedLogin } from "../../../../lib/login-throttle";

// Generičan tekst za SVAKI neuspeh (nepostojeći/istekao/potrošen/otkazan
// kod, throttle) — nikad ne otkriva koji je razlog (sprečava enumeraciju
// validnih/nedavno-važećih kodova). Isti princip kao GENERIC_ERROR u
// pin-login/route.ts.
const GENERIC_ERROR = "Kod za uparivanje nije prihvaćen";

/** Best-effort — Vercel/proxy postavlja ovo zaglavlje; ne postoji postojeći
 * presedan u repou za ekstrakciju IP-a, pa je ovo namerno minimalno i
 * dokumentovano kao best-effort (spoofable van Vercel-ove infrastrukture,
 * isti rizik profil kao bilo koji throttling isključivo po zaglavlju). */
function sourceIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

function pairingThrottleKey(ip: string): string {
  return `pairing:${ip}`;
}

/**
 * JAVNA ruta (mora biti u apps/web/middleware.ts PUBLIC_API_PATHS) — agent
 * još nema kredencijal pre uspešne registracije. Nikad ne prima
 * restaurantId/locationId/station od agenta — sve se izvodi ISKLJUČIVO iz
 * uparivanja koje admin unapred kreira (workstations.registerAgentFromPairing).
 * Throttling po izvornom IP-u (isti obrazac kao pin-login device throttle)
 * — pored toga, sam kod je 60-bitne entropije i jednokratan/kratkotrajan,
 * pa throttling ovde nije jedina odbrana od brute-force-a.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = consumeWorkstationPairingSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Neispravan zahtev" }, { status: 400 });
    }

    const throttleKey = pairingThrottleKey(sourceIp(request));
    const lockedUntil = await getActiveLoginThrottle(throttleKey);
    if (lockedUntil) {
      const retryAfter = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
      return NextResponse.json(
        { error: "Previše neuspešnih pokušaja. Pokušaj ponovo kasnije." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    let result;
    try {
      result = await workstations.registerAgentFromPairing(parsed.data);
    } catch {
      await recordFailedLogin(throttleKey);
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    }
    await clearLoginThrottle(throttleKey);

    return NextResponse.json(
      {
        workstationId: result.workstationId,
        credential: result.credential,
        restaurantId: result.restaurantId,
        locationId: result.locationId,
        station: result.station,
        name: result.name,
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Neočekivana greška";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
