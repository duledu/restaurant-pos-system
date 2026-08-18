import { NextResponse } from "next/server";
import { prisma } from "@rcs/db";
import {
  verifyPin,
  evaluatePinAttempt,
  createSessionToken,
  sessionCookieOptions,
  type AuthContext,
} from "@rcs/auth";
import { pinLoginSchema, resolveRedirectPath } from "@rcs/shared";
import { audit } from "@rcs/domain";
import { clearLoginThrottle, getActiveLoginThrottle, recordFailedLogin } from "../../../../lib/login-throttle";

const GENERIC_ERROR = "Neispravan PIN";

interface LockedPinEmployee {
  id: string;
  userId: string | null;
  restaurantId: string;
  pinHash: string | null;
  failedPinAttempts: number;
  pinLockedUntil: Date | null;
  userIsActive: boolean | null;
  employeeStatus: string;
  restaurantStatus: string;
  tenantStatus: string;
}

function deviceThrottleKey(deviceId: string): string {
  return `pin-device:${deviceId}`;
}

async function resolveRedirectFor(employeeId: string): Promise<string> {
  const roles = await prisma.employeeRole.findMany({
    where: { employeeId },
    include: { role: true },
  });
  return resolveRedirectPath(roles.map((r) => r.role.name));
}

export async function POST(request: Request) {
  // Ista napomena kao u login/route.ts: ruta radi PRE auth konteksta pa ne
  // može koristiti withApiAuth — SVAKI neočekivan izuzetak mora i dalje
  // rezultovati validnim JSON odgovorom, nikad praznim/ne-JSON telom.
  try {
    const body = await request.json().catch(() => null);
    const parsed = pinLoginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Neispravan zahtev" }, { status: 400 });
    }

    const { pin, deviceId } = parsed.data;
    let { employeeId } = parsed.data;

    // Uređaj mora biti unapred registrovan i aktivan — PIN prijava sa
    // neregistrovanog uređaja se ne pokušava ni proveravati.
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || !device.isActive) {
      return NextResponse.json({ error: "Uređaj nije registrovan" }, { status: 403 });
    }

    // Lični uređaj: uvek koristi employeeId vlasnika uređaja (ignorišemo sve
    // što je klijent eventualno poslao) da bismo sprečili upotrebu tuđeg PIN-a
    // na ličnom uređaju čak i ako napadač zna ID drugog zaposlenog.
    if (device.employeeId) {
      employeeId = device.employeeId;
    }

    let employee: LockedPinEmployee | undefined;
    let evaluation: ReturnType<typeof evaluatePinAttempt> | undefined;

    if (employeeId) {
      // Poznat employeeId (npr. postojeća integracija) — identičan tok kao
      // pre uvođenja Deljenog POS-a, samo taj jedan red se zaključava.
      const attempt = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedPinEmployee[]>`
          SELECT e."id", e."userId", e."restaurantId", e."pinHash",
                 e."failedPinAttempts", e."pinLockedUntil",
                 u."isActive" AS "userIsActive",
                 e."status"::text AS "employeeStatus",
                 r."status"::text AS "restaurantStatus",
                 t."status"::text AS "tenantStatus"
          FROM "employees" e
          JOIN "restaurants" r ON r."id" = e."restaurantId"
          JOIN "tenants" t ON t."id" = r."tenantId"
          LEFT JOIN "users" u ON u."id" = e."userId"
          WHERE e."id" = ${employeeId}
          FOR UPDATE OF e
        `;
        const row = rows[0];
        if (!row || !row.pinHash || row.restaurantId !== device.restaurantId) return null;

        const now = new Date();
        const isLocked = Boolean(row.pinLockedUntil && row.pinLockedUntil > now);
        const isCorrect = isLocked ? false : await verifyPin(pin, row.pinHash);
        const result = evaluatePinAttempt({
          isCorrect,
          currentFailedAttempts: row.failedPinAttempts,
          lockedUntil: row.pinLockedUntil,
          now,
        });

        await tx.employee.update({
          where: { id: row.id },
          data: { failedPinAttempts: result.newFailedAttempts, pinLockedUntil: result.newLockedUntil },
        });
        return { row, result };
      });

      if (!attempt) return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
      employee = attempt.row;
      evaluation = attempt.result;
    } else {
      // Nema employeeId — dodirni PIN taster (Deljeni POS/Lični uređaj) ga
      // NIKAD ne šalje, da izbegne listu zaposlenih pre PIN-a. Zaposleni se
      // pronalazi proverom PIN-a naspram svih aktivnih zaposlenih ovog
      // restorana — bezbedno jer je PIN jedinstven po restoranu (Staff
      // Management). Kada nema poklapanja, ne možemo znati koji je nalog
      // "meta" pokušaja pa se ne uvećava nijedan employee.failedPinAttempts
      // — umesto toga se uvećava throttle NA NIVOU UREĐAJA (ista tabela/
      // logika kao email login, packages/db LoginThrottle) da spreči
      // neograničeno probanje PIN-ova protiv deljenog terminala.
      const throttleKey = deviceThrottleKey(deviceId);
      const lockedUntil = await getActiveLoginThrottle(throttleKey);
      if (lockedUntil) {
        const retryAfter = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
        return NextResponse.json(
          { error: "Previše neuspešnih pokušaja sa ovog uređaja. Pokušaj ponovo kasnije." },
          { status: 429, headers: { "Retry-After": String(retryAfter) } }
        );
      }

      const attempt = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedPinEmployee[]>`
          SELECT e."id", e."userId", e."restaurantId", e."pinHash",
                 e."failedPinAttempts", e."pinLockedUntil",
                 u."isActive" AS "userIsActive",
                 e."status"::text AS "employeeStatus",
                 r."status"::text AS "restaurantStatus",
                 t."status"::text AS "tenantStatus"
          FROM "employees" e
          JOIN "restaurants" r ON r."id" = e."restaurantId"
          JOIN "tenants" t ON t."id" = r."tenantId"
          LEFT JOIN "users" u ON u."id" = e."userId"
          WHERE e."restaurantId" = ${device.restaurantId}
            AND e."status" = 'ACTIVE'
            AND e."pinHash" IS NOT NULL
          FOR UPDATE OF e
        `;

        const now = new Date();
        const candidates = await Promise.all(
          rows.map(async (row) => {
            const isLocked = Boolean(row.pinLockedUntil && row.pinLockedUntil > now);
            const isCorrect = isLocked ? false : await verifyPin(pin, row.pinHash as string);
            return { row, isCorrect };
          })
        );
        const matched = candidates.find((c) => c.isCorrect);
        if (!matched) return null;

        const result = evaluatePinAttempt({
          isCorrect: true,
          currentFailedAttempts: matched.row.failedPinAttempts,
          lockedUntil: matched.row.pinLockedUntil,
          now,
        });
        await tx.employee.update({
          where: { id: matched.row.id },
          data: { failedPinAttempts: result.newFailedAttempts, pinLockedUntil: result.newLockedUntil },
        });
        return { row: matched.row, result };
      });

      if (!attempt) {
        await recordFailedLogin(throttleKey);
        return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
      }
      await clearLoginThrottle(throttleKey);
      employee = attempt.row;
      evaluation = attempt.result;
    }

    if (evaluation.locked) {
      return NextResponse.json(
        { error: "Nalog je privremeno zaključan zbog previše pogrešnih pokušaja" },
        { status: 423 }
      );
    }

    if (!evaluation.success) {
      return NextResponse.json(
        { error: GENERIC_ERROR, remainingAttempts: evaluation.remainingAttempts },
        { status: 401 }
      );
    }

    if (employee.employeeStatus !== "ACTIVE") {
      return NextResponse.json({ error: "Nalog zaposlenog nije aktivan" }, { status: 403 });
    }
    if (employee.userIsActive === false) {
      return NextResponse.json({ error: "Korisnički nalog nije aktivan" }, { status: 403 });
    }
    if (employee.restaurantStatus !== "ACTIVE" || employee.tenantStatus !== "ACTIVE") {
      return NextResponse.json({ error: "Restoran nije aktivan" }, { status: 403 });
    }

    const token = await createSessionToken({
      userId: employee.userId ?? employee.id,
      employeeId: employee.id,
      restaurantId: employee.restaurantId,
      deviceId: device.id,
    });

    const minimalCtx: AuthContext = {
      userId: employee.userId ?? employee.id,
      employeeId: employee.id,
      restaurantId: employee.restaurantId,
      locationIds: [],
      roles: [],
      permissions: new Set(),
      deviceId: device.id,
    };
    await audit.recordAuditEntry(minimalCtx, {
      entityType: "Employee",
      entityId: employee.id,
      action: "auth.pin_login",
      locationId: device.locationId ?? undefined,
    });

    const redirectTo = await resolveRedirectFor(employee.id);

    const response = NextResponse.json({ ok: true, redirectTo });
    response.cookies.set(sessionCookieOptions.name, token, sessionCookieOptions);
    return response;
  } catch (error) {
    console.error("POST /api/auth/pin-login", error);
    return NextResponse.json({ error: "Prijava trenutno nije moguća — pokušaj ponovo" }, { status: 500 });
  }
}
