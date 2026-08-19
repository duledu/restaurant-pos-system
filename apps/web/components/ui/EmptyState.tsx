export function EmptyState({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Manje unutrašnje razmake — za manje slotove koji se ponavljaju više
   * puta na istoj stranici (npr. prazan grafikon u nizu kartica), gde bi
   * podrazumevani py-16 kumulativno napravio utisak "polomljene" stranice. */
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-1.5 text-center animate-fade-in ${compact ? "py-8" : "py-16"}`}>
      <p className={`font-medium text-ink/50 ${compact ? "text-xs" : "text-sm"}`}>{title}</p>
      {description && <p className="max-w-sm text-xs text-inkSoft/80">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
