type Tone = "neutral" | "success" | "warn" | "danger" | "info" | "gold";

const TONE_STYLES: Record<Tone, string> = {
  neutral: "bg-ink/[0.06] text-inkSoft",
  success: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  gold: "bg-gold-soft text-gold-dark",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_STYLES[tone]}`}>
      {children}
    </span>
  );
}
