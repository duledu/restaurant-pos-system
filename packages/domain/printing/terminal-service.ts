/**
 * PRINTING V2 FINAL — LOGIN_AWARE secure workstation binding.
 *
 * Proves, WITHOUT ever handing the Agent's permanent bearer credential to
 * browser JavaScript and WITHOUT trusting any client-asserted workstationId,
 * that a specific authenticated TableCore employee session is physically
 * running on THIS exact paired Windows computer right now.
 *
 * Mechanism (reuses the already-shipped, already-physically-proven
 * tablecore-print:// custom URI + installed Agent process — the same one
 * built for the Admin pairing handoff, see apps/print-agent/Program.cs
 * SetupArgumentDispatch):
 *
 *   1. Browser (authenticated as an employee) calls createTerminalBindIntent
 *      -> gets back a short-lived, single-use, LOW-VALUE token (never a
 *      credential, never usable for anything beyond consuming exactly this
 *      one role-binding once).
 *   2. Browser navigates to tablecore-print://bind?token=<token>. Windows
 *      resolves this ONLY on a machine where the Agent installer registered
 *      the protocol handler — a phone has no such handler, so this URI
 *      simply does nothing there. This is the entire "phone cannot hijack a
 *      Windows workstation" guarantee: there is no code path by which a
 *      phone browser can ever reach step 3 below.
 *   3. The OS launches the SAME installed Agent .exe with that URI as an
 *      argument. The Agent (already holding its own permanent, DPAPI-
 *      protected bearer credential from pairing) POSTs the token to
 *      POST /api/agent/terminal/bind using THAT credential — proving
 *      physical co-location structurally, not by client assertion.
 *   4. consumeTerminalBind (below) validates the token server-side and
 *      creates/replaces the ONE active WorkstationTerminalSession for that
 *      Agent's own authenticated workstationId.
 *   5. The browser polls getTerminalStatus (its own authenticated session,
 *      no token involved) to learn when step 4 completed, then keeps the
 *      binding alive with a lightweight periodic heartbeatTerminalSession
 *      call — no further Agent round-trip needed once co-location is proven
 *      once. unbindTerminalSession is called explicitly on logout.
 */
import { randomBytes } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext, WorkstationAuthContext } from "@rcs/auth";
import { agentTerminalBindSchema } from "@rcs/shared";
import type { PrintRouteTypeValue } from "./print-policy";

const BIND_INTENT_TTL_MS = 2 * 60 * 1000; // time allowed for the OS/Agent round trip
const TERMINAL_SESSION_TTL_MS = 90 * 1000; // rolling TTL, refreshed by the browser's own heartbeat
export const TERMINAL_HEARTBEAT_INTERVAL_MS = 30 * 1000; // client-side cadence (well under the TTL above)

interface BindIntent {
  restaurantId: string;
  employeeId: string;
  printRole: PrintRouteTypeValue;
  expiresAt: number;
}

// Deliberately in-memory, NOT persisted: a bind-intent is a short-lived
// (2 min), single-use, disposable proof-of-intent token — losing it on a
// server restart mid-flow is a harmless "expired, try again", never a
// security or data-loss concern (same philosophy as the already-shipped
// in-memory Setup pairing-code prefill). This also means bind-intents don't
// survive a serverless cold instance swap between steps 1 and 3 above; if
// that becomes a real operational problem, promoting this Map to a small
// table is a pure implementation-detail change with no API/security impact.
const bindIntents = new Map<string, BindIntent>();

function pruneExpiredIntents(now: number): void {
  for (const [token, intent] of bindIntents) if (intent.expiresAt <= now) bindIntents.delete(token);
}

/**
 * Role Mapping (section 12 — elevated roles never silently become an
 * all-purpose print consumer): KITCHEN -> KITCHEN, BAR -> BAR,
 * WAITER -> RECEIPT, in that priority order for a multi-role employee.
 * OWNER/ADMIN/MANAGER/INVENTORY_MANAGER intentionally map to null — their
 * login grants no automatic operational print role. They can still open
 * Admin -> Štampači and use Test Print without ever binding a terminal.
 */
export function operationalPrintRoleFor(roles: readonly string[]): PrintRouteTypeValue | null {
  if (roles.includes("KITCHEN")) return "KITCHEN";
  if (roles.includes("BAR")) return "BAR";
  if (roles.includes("WAITER")) return "RECEIPT";
  return null;
}

export interface TerminalBindIntent {
  token: string;
  printRole: PrintRouteTypeValue;
  expiresAt: string;
}

/** Browser, authenticated as ctx.employeeId. Returns null (no intent
 * created, nothing for the client to do) when this employee's role has no
 * operational print mapping, OR when the restaurant is currently in
 * CENTRAL_ROUTING mode — terminal binding only ever matters under
 * LOGIN_AWARE (resolveEligibleWorkstation never reads
 * WorkstationTerminalSession under CENTRAL_ROUTING at all), so there is no
 * reason to ever create one otherwise. */
export async function createTerminalBindIntent(ctx: AuthContext): Promise<TerminalBindIntent | null> {
  const printRole = operationalPrintRoleFor(ctx.roles);
  if (!printRole) return null;
  const restaurant = await prisma.restaurant.findUnique({ where: { id: ctx.restaurantId }, select: { printingMode: true } });
  if (restaurant?.printingMode !== "LOGIN_AWARE") return null;
  const now = Date.now();
  pruneExpiredIntents(now);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + BIND_INTENT_TTL_MS;
  bindIntents.set(token, { restaurantId: ctx.restaurantId, employeeId: ctx.employeeId, printRole, expiresAt });
  return { token, printRole, expiresAt: new Date(expiresAt).toISOString() };
}

export interface ConsumeBindResult {
  printRole: PrintRouteTypeValue;
  employeeId: string;
}

/**
 * Agent, authenticated via its own permanent bearer credential (wsCtx).
 * Single-use: the token is deleted on the FIRST attempt regardless of
 * outcome, so a lost/duplicated Agent request can never bind twice from one
 * token, and a stale/guessed token can never be retried.
 */
export async function consumeTerminalBind(wsCtx: WorkstationAuthContext, input: unknown): Promise<ConsumeBindResult> {
  const { token } = agentTerminalBindSchema.parse(input);
  pruneExpiredIntents(Date.now());
  const intent = bindIntents.get(token);
  if (!intent) throw new Error("Kod za povezivanje je istekao ili je nevažeći — zatražite nov u TableCore-u i pokušajte ponovo.");
  bindIntents.delete(token);
  // Defense in depth — a token minted for a different restaurant can never
  // bind an Agent belonging to this one, even though bind-intents are
  // already scoped server-side and never carry a client-chosen restaurantId.
  if (intent.restaurantId !== wsCtx.restaurantId) throw new Error("Kod za povezivanje ne pripada ovom restoranu");

  await prisma.$transaction([
    // "New operational user becomes active -> previous role cannot remain
    // active accidentally" applied per-EMPLOYEE too (not just per-computer):
    // clears any other workstation this same employee was previously bound
    // to, so getTerminalStatus/heartbeat/unbind (all scoped by employeeId,
    // never by a client-supplied workstationId) stay unambiguous — at most
    // one active binding per employee, at most one per workstation.
    prisma.workstationTerminalSession.deleteMany({
      where: { employeeId: intent.employeeId, workstationId: { not: wsCtx.workstationId } },
    }),
    prisma.workstationTerminalSession.upsert({
      where: { workstationId: wsCtx.workstationId },
      create: {
        workstationId: wsCtx.workstationId,
        restaurantId: wsCtx.restaurantId,
        locationId: wsCtx.locationId,
        employeeId: intent.employeeId,
        printRole: intent.printRole,
        expiresAt: new Date(Date.now() + TERMINAL_SESSION_TTL_MS),
      },
      update: {
        restaurantId: wsCtx.restaurantId,
        locationId: wsCtx.locationId,
        employeeId: intent.employeeId,
        printRole: intent.printRole,
        boundAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + TERMINAL_SESSION_TTL_MS),
      },
    }),
  ]);
  return { printRole: intent.printRole, employeeId: intent.employeeId };
}

export interface TerminalStatus {
  workstationId: string;
  workstationName: string;
  printRole: PrintRouteTypeValue;
  expiresAt: string;
}

/** Browser, authenticated as ctx.employeeId — never trusts/accepts a
 * workstationId from the caller; only ever looks up by employeeId. */
export async function getTerminalStatus(ctx: AuthContext): Promise<TerminalStatus | null> {
  const session = await prisma.workstationTerminalSession.findFirst({
    where: { employeeId: ctx.employeeId, restaurantId: ctx.restaurantId, expiresAt: { gt: new Date() } },
    select: { workstationId: true, printRole: true, expiresAt: true, workstation: { select: { name: true } } },
  });
  if (!session) return null;
  return {
    workstationId: session.workstationId,
    workstationName: session.workstation.name,
    printRole: session.printRole as PrintRouteTypeValue,
    expiresAt: session.expiresAt.toISOString(),
  };
}

/** Rolling TTL refresh — called every TERMINAL_HEARTBEAT_INTERVAL_MS by the
 * browser while its tab stays open. Returns false (safe no-op) once the
 * binding has already lapsed — the client should then stop heartbeating and
 * show "not bound" rather than resurrect a stale session. */
export async function heartbeatTerminalSession(ctx: AuthContext): Promise<boolean> {
  const result = await prisma.workstationTerminalSession.updateMany({
    where: { employeeId: ctx.employeeId, restaurantId: ctx.restaurantId, expiresAt: { gt: new Date() } },
    data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + TERMINAL_SESSION_TTL_MS) },
  });
  return result.count > 0;
}

/** Explicit logout path — removes eligibility promptly rather than waiting
 * for the TTL to lapse. Best-effort/idempotent: a caller with no active
 * binding is a normal no-op, never an error. */
export async function unbindTerminalSession(ctx: AuthContext): Promise<void> {
  await prisma.workstationTerminalSession.deleteMany({ where: { employeeId: ctx.employeeId, restaurantId: ctx.restaurantId } });
}
