/**
 * Standardni obrazac zaglavlja za svaki admin ekran — naslov + opcioni opis
 * levo, primarna/sekundarne akcije desno, dosledno poravnanje na svim
 * širinama (wrap na mobilnom umesto sažimanja u uzane kolone).
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-inkSoft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
