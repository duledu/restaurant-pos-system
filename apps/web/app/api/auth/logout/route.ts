import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@rcs/auth";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookieOptions.name, "", {
    ...sessionCookieOptions,
    maxAge: 0,
    expires: new Date(0),
  });
  return response;
}
