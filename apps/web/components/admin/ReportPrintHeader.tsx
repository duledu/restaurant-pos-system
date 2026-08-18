/**
 * Na ekranu nevidljiv, u štampi vidljiv zaglavni blok za sve menadžerske
 * izveštaje (zahtev #24: naziv restorana/izveštaja/period/vreme generisanja).
 * Vidi .print-report-header u print-report.css.
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
  return (
    <div className="print-report-header">
      <div className="pr-restaurant">{restaurantName}</div>
      <div className="pr-title">{title}</div>
      <div className="pr-meta">Period: {periodLabel}</div>
      <div className="pr-meta">Generisano: {new Date().toLocaleString("sr-RS")}</div>
      {generatedBy && <div className="pr-meta">Generisao: {generatedBy}</div>}
    </div>
  );
}
