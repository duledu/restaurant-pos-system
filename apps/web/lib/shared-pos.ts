"use client";

/**
 * Browser-lokalne preferencije za Deljeni POS terminal — SAMO za UI odluke
 * (koji ekran prikazati, da li prikazati "Zaključaj" dugme, koliko dugo
 * čekati pre auto-lock-a). Server NIKAD ne veruje ovim vrednostima za
 * autorizaciju — deviceId mora postojati kao aktivan Device red u bazi
 * (proverava se u svakom PIN loginu), a svaka zaštićena akcija i dalje
 * prolazi kroz requireAuth() sa svežom sesijom. Brisanje ovih ključeva samo
 * menja UI ovog browsera; ne diže niti obara ništa na serveru.
 */

const DEVICE_ID_KEY = "rcs.deviceId";
const SHARED_POS_KEY = "rcs.sharedPosMode";
const AUTO_LOCK_KEY = "rcs.autoLockMs";

export const AUTO_LOCK_OPTIONS = [
  { label: "Isključeno", ms: 0 },
  { label: "30 sekundi", ms: 30_000 },
  { label: "1 minut", ms: 60_000 },
  { label: "2 minuta", ms: 120_000 },
  { label: "5 minuta", ms: 300_000 },
] as const;

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function getDeviceId(): string | null {
  return storage()?.getItem(DEVICE_ID_KEY) ?? null;
}

export function setDeviceId(deviceId: string): void {
  storage()?.setItem(DEVICE_ID_KEY, deviceId);
}

export function clearDevice(): void {
  const s = storage();
  s?.removeItem(DEVICE_ID_KEY);
  s?.removeItem(SHARED_POS_KEY);
  s?.removeItem(AUTO_LOCK_KEY);
}

export function isSharedPosMode(): boolean {
  return storage()?.getItem(SHARED_POS_KEY) === "1";
}

export function setSharedPosMode(enabled: boolean): void {
  const s = storage();
  if (!s) return;
  if (enabled) s.setItem(SHARED_POS_KEY, "1");
  else s.removeItem(SHARED_POS_KEY);
}

/** Podrazumevano isključeno (konzervativno) — vidi spec #17. */
export function getAutoLockMs(): number {
  const raw = storage()?.getItem(AUTO_LOCK_KEY);
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function setAutoLockMs(ms: number): void {
  storage()?.setItem(AUTO_LOCK_KEY, String(ms));
}
