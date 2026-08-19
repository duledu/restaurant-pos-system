export function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border border-line/80 bg-white shadow-card ${className}`}>{children}</div>
  );
}
