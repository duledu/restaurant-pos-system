import { NextResponse } from "next/server";
import { prisma } from "@rcs/db";
import {
  verifyPin,
  evaluatePinAttempt,
  createSessionToken,
  sessionCookieOptions,
  type AuthContext,
} from "@rcs/auth";
import { pinLoginSchema } from "@rcs/shared";
import { audit } from "@rcs/domain";

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

    const { employeeId, pin, deviceId } = parsed.data;

    // Uređaj mora biti unapred registrovan i aktivan — PIN prijava sa
    // neregistrovanog uređaja se ne pokušava ni proveravati.
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || !device.isActive) {
      return NextResponse.json({ error: "Uređaj nije registrovan" }, { status: 403 });
    }

    const attempt = await prisma.$transaction(async (tx) => {
      // Row lock serializes attempts for this employee across all app/serverless
      // instances, so concurrent failures cannot overwrite one another.
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
      const employee = rows[0];
      if (!employee || !employee.pinHash || employee.restaurantId !== device.restaurantId) return null;

      const now = new Date();
      const isLocked = Boolean(employee.pinLockedUntil && employee.pinLockedUntil > now);
      const isCorrect = isLocked ? false : await verifyPin(pin, employee.pinHash);
      const evaluation = evaluatePinAttempt({
        isCorrect,
        currentFailedAttempts: employee.failedPinAttempts,
        lockedUntil: employee.pinLockedUntil,
        now,
      });

      await tx.employee.update({
        where: { id: employee.id },
        data: {
          failedPinAttempts: evaluation.newFailedAttempts,
          pinLockedUntil: evaluation.newLockedUntil,
        },
      });
      return { employee, evaluation };
    });

    if (!attempt) return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    const { employee, evaluation } = attempt;

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
    });

    const response = NextResponse.json({ ok: true });
    response.cookies.set(sessionCookieOptions.name, token, sessionCookieOptions);
    return response;
  } catch (error) {
    console.error("POST /api/auth/pin-login", error);
    return NextResponse.json({ error: "Prijava trenutno nije moguća — pokušaj ponovo" }, { status: 500 });
  }
}
