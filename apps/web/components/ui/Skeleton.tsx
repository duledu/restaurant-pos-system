export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse-soft rounded-sm bg-ink/[0.06] ${className}`} />;
}
