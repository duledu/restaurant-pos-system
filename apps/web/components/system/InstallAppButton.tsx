"use client";

import { useEffect, useState } from "react";
import { canShowInstallCta, isStandaloneDisplay } from "../../lib/pwa";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/**
 * P3.1 #13/#14/#15 — feature-detektovano stanje instalacije, logika u
 * lib/pwa.ts (unit-testabilna bez DOM-a). `canInstall` je `true` SAMO kad je
 * browser stvarno emitovao `beforeinstallprompt` (Chrome/Edge/Android) —
 * Safari/iOS ovaj event nikad ne šalje, pa ostaje `false` tamo (ne
 * pretpostavlja se lažna podrška). Postaje `false` i posle uspešne
 * instalacije (`appinstalled`) ili posle korišćenja prompt-a, i odmah pri
 * mount-u ako je aplikacija VEĆ pokrenuta u standalone režimu.
 *
 * Ne menja RBAC niti poslovno ponašanje — čisto UI/instalacioni afordans.
 */
export function useInstallPrompt() {
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    setInstalled(
      isStandaloneDisplay({
        matchesStandaloneMediaQuery: window.matchMedia("(display-mode: standalone)").matches,
        iosStandalone: (window.navigator as Navigator & { standalone?: boolean }).standalone,
      })
    );

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredEvent(e as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setInstalled(true);
      setDeferredEvent(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  async function promptInstall() {
    if (!deferredEvent) return;
    await deferredEvent.prompt();
    await deferredEvent.userChoice;
    // Prompt se sme koristiti samo jednom po event instanci.
    setDeferredEvent(null);
  }

  return { canInstall: canShowInstallCta({ isInstalled: installed, hasDeferredPrompt: deferredEvent !== null }), promptInstall };
}

export function InstallAppButton({ className }: { className?: string }) {
  const { canInstall, promptInstall } = useInstallPrompt();
  if (!canInstall) return null;

  return (
    <button type="button" onClick={promptInstall} className={className}>
      Instaliraj TableCore aplikaciju
    </button>
  );
}
