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
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-line/80 pb-5">
      <div>
        <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-gold">TableCore operations</p>
        <h1 className="text-2xl font-bold tracking-[-0.025em] text-ink sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-5 text-inkSoft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
