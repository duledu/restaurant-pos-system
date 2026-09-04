"use client";

import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { ROLE_LABEL } from "../admin/role-labels";

export interface EmployeeStationRow {
  employeeId: string;
  employeeName: string;
  role: string;
  acceptedCount: number;
  readyCount: number;
}

/**
 * Faza 12 — po-zaposlenom pregled kuhinjske/šank aktivnosti (koliko je ko
 * PRIHVATIO / označio SPREMNIM u periodu). Deljeno između Admin izveštaja
 * (Kuhinja/Bar, koji dodatno ima i pregled po artiklima) i same
 * Kuhinje/Šanka (koji vidi SAMO ovaj deo, bez Admin okruženja).
 */
export function StationEmployeeTable({
  employees,
  employeeTotals,
}: {
  employees: EmployeeStationRow[];
  employeeTotals: { acceptedCount: number; readyCount: number };
}) {
  return (
    <Card className="overflow-hidden">
      {employees.length === 0 ? (
        <div className="p-5">
          <EmptyState title="Nema evidentirane aktivnosti zaposlenih u izabranom periodu." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                <th className="px-4 py-3 font-medium">Zaposleni</th>
                <th className="px-4 py-3 text-right font-medium">Prihvaćeno</th>
                <th className="px-4 py-3 text-right font-medium">Spremno</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.employeeId} className="border-b border-line last:border-0 hover:bg-ink/[0.02]">
                  <td className="px-4 py-3 text-ink">
                    {e.employeeName} <span className="text-xs text-inkSoft">— {ROLE_LABEL[e.role] ?? e.role}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink">{e.acceptedCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-ink">{e.readyCount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line bg-ink/[0.02]">
                <td className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-inkSoft">Ukupno</td>
                <td className="px-4 py-3 text-right tabular-nums font-semibold text-ink">{employeeTotals.acceptedCount}</td>
                <td className="px-4 py-3 text-right tabular-nums font-semibold text-ink">{employeeTotals.readyCount}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}
