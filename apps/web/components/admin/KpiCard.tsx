import { Card } from "../ui/Card";

export function KpiCard({
  label,
  value,
  sub,
  accent = false,
  changePercent,
  changeLabel = "vs prethodni period",
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  /** Faza 7 — % promena naspram prethodnog uporedivog perioda. `undefined`
   * (nikad 0 kao placeholder) kad poređenje nije dostupno — ne prikazuje se
   * ništa umesto lažne vrednosti (zahtev #1: "Do not show fake percentage
   * changes when previous-period data is unavailable"). */
  changePercent?: number | null;
  changeLabel?: string;
}) {
  return (
    <Card className={`relative overflow-hidden p-3.5 sm:p-5 ${accent ? "border-gold/50 bg-gradient-to-br from-white to-gold-soft/40" : ""}`}>
      {accent && <span className="absolute inset-y-0 left-0 w-1 bg-gold" aria-hidden="true" />}
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-inkSoft sm:text-xs">{label}</p>
      <p className={`break-words text-xl font-bold tabular-nums leading-tight tracking-[-0.03em] ${accent ? "text-ink" : "text-ink"} sm:text-3xl`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-inkSoft">{sub}</p>}
      {changePercent !== undefined && changePercent !== null && (
        <p className={`mt-1.5 text-xs font-semibold ${changePercent >= 0 ? "text-success" : "text-danger"}`}>
          {changePercent >= 0 ? "↑" : "↓"} {Math.abs(changePercent)}% <span className="font-normal text-inkSoft">{changeLabel}</span>
        </p>
      )}
    </Card>
  );
}
