export function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border border-line bg-white shadow-card ${className}`}>{children}</div>
  );
}
