/**
 * Audit servis — JEDINO mesto u sistemu koje sme da piše u AuditLog.
 * Drugi moduli ga pozivaju posle uspešne poslovne operacije; ne pišu
 * direktno preko `prisma.auditLog.create(...)` da bi format zapisa ostao
 * dosledan (vidi requireEntry ispod).
 */

import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";

export interface AuditEntryInput {
  entityType: string;
  entityId: string;
  action: string;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string;
  ipAddress?: string;
}

export async function recordAuditEntry(ctx: AuthContext, entry: AuditEntryInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      restaurantId: ctx.restaurantId,
      userId: ctx.userId,
      role: ctx.roles[0],
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      previousValue: entry.previousValue as never,
      newValue: entry.newValue as never,
      reason: entry.reason,
      ipAddress: entry.ipAddress,
      deviceId: ctx.deviceId,
    },
  });
}
