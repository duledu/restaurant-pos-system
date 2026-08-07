import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAuth } from "@rcs/auth";
import { resolveRedirectPath } from "@rcs/shared";

export default async function RootPage() {
  const headersList = await headers();
  const fakeRequest = new Request("http://internal/", {
    headers: { cookie: headersList.get("cookie") ?? "" },
  });

  let target = "/login";
  try {
    const ctx = await requireAuth(fakeRequest);
    target = resolveRedirectPath(ctx.roles);
  } catch {
    target = "/login";
  }
  redirect(target);
}
