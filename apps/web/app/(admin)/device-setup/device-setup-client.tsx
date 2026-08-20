"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import {
  AUTO_LOCK_OPTIONS,
  clearDevice,
  getAutoLockMs,
  getDeviceId,
  isSharedPosMode,
  setAutoLockMs,
  setDeviceId,
  setSharedPosMode,
} from "../../../lib/shared-pos";

interface LocationOption {
  id: string;
  name: string;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function DeviceSetupClient() {
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationId, setLocationId] = useState("");
  const [deviceId, setDeviceIdState] = useState<string | null>(null);
  const [sharedMode, setSharedModeState] = useState(false);
  const [autoLockMs, setAutoLockMsState] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshLocalState = useCallback(() => {
    setDeviceIdState(getDeviceId());
    setSharedModeState(isSharedPosMode());
    setAutoLockMsState(getAutoLockMs());
  }, []);

  useEffect(() => {
    // Uvek verifikuj localStorage deviceId sa serverom pre prikazivanja statusa
    // "Registrovan" — localStorage može sadržati zastareli UUID čiji Device red
    // više ne postoji u bazi (npr. posle brisanja uređaja ili obnavljanja baze).
    // Samo server je autoritativan izvor istine.
    const storedId = getDeviceId();
    if (storedId) {
      fetch(`/api/device/check?deviceId=${encodeURIComponent(storedId)}`)
        .then(async (r) => {
          if (!r.ok) {
            // Serverska greška (503 privremena nedostupnost, 5xx, itd.) —
            // NE brišemo localStorage. Samo potvrđen 200 { registered: false }
            // znači da server ZOVE uređaj nevažećim. Greška nije to.
            refreshLocalState();
            return;
          }
          const data: { registered?: boolean } = await r.json().catch(() => ({}));
          if (data.registered === false) {
            // Eksplicitna potvrda servera (HTTP 200) da uređaj nije aktivan —
            // tek tada brišemo zastareli localStorage ID.
            clearDevice();
          }
          refreshLocalState();
        })
        .catch(() => {
          // Mrežna greška ili parse greška — konzervativno: ne brišemo ništa.
          refreshLocalState();
        });
    } else {
      refreshLocalState();
    }

    apiFetch("/api/device/locations")
      .then((body) => {
        setLocations(body.locations);
        if (body.locations[0]) setLocationId(body.locations[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Greška"));
  }, [refreshLocalState]);

  async function register() {
    if (!locationId) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const body = await apiFetch("/api/device/register", {
        method: "POST",
        body: JSON.stringify({ locationId }),
      });
      setDeviceId(body.deviceId);
      refreshLocalState();
      setNotice("Ovaj uređaj je registrovan — PIN prijava je sada dostupna na njemu.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri registraciji uređaja");
    } finally {
      setLoading(false);
    }
  }

  function toggleSharedMode(enabled: boolean) {
    setSharedPosMode(enabled);
    refreshLocalState();
  }

  function changeAutoLock(ms: number) {
    setAutoLockMs(ms);
    refreshLocalState();
  }

  function resetDevice() {
    clearDevice();
    refreshLocalState();
    setNotice("Registracija ovog uređaja je poništena — vraćen je na prijavu email/lozinkom.");
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-2xl font-semibold text-ink">Podešavanje terminala</h1>
      <p className="mb-6 text-sm text-inkSoft">
        Registruj ovaj konkretan browser/uređaj za PIN prijavu — konobari, kuhinja i šank se onda prijavljuju brzim
        PIN kodom umesto email/lozinke. Radi za lične telefone/tablete i za deljeni POS terminal.
      </p>

      {error && <div className="mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
      {notice && <div className="mb-4 rounded-md bg-success-soft px-3 py-2 text-sm text-success">{notice}</div>}

      <Card className="mb-4 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Status ovog uređaja</h2>
          {deviceId ? <Badge tone="success">Registrovan</Badge> : <Badge tone="neutral">Nije registrovan</Badge>}
        </div>

        {deviceId ? (
          <div className="space-y-4">
            <p className="text-xs text-inkSoft">ID uređaja: {deviceId}</p>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={sharedMode} onChange={(e) => toggleSharedMode(e.target.checked)} />
              Deljeni POS režim (prikazuje dugme „Zaključaj“ u konobarskom radu)
            </label>

            {sharedMode && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-inkSoft">Automatsko zaključavanje</label>
                <select
                  className="h-10 rounded-md border border-line px-3 text-sm text-ink"
                  value={autoLockMs}
                  onChange={(e) => changeAutoLock(Number(e.target.value))}
                >
                  {AUTO_LOCK_OPTIONS.map((opt) => (
                    <option key={opt.ms} value={opt.ms}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-inkSoft">
                  Zaključava terminal posle perioda bez dodira/klika — ne zatvara smenu niti menja porudžbine.
                </p>
              </div>
            )}

            <Button variant="secondary" size="sm" onClick={resetDevice}>
              Poništi registraciju ovog uređaja
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-inkSoft">Lokacija</label>
              <select
                className="h-10 w-full rounded-md border border-line px-3 text-sm text-ink"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={register} loading={loading} disabled={!locationId}>
              Registruj ovaj uređaj
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-2 text-sm font-semibold text-ink">Kako ovo funkcioniše</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-inkSoft">
          <li>Registracija je jednokratna po uređaju/browseru — traje dok neko ne klikne „Poništi registraciju“.</li>
          <li>Svaki zaposleni se i dalje prijavljuje svojim ličnim PIN-om — nema deljenih naloga.</li>
          <li>Deljeni POS režim je samo podešavanje ovog browsera — ne utiče na prava pristupa, ona se uvek proveravaju na serveru.</li>
          <li>Deaktivacija zaposlenog (Osoblje) odmah blokira njegov PIN, uključujući na ovom uređaju.</li>
        </ul>
      </Card>
    </div>
  );
}
