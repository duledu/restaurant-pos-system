"use client";

import { useEffect, useState } from "react";
import { OFFLINE_MESSAGE } from "../../lib/pwa";

/**
 * P3.1 #16/#17 — TableCore je ONLINE-FIRST: porudžbine/naplata/smene/PIN
 * prijava zahtevaju vezu sa serverom, NEMA offline reda čekanja za te
 * operacije (vidi napomenu u finalnom izveštaju P3.1). Ova traka je čisto
 * INFORMATIVNA — ne blokira UI (nije modal), samo jasno saopštava da veza
 * nedostaje, da korisnik ne bi pomislio da je akcija sačuvana kad nije.
 *
 * Namerno BEZ service worker-a — `navigator.onLine` + online/offline
 * eventovi su dovoljni za ovaj cilj i ne nose rizik keširanja poslovnih
 * podataka (specifikacija #3/#18).
 */
export function OfflineBanner() {
  // Počinje kao "online" (false) na serveru/pre hidracije — izbegava
  // hydration mismatch; efekat ispod odmah sinhronizuje sa stvarnim stanjem.
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(!navigator.onLine);
    const handleOffline = () => setOffline(true);
    const handleOnline = () => setOffline(false);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="sticky top-0 z-[100] flex items-center justify-center gap-2 bg-danger px-4 py-2 text-center text-sm font-medium text-white print:hidden"
    >
      <span aria-hidden="true">⚠</span>
      <span>{OFFLINE_MESSAGE}</span>
    </div>
  );
}
