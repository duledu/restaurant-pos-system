import { notFound } from "next/navigation";
import { qrMenu } from "@rcs/domain";
import { PublicMenuView } from "./public-menu-view";

export const dynamic = "force-dynamic"; // always reflects the current authoritative menu — never a stale cached build

export default async function PublicMenuPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { slug } = await params;
  const { t } = await searchParams;
  const menu = await qrMenu.getPublicMenu(slug, t ?? null);
  if (!menu) notFound();
  return <PublicMenuView menu={menu} />;
}
