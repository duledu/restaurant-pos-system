import { QrMenuClient } from "./qr-menu-client";

export default function QrMenuPage() {
  return (
    <div className="w-full">
      <div className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink">QR Meni</h1>
          <p className="mt-1 text-sm text-ink/60">Brendiran digitalni meni za goste — isti podaci kao u Meniju, samo sa izgledom vašeg restorana.</p>
        </div>
      </div>
      <QrMenuClient />
    </div>
  );
}
