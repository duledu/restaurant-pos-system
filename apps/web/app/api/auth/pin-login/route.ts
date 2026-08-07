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

export async function POST(request: Request) {
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

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee || !employee.pinHash || employee.restaurantId !== device.restaurantId) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  const isCorrect = await verifyPin(pin, employee.pinHash);
  const evaluation = evaluatePinAttempt({
    isCorrect,
    currentFailedAttempts: employee.failedPinAttempts,
    lockedUntil: employee.pinLockedUntil,
  });

  await prisma.employee.update({
    where: { id: employee.id },
    data: {
      failedPinAttempts: evaluation.newFailedAttempts,
      pinLockedUntil: evaluation.newLockedUntil,
    },
  });

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

  if (employee.status !== "ACTIVE") {
    return NextResponse.json({ error: "Nalog zaposlenog nije aktivan" }, { status: 403 });
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
}
