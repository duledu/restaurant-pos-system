"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppLogo } from "../components/branding/AppLogo";
import { useShiftPreparation, type PreparationResult, type PreparationStage } from "./waiter-shift-preparation";
import { readAvailability } from "./waiter-menu";
import { myReadyItemIds, hasNewReadyId } from "./ready-notifications";
import { createWaiterLocalDraft, type WaiterLocalDraft } from "./waiter-local-draft";
import { createWaiterFavorites } from "./waiter-table-memory";

async function apiFetch(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Osvežavanje nije uspelo");
  return res.json();
}

export interface WaiterShellContextValue {
  data: PreparationResult;
  setFloors: (floors: PreparationResult["floors"]) => void;
  setShift: (shift: PreparationResult["shift"]) => void;
  refreshAvailability: () => Promise<void>;
  readySoundOn: boolean;
  toggleReadySound: () => void;
  getDraft: (tableId: string) => WaiterLocalDraft;
  favorites: ReturnType<typeof createWaiterFavorites>;
}
const WaiterShellContext = createContext<WaiterShellContextValue | null>(null);
export function useWaiterShell() {
  const value = useContext(WaiterShellContext);
  if (!value) throw new Error("WaiterShellProvider nije spreman");
  return value;
}

const STAGE_MESSAGES: Record<PreparationStage, string> = {
  identity: "Pripremamo vašu smenu…",
  menu: "Preuzimamo najnovije izmene…",
  availability: "Usklađujemo meni i dostupnost…",
  tables: "Pripremamo stolove i aktivne porudžbine…",
  ready: "Smena je spremna",
};


// Only this route subtree owns prepared data. Logout/lock replace the document.
export function WaiterShellProvider({ children }: { children: ReactNode }) {
  const { state, run } = useShiftPreparation();
  useEffect(() => { run(); }, [run]);
  if (state.status === "error") return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <AppLogo variant="mark" size="md" />
      <p>Ne možemo da završimo pripremu smene.</p>
      <p>Proverite vezu i pokušajte ponovo.</p>
      <button type="button" onClick={run} className="min-h-11 rounded-md bg-graphite px-5 py-3 text-white">Pokušaj ponovo</button>
    </div>
  );
  if (state.status !== "ready") return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <AppLogo variant="mark" size="md" />
      <p>{STAGE_MESSAGES[state.stage]}</p>
    </div>
  );
  return <PreparedShell key={`${state.data.restaurantId}:${state.data.locationId}:${state.data.employeeId}`} initial={state.data}>{children}</PreparedShell>;
}

const SOUND_KEY = "tablecore.waiterReadySound";
function PreparedShell({ initial, children }: { initial: PreparationResult; children: ReactNode }) {
  const [favorites] = useState(createWaiterFavorites);
  useEffect(() => () => favorites.clear(), [favorites]);
  const drafts = useRef(new Map<string, WaiterLocalDraft>());
  const getDraft = useCallback((tableId: string) => {
    let draft = drafts.current.get(tableId);
    if (!draft) { draft = createWaiterLocalDraft(); drafts.current.set(tableId, draft); }
    return draft;
  }, []);
  const [data, setData] = useState(initial);
  const [readySoundOn, setReadySoundOn] = useState(true);
  const [notice, setNotice] = useState("Smena je spremna");
  const audioRef = useRef<AudioContext | null>(null);
  const alive = useRef(true);
  const availabilityRequest = useRef<Promise<void> | null>(null);
  const knownReadyIds = useRef(myReadyItemIds(initial.floors.flatMap(f => f.tables), initial.employeeId));
  const { locationId } = initial;

  useEffect(() => {
    alive.current = true;
    try { setReadySoundOn(localStorage.getItem(SOUND_KEY) !== "off"); } catch { /* use default */ }
    // Unlock audio in a user gesture, before a background READY event arrives.
    const unlock = () => {
      try {
        audioRef.current ??= new AudioContext();
        void audioRef.current.resume().catch(() => {});
      } catch { /* Visual notification remains available. */ }
    };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    window.addEventListener("pageshow", restore);
    return () => {
      alive.current = false;
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("pageshow", restore);
      void audioRef.current?.close().catch(() => {});
      audioRef.current = null;
    };
  }, []);

  const toggleReadySound = useCallback(() => {
    setReadySoundOn(previous => {
      const next = !previous;
      try { localStorage.setItem(SOUND_KEY, next ? "on" : "off"); } catch { /* memory preference still works */ }
      return next;
    });
  }, []);

  useEffect(() => {
    const next = myReadyItemIds(data.floors.flatMap(f => f.tables), data.employeeId);
    if (hasNewReadyId(knownReadyIds.current, next)) {
      setNotice("Porudžbina je spremna za preuzimanje");
      if (readySoundOn) {
        try {
          const ctx = audioRef.current ??= new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.value = 660;
          gain.gain.setValueAtTime(0.12, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
          osc.connect(gain).connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.35);
        } catch { /* Visual notification remains available. */ }
      }
    }
    knownReadyIds.current = next;
  }, [data.floors, data.employeeId, readySoundOn]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let active = true;
    let pending = false;
    const interval = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await apiFetch(`/api/pos/tables?locationId=${encodeURIComponent(locationId)}`);
        if (!Array.isArray(result.floors)) throw new Error("Stolovi nisu potpuni");
        if (active) setData(previous => ({ ...previous, floors: result.floors }));
      } catch { /* Keep last authoritative floors. */ }
      finally { pending = false; }
    }, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [locationId]);

  const refreshAvailability = useCallback((): Promise<void> => {
    if (availabilityRequest.current) return availabilityRequest.current;
    const request = (async () => {
      try {
        const result = await apiFetch(`/api/pos/menu/availability?locationId=${encodeURIComponent(locationId)}`);
        const overlay = readAvailability(result, locationId, initial.items);
        if (alive.current) setData(previous => ({ ...previous, availabilityByItemId: overlay }));
      } catch { /* Failed or incomplete snapshots must retain the last authoritative map. */ }
    })();
    availabilityRequest.current = request;
    void request.finally(() => { availabilityRequest.current = null; });
    return request;
  }, [locationId, initial.items]);

  const setFloors = useCallback((floors: PreparationResult["floors"]) => setData(previous => ({ ...previous, floors })), []);
  const setShift = useCallback((shift: PreparationResult["shift"]) => setData(previous => ({ ...previous, shift })), []);
  const value = useMemo(() => ({ data, setFloors, setShift, refreshAvailability, readySoundOn, toggleReadySound, getDraft, favorites }),
    [data, setFloors, setShift, refreshAvailability, readySoundOn, toggleReadySound, getDraft, favorites]);
  return <WaiterShellContext.Provider value={value}>
    {notice && <div role="status" className="fixed right-3 top-3 z-50 rounded-md bg-gold-soft px-4 py-3 text-sm text-gold-dark shadow-card">{notice}</div>}
    {children}
  </WaiterShellContext.Provider>;
}
