"use client";

import { useEffect, useState } from "react";

/**
 * Na ekranu nevidljiv, u štampi vidljiv zaglavni blok za sve menadžerske
 * izveštaje (zahtev #24: naziv restorana/izveštaja/period/vreme generisanja).
 * Vidi .print-report-header u print-report.css.
 *
 * "Generisano" vreme se namerno računa TEK posle mount-a (useEffect), ne
 * direktno u render-u — `new Date()` u render-u proizvodi različitu
 * vrednost na serveru (SSR) i klijentu (hidracija), što izaziva React
 * hydration mismatch. Ovaj blok je i dalje CSS-sakriven na ekranu (vidljiv
 * samo pri štampi), pa kratkotrajni prazan navod pre mount-a nije vidljiv.
 */
export function ReportPrintHeader({
  restaurantName = "TableCore",
  title,
  periodLabel,
  generatedBy,
}: {
  restaurantName?: string;
  title: string;
  periodLabel: string;
  generatedBy?: string;
}) {
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  useEffect(() => {
    setGeneratedAt(new Date().toLocaleString("sr-RS"));
  }, []);

  return (
    <div className="print-report-header">
      <div className="pr-restaurant">{restaurantName}</div>
      <div className="pr-title">{title}</div>
      <div className="pr-meta">Period: {periodLabel}</div>
      <div className="pr-meta">Generisano: {generatedAt ?? "—"}</div>
      {generatedBy && <div className="pr-meta">Generisao: {generatedBy}</div>}
    </div>
  );
}
