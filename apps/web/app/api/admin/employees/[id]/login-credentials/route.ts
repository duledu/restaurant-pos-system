import { NextResponse } from "next/server";
import { z } from "zod";
import { employees } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

const schema = z.object({
  username: z.string().trim().min(1, "Korisničko ime je obavezno").max(100, "Korisničko ime je predugačko"),
  password: z.string().min(10, "Lozinka mora imati najmanje 10 karaktera"),
});

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Neispravan zahtev" }, { status: 400 });
  }
  await employees.setEmployeeLoginPassword(ctx, id, parsed.data);
  return NextResponse.json({ ok: true });
});
