import { Card } from "../ui/Card";

export function KpiCard({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <Card className={`p-5 ${accent ? "border-gold/40 bg-gold/[0.04]" : ""}`}>
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-inkSoft">{label}</p>
      <p className={`text-2xl font-bold tabular-nums leading-tight ${accent ? "text-gold-dark" : "text-ink"} sm:text-3xl`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-inkSoft">{sub}</p>}
    </Card>
  );
}
