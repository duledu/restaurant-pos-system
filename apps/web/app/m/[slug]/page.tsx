import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { qrMenu } from "@rcs/domain";
import { PublicMenuView } from "./public-menu-view";

export const dynamic = "force-dynamic"; // always reflects the current authoritative menu — never a stale cached build

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ t?: string }>;
};

// generateMetadata and the page component both need the same lookup —
// React's cache() dedupes them to ONE getPublicMenu call per request
// (App Router's standard pattern for this), not two.
const loadMenu = cache((slug: string, tableToken: string | null) => qrMenu.getPublicMenu(slug, tableToken));

// The guest should never see "TableCore" in the browser tab/share preview —
// the restaurant is the brand (spec: "Restaurant brand > TableCore brand").
export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const { t } = await searchParams;
  const menu = await loadMenu(slug, t ?? null);
  if (!menu) return { title: "Meni" };
  return {
    title: menu.restaurant.name,
    description: menu.restaurant.tagline ?? `Digitalni meni — ${menu.restaurant.name}`,
  };
}

export default async function PublicMenuPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { t } = await searchParams;
  const menu = await loadMenu(slug, t ?? null);
  if (!menu) notFound();
  return <PublicMenuView menu={menu} slug={slug} />;
}
