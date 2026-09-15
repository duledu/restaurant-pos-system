"use client";

import { useEffect, useState, useCallback, useRef, memo } from "react";
import Link from "next/link";
import { LogoutButton } from "../ui/LogoutButton";
import { AppLogo } from "../branding/AppLogo";
import { TicketPrintPanel, type TicketContent } from "../printing/TicketPrintPanel";
import { getOrFetch, CLIENT_CACHE_KEYS, CLIENT_CACHE_TTL_MS } from "../../lib/client-cache";
import {
  fetchPrintJobs,
  requestStationPrint,
  printAndConfirm,
  beginPrintJob,
  fetchPendingStationPrintJobs,
  retryPrintJob,
  type PrintJob,
  type StationPrinterStatus,
} from "../../lib/print-client";
import { defaultPrintTransport, type PrintTransport } from "../../lib/print-transport";
import { resolveAutoPrintTransport } from "../../lib/qz-auto-transport";
import { getQzSettings } from "../../lib/qz-settings";
import { ticketWaitBasis } from "../../lib/kds-wait-time";
import { nextPaint, reportKdsTapTiming, type KdsTapTiming } from "../../lib/kds-perf";

interface StationItemModifier {
  id: string;
  optionName: string;
  priceDelta: string;
}
interface StationItem {
  id: string;
  name: string;
  quantity: number;
  note: string | null;
  status: "SUBMITTED" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  modifiers: StationItemModifier[];
  // Per-round timestamp — see kds-wait-time.ts. NOT the same as the order's
  // own submittedAt, which only reflects the table's FIRST-ever round.
  submittedAt: string | null;
}

/** Dodaci moraju biti odmah uočljivi na KDS-u (specifikacija #16/#52) — "+"
 * prefiks se određuje po CENI (priceDelta > 0), ne parsiranjem naziva. */
function ModifierList({ modifiers, tone }: { modifiers: StationItemModifier[]; tone: "active" | "completed" }) {
  if (modifiers.length === 0) return null;
  return (
    <ul className={`mt-1 space-y-0.5 border-l-2 pl-2 ${tone === "active" ? "border-gold/50" : "border-white/10"}`}>
      {modifiers.map((m) => (
        <li key={m.id} className={`text-xs font-semibold ${tone === "active" ? "text-gold" : "text-cream-300/60"}`}>
          {Number(m.priceDelta) > 0 ? `+ ${m.optionName}` : m.optionName}
        </li>
      ))}
    </ul>
  );
}
interface StationOrder {
  orderId: string;
  tableLabel: string;
  waiterName: string;
  submittedAt: string | null;
  items: StationItem[];
}
interface CompletedOrder extends StationOrder {
  completedAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Novo",
  ACCEPTED: "Prihvaćeno",
  PREPARING: "U pripremi",
  READY: "Spremno",
};

// UPROŠĆEN TOK (Faza 10): PRIHVATI -> SPREMNO direktno, "Počni pripremu"
// korak je uklonjen iz radnog toka (server: production-service.ts
// NEXT_STATUS). PREPARING i dalje ima dugme radi unazadne kompatibilnosti
// SAMO za stavke koje su VEĆ bile u tom stanju pre ovog deploy-a. READY
// NEMA dugme ovde — preuzimanje je sada isključivo konobarska radnja (vidi
// order-client.tsx "SPREMNO ZA PREUZIMANJE"), ne kuhinjska/šank.
const STATUS_ACTION_LABEL: Record<string, string> = {
  SUBMITTED: "Prihvati",
  ACCEPTED: "Označi spremno",
  PREPARING: "Označi spremno",
};

// Hardening/performance audit — MORA se poklapati sa NEXT_STATUS u
// production-service.ts. Namerno dupliran (mali, stabilan, 3-unosni
// mapping) da klik na dugme može ODMAH da pomeri status lokalno, bez
// čekanja na network round-trip — pravi server odgovor (advance rute
// `{item}`) svejedno se koristi za konačno pomirenje ispod, pa čak i da
// ova mapa ikad promaši, korisnik odmah posle vidi TAČNO stanje sa
// servera, nikad trajno pogrešno.
const NEXT_STATUS_CLIENT: Record<string, StationItem["status"]> = {
  SUBMITTED: "ACCEPTED",
  ACCEPTED: "READY",
  PREPARING: "READY",
};
// Mora se poklapati sa PENDING_PRODUCTION_STATUSES u production-service.ts
// — određuje kad porudžbina nestaje sa Aktivne (sve stavke ove stanice su
// bar READY) ODMAH, bez čekanja na sledeći poll da je server-strani filter
// istog imena povuče u Gotove.
const PENDING_STATION_STATUSES_CLIENT = new Set(["SUBMITTED", "ACCEPTED", "PREPARING"]);

const STATUS_BADGE: Record<string, string> = {
  SUBMITTED: "bg-gold-soft text-gold-dark",
  ACCEPTED: "bg-gold text-white",
  PREPARING: "bg-warn text-white",
  READY: "bg-success text-white",
};

interface ApiError extends Error {
  status?: number;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Physical QA follow-up — the status code (specifically 409, see
    // production-service.ts StaleItemStatusError) must survive past this
    // helper so advance() below can tell "stale-status conflict, safe to
    // auto-reconcile" apart from every other failure.
    const error: ApiError = new Error(body.error ?? `Greška (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return body;
}

function minutesSince(iso: string | null): number {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" });
}

// PREPROD physical QA follow-up (Part I) — poznat, već autentifikovan
// identitet zaposlenog (isti /api/pos/me poziv koji KDS VEĆ radi za
// locationIds — nikad drugi/dupliran izvor identiteta), preveden u kratke
// oznake za prikaz. Menadžerske uloge se prikazuju kao "MENADŽER" bez
// obzira na tačnu (OWNER/ADMIN/MANAGER) ulogu — KDS ekran ne treba da
// razlikuje te tri, samo da pokaže ZAŠTO ta osoba ima pristup.
const ROLE_LABEL: Record<string, string> = {
  KITCHEN: "KUHINJA",
  BAR: "ŠANK",
  WAITER: "KONOBAR",
  OWNER: "MENADŽER",
  ADMIN: "MENADŽER",
  MANAGER: "MENADŽER",
};
interface EmployeeIdentity {
  firstName: string | null;
  lastName: string | null;
  roles: string[];
}
function employeeRoleDisplay(roles: string[]): string {
  const labels = Array.from(new Set(roles.map((r) => ROLE_LABEL[r] ?? r)));
  return labels.join(" / ");
}

interface ItemRowProps {
  item: StationItem;
  onAdvance: (itemId: string, expectedStatus: StationItem["status"]) => Promise<void>;
}
/**
 * PREPROD physical QA follow-up (Part D) — izdvojeno i memoizovano da
 * TAP na JEDNU stavku nikad ne ponovo renderuje CEO tablu (svaku
 * porudžbinu, svaku drugu stavku). "Zauzeto dok čeka odgovor" je SADA
 * lokalno stanje OVE komponente (ref za sinhronu zaštitu od duplog tapa
 * PRE ijednog re-rendera, isto obrazloženje kao ranije na nivou table —
 * useState samo za disabled izgled dugmeta) — React garantuje da lokalni
 * setState jedne komponente NIKAD ne ponovo renderuje roditelja ili
 * susedne komponente, za razliku od ranijeg deljenog Set-a na vrhu table
 * (svaki tap je menjao TAJ Set, što je ponovo renderovalo SVAKU stavku na
 * ekranu). Sama promena STATUSA (item.status) i dalje dolazi odozgo kao
 * prop — KdsClient.applyItemStatus već čuva referencu nepromenjenih
 * stavki/porudžbina (`: it` / `return o`), pa memo ispod ispravno
 * preskače re-render za stavke koje se nisu promenile.
 */
const ItemRow = memo(function ItemRow({ item, onAdvance }: ItemRowProps) {
  const [isBusy, setIsBusy] = useState(false);
  const inFlightRef = useRef(false);

  async function handleClick() {
    // Sinhrona zaštita od duplog tapa PRE ijednog await-a/re-rendera —
    // isti obrazac kao ranije, sada po-stavci umesto deljen.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsBusy(true);
    try {
      await onAdvance(item.id, item.status);
    } finally {
      inFlightRef.current = false;
      setIsBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-white/[.06] bg-graphite-800 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base font-semibold leading-snug text-cream-100">
            {item.quantity}× {item.name}
          </div>
          <ModifierList modifiers={item.modifiers} tone="active" />
          {item.note && <div className="mt-0.5 text-xs italic text-cream-300/70">{item.note}</div>}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[item.status] ?? "bg-graphite text-cream-100"}`}>
          {STATUS_LABEL[item.status] ?? item.status}
        </span>
      </div>
      {STATUS_ACTION_LABEL[item.status] && (
        <button
          onClick={handleClick}
          disabled={isBusy}
          className="mt-3 min-h-11 w-full rounded-md bg-gold py-2 text-sm font-bold text-white transition-colors hover:bg-gold-dark active:translate-y-px disabled:opacity-40"
        >
          {STATUS_ACTION_LABEL[item.status]}
        </button>
      )}
    </div>
  );
});

interface OrderCardProps {
  order: StationOrder;
  waitMin: number;
  isLate: boolean;
  failedJob: PrintJob | undefined;
  printBusy: boolean;
  retryBusy: boolean;
  onPrintTicket: (orderId: string) => void;
  onRetryPrint: (orderId: string, jobId: string) => void;
  onAdvance: (orderId: string, itemId: string, expectedStatus: StationItem["status"]) => Promise<void>;
}
/**
 * PREPROD physical QA follow-up (Part D) — isti razlog kao ItemRow iznad,
 * jedan nivo više: memoizovano da promena JEDNE porudžbine (ili globalnog
 * stanja poput printBusyId za DRUGU porudžbinu) ne ponovo renderuje SVE
 * ostale kartice. `onAdvance` je zatvorena vrednost specifična za OVU
 * porudžbinu (orderId već vezan) — i dalje stabilna preko roditeljevog
 * useCallback-a, pa memo ispod ispravno radi.
 */
const OrderCard = memo(function OrderCard({ order, waitMin, isLate, failedJob, printBusy, retryBusy, onPrintTicket, onRetryPrint, onAdvance }: OrderCardProps) {
  const handleAdvance = useCallback(
    (itemId: string, expectedStatus: StationItem["status"]) => onAdvance(order.orderId, itemId, expectedStatus),
    [order.orderId, onAdvance]
  );
  return (
    <div className={`overflow-hidden rounded-lg border bg-graphite-700 shadow-[0_12px_28px_rgba(0,0,0,.22)] ${isLate ? "border-warn" : "border-graphite-700"}`}>
      <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-black/10 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-xl font-bold tracking-tight text-cream-100">{order.tableLabel}</div>
          <div className="truncate text-xs font-medium text-cream-300/70">Konobar · {order.waiterName}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-md px-2.5 py-1 text-xs font-bold tabular-nums ${isLate ? "bg-warn text-white" : "bg-graphite-800 text-cream-300/80"}`}>
            {waitMin} min
          </span>
          <button
            type="button"
            onClick={() => onPrintTicket(order.orderId)}
            disabled={printBusy}
            title="Štampaj tiket"
            aria-label="Štampaj tiket"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-graphite-800 text-cream-300/80 hover:bg-graphite-900 disabled:opacity-40"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z" /></svg>
          </button>
        </div>
      </div>

      {failedJob && (
        <div className="flex items-center justify-between gap-2 border-b border-danger/20 bg-danger-soft px-4 py-2">
          <span className="text-xs font-semibold text-danger">{failedJob.resultOutcome !== "FAILED_BEFORE_SUBMISSION" ? "Ishod štampe nije poznat — proverite papir pre novog otiska" : "Štampa nije uspela pre slanja"}</span>
          <button
            type="button"
            onClick={() => onRetryPrint(order.orderId, failedJob.id)}
            disabled={retryBusy}
            className="min-h-8 shrink-0 rounded-md bg-danger px-3 py-1 text-xs font-bold text-white disabled:opacity-40"
          >
            {retryBusy ? "…" : failedJob.resultOutcome !== "FAILED_BEFORE_SUBMISSION" ? "Provereno — novi otisak" : "Pokušaj ponovo"}
          </button>
        </div>
      )}

      <div className="space-y-2 p-3">
        {order.items.map((item) => (
          <ItemRow key={item.id} item={item} onAdvance={handleAdvance} />
        ))}
      </div>
    </div>
  );
});

export function KdsClient({ station, title, environmentLabel }: { station: "KITCHEN" | "BAR"; title: string; environmentLabel: string }) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [tab, setTab] = useState<"active" | "completed">("active");
  const [orders, setOrders] = useState<StationOrder[]>([]);
  const [completedOrders, setCompletedOrders] = useState<CompletedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const knownOrderIds = useRef<Set<string>>(new Set());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [printBusyId, setPrintBusyId] = useState<string | null>(null);
  // PREPROD physical QA follow-up (Part D) — "zauzeto dok se čeka odgovor"
  // je SADA lokalno stanje unutar ItemRow (vidi definiciju iznad), ne
  // deljen Set ovde — deljen Set je značio da SVAKI tap ponovo renderuje
  // SVAKU stavku na ekranu (React.memo ispod ne bi mogao da to spreči jer
  // bi Set-ova referenca menjala IDENTITET tog prop-a za svaku karticu).
  // Duplog-tapa zaštita je istim razlogom sada po-stavci (ItemRow-ov
  // sopstveni ref), ne ovde.
  // PREPROD physical QA follow-up (Part I) — poznat identitet ulogovanog
  // zaposlenog, popunjen TAČNO iz istog /api/pos/me poziva koji load()
  // već radi za locationId (nikad drugi/dupliran izvor, nikad dodatan
  // upit) — vidi load() ispod.
  const [employee, setEmployee] = useState<EmployeeIdentity | null>(null);
  const [pendingPrint, setPendingPrint] = useState<{ orderId: string; job: PrintJob; transport?: PrintTransport } | null>(null);
  const [failedPrintJobs, setFailedPrintJobs] = useState<PrintJob[]>([]);
  const [retryBusyId, setRetryBusyId] = useState<string | null>(null);
  // Problem 3 ispravka — server-autoritativan izvor za prikaz spremnosti
  // štampača (Print Agent Workstation stanje), NIKAD QZ/browser
  // localStorage (koje je po-računaru, ne server-strano, i nije relevantno
  // dok Print Agent postoji kao stvaran automatski put). getQzSettings
  // ostaje korišćen NIŽE u fajlu isključivo za stvarnu rezervnu (fallback)
  // transport odluku kad Print Agent NIJE aktivan za ovu stanicu.
  const [printerStatus, setPrinterStatus] = useState<StationPrinterStatus>({
    hasWorkstation: false,
    isOnline: false,
    state: "NOT_CONFIGURED",
  });
  // Part 13 hardening — po-poslu signal iz iste ruta (ne posebna logika).
  const [hasRecentFailure, setHasRecentFailure] = useState(false);

  // AUTOMATSKA ŠTAMPA (zahtev #1/#3): red čekanja + reference umesto state-a
  // za "print u toku" — `load` je stabilan useCallback (isti interval
  // nikad se ne re-subscribe-uje), pa bi čitanje React state-a unutar
  // njegove zatvorene funkcije videlo ZASTARELU (uvek-početnu) vrednost;
  // ref.current je uvek svež bez obzira koja zatvorena funkcija ga čita.
  const printInFlightRef = useRef(false);
  const printDoneResolveRef = useRef<(() => void) | null>(null);
  const autoQueueRef = useRef<{ orderId: string; job: PrintJob }[]>([]);
  const autoSeenRef = useRef<Set<string>>(new Set());
  const autoBusyRef = useRef(false);

  const processAutoQueue = useCallback(() => {
    if (autoBusyRef.current || printInFlightRef.current) return;
    const next = autoQueueRef.current.shift();
    if (!next) return;
    autoBusyRef.current = true;
    printInFlightRef.current = true;
    (async () => {
      try {
        // Atomski "claim" (PENDING -> PRINTING) TAČNO PRE window.print()-a —
        // ako je 0 redova pogođeno, neko/nešto drugo je već preuzelo ovaj
        // tiket (refresh, drugi tab, prethodni poll ciklus) — tiho odustani,
        // NIKAD ne štampaj ponovo isti tiket (zahtev #3, idempotentnost).
        const claimed = await beginPrintJob(next.orderId, next.job.id);
        if (claimed) {
          // P0.16: bira QZ direktnu štampu ako je uređaj tako podešen I QZ
          // je stvarno dostupan SADA — vidi qz-auto-transport.ts za tačno
          // pravilo (QZ nedostupan -> tih povratak na browser; QZ povezan
          // ali sam ispis ne uspe -> greška se NE guta, ide u FAILED).
          const transport = await resolveAutoPrintTransport(getQzSettings(), claimed.content);
          await new Promise<void>((resolve) => {
            printDoneResolveRef.current = resolve;
            setPendingPrint({ orderId: next.orderId, job: claimed, transport });
          });
        } else {
          printInFlightRef.current = false;
        }
      } catch (e) {
        printInFlightRef.current = false;
        setError(e instanceof Error ? e.message : "Greška pri automatskoj štampi");
      } finally {
        autoBusyRef.current = false;
        processAutoQueue();
      }
    })();
  }, []);

  const baseEndpoint = station === "KITCHEN" ? "/api/production/kitchen" : "/api/production/bar";

  function beep() {
    try {
      audioCtxRef.current ??= new AudioContext();
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch {
      // Audio nije podržan/dozvoljen u ovom browseru — tiho preskoči
    }
  }

  // Performance/correctness audit (Part 11) — setInterval ne čeka da
  // prethodni load() završi; pod usporenim odgovorom (spor Neon/Vercel
  // hladan start, ili teška fetchPendingStationPrintJobs tranzakcija) DVA
  // poziva mogu biti istovremeno u letu, a mrežni jitter može dovesti do
  // toga da STARIJI odgovor stigne POSLE novijeg i prepiše sveže stanje
  // (setOrders je pun replace, ne merge). Ovaj ref je jednostavna brava:
  // ako je poll već u toku, sledeći (interval ili eksplicitan) poziv se
  // tiho preskače umesto da se gomila — sledeći ciklus za 4s je dovoljan.
  const loadInFlightRef = useRef(false);

  // PREPROD physical QA follow-up — real-device root cause trace (see
  // advance()/applyItemStatus below for the full writeup): a poll GET can
  // be issued BEFORE a tap and resolve AFTER that tap's optimistic+confirmed
  // update; setOrders(freshOrders) as a blind full replace would then
  // silently revert that item to the stale pre-tap status. That is the
  // proven cause of the physical QA video's mixed-state/"Status stavke je
  // već promenjen" report — NOT a backend bug, and NOT something more
  // frequent polling or SSE would fix on their own (an SSE event can race
  // the exact same way; see sse-publisher.ts's own note that in-memory
  // pub/sub isn't even reliable cross-instance on Vercel, which is why KDS
  // deliberately does not add SSE here).
  //
  // Fix: a monotonic counter orders every poll-start and every local
  // (optimistic/confirmed/invalidated) item write on ONE shared timeline.
  // `itemKnownAsOfSeq` records, per item, the seq as of which its CURRENT
  // local status is at least as fresh as any poll that could still be in
  // flight. A poll response only overwrites an item if the poll was
  // ISSUED (seq captured before its await) at or after that item's last
  // known-fresh seq — i.e., older-than-known responses can never regress
  // a newer local write, regardless of which one's network round-trip
  // happens to finish first.
  const seqRef = useRef(0);
  const itemKnownAsOfSeq = useRef<Map<string, number>>(new Map());

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    const pollSeq = ++seqRef.current;
    try {
      let loc = locationId;
      if (!loc) {
        const me = await getOrFetch(CLIENT_CACHE_KEYS.me, CLIENT_CACHE_TTL_MS, () => apiFetch("/api/pos/me"));
        loc = me.locationIds[0];
        setLocationId(loc);
        // Part I — isti poziv, nijedan dodatan upit; ne prepisuje se posle
        // (identitet se ne menja bez potpune nove prijave/novog mount-a).
        setEmployee({ firstName: me.firstName ?? null, lastName: me.lastName ?? null, roles: me.roles ?? [] });
      }
      const [activeRes, completedRes, pendingPrintRes] = await Promise.all([
        apiFetch(`${baseEndpoint}?locationId=${loc}`),
        apiFetch(`${baseEndpoint}/completed?locationId=${loc}`),
        fetchPendingStationPrintJobs(station, loc!),
      ]);
      const freshOrders: StationOrder[] = activeRes.orders;

      const newIds = freshOrders.map((o) => o.orderId).filter((id) => !knownOrderIds.current.has(id));
      if (newIds.length > 0 && knownOrderIds.current.size > 0) beep();
      knownOrderIds.current = new Set(freshOrders.map((o) => o.orderId));

      setOrders((prevOrders) => {
        const prevItemById = new Map<string, StationItem>();
        const prevOrderById = new Map<string, StationOrder>();
        for (const o of prevOrders) {
          prevOrderById.set(o.orderId, o);
          for (const it of o.items) prevItemById.set(it.id, it);
        }
        return freshOrders
          .map((o) => {
            let itemsIdentical = true;
            const items = o.items.map((it) => {
              const knownAsOf = itemKnownAsOfSeq.current.get(it.id) ?? 0;
              const prevItem = prevItemById.get(it.id);
              const resolvedStatus =
                knownAsOf > pollSeq && prevItem
                  ? prevItem.status // a newer local write already exists for this item than this poll request — keep the fresher local status.
                  : it.status;
              if (!(knownAsOf > pollSeq)) itemKnownAsOfSeq.current.set(it.id, pollSeq);
              // PREPROD physical QA follow-up (Part D) — reference-stability
              // for memoized ItemRow/OrderCard: reuse the EXACT previous
              // item object when nothing rendered actually differs, so a
              // 4s background poll doesn't force every order card/item row
              // to reconcile when only ONE thing on the board changed.
              // Modifiers are set once when an item is added to an order
              // and never mutated afterward in this domain — comparing
              // their length is a safe, cheap proxy for "unchanged" here.
              if (
                prevItem &&
                prevItem.status === resolvedStatus &&
                prevItem.quantity === it.quantity &&
                prevItem.name === it.name &&
                prevItem.note === it.note &&
                prevItem.submittedAt === it.submittedAt &&
                prevItem.modifiers.length === it.modifiers.length
              ) {
                return prevItem;
              }
              itemsIdentical = false;
              return resolvedStatus === it.status ? it : { ...it, status: resolvedStatus };
            });
            const prevOrder = prevOrderById.get(o.orderId);
            if (
              itemsIdentical &&
              prevOrder &&
              prevOrder.tableLabel === o.tableLabel &&
              prevOrder.waiterName === o.waiterName &&
              prevOrder.submittedAt === o.submittedAt
            ) {
              return prevOrder;
            }
            return { ...o, items };
          })
          // Same rule as applyItemStatus below — an item can be locally
          // fresher (already terminal) than what this specific poll's own
          // order-list membership assumed; re-apply the identical
          // Aktivne-membership rule after merging so a stale poll can
          // never "resurrect" an order already correctly moved to Gotove.
          .filter((o) => o.items.some((it) => PENDING_STATION_STATUSES_CLIENT.has(it.status)));
      });
      setCompletedOrders(completedRes.orders);

      // AUTOMATSKA ŠTAMPA: svaki PENDING tiket za ovu stanicu koji još nismo
      // videli ide u red čekanja (obrađuje se serijski, jedan po jedan, da
      // se print dijalozi ne bi gomilali). `autoSeenRef` sprečava da isti
      // poll ciklus (na 4s) ponovo doda već-viđen posao dok čeka na obradu —
      // krajnja bezbednost od duplikata je ipak server-side atomski claim
      // (beginPrintAttempt), ovo je samo da se izbegnu suvišni pokušaji.
      // FAILED tiketi se NIKAD automatski ne štampaju ponovo — samo se
      // prikazuju sa dugmetom "Pokušaj ponovo" (zahtev #4).
      const failed = pendingPrintRes.jobs.filter((j) => j.status === "FAILED" || j.status === "SUBMISSION_UNKNOWN");
      setFailedPrintJobs(failed);
      setPrinterStatus(pendingPrintRes.printerStatus);
      setHasRecentFailure(pendingPrintRes.hasRecentFailure);
      // Faza 2B — kad je TableCore Print Agent aktivan za ovu stanicu, browser
      // (QZ ili plain print) se PASIVNO povlači iz automatskog preuzimanja —
      // agent poll/claim (agent-print-service.ts) postaje jedini automatski
      // put. Duplikat je već strukturno nemoguć (atomski beginPrintAttempt),
      // ovo sprečava samo nasumično/nepredvidivo takmičenje dva transporta.
      // FAILED/SUBMISSION_UNKNOWN lista iznad ostaje prikazana bez obzira —
      // operater i dalje vidi status i može ručno da pokuša ponovo.
      if (pendingPrintRes.autoPrintEligible && !pendingPrintRes.agentActiveForStation) {
        for (const job of pendingPrintRes.jobs) {
          if (job.isAutomatic && job.status === "PENDING" && !autoSeenRef.current.has(job.id)) {
            autoSeenRef.current.add(job.id);
            autoQueueRef.current.push({ orderId: job.orderId, job });
          }
        }
        processAutoQueue();
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju");
    } finally {
      setLoading(false);
      loadInFlightRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseEndpoint, locationId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

  // Performance audit — Kitchen mora da oseti klik ODMAH (cilj: vizuelna
  // promena <100ms), ne tek posle network round-trip-a I punog reload-a
  // triju endpoint-a (aktivne/završene/print-status). Redosled je SADA:
  // (1) odmah pomeri lokalni prikaz (optimistic, iz poznate NEXT_STATUS_CLIENT
  // mape), (2) pošalji zahtev u pozadini, (3) pomiri sa STVARNIM server
  // odgovorom (nikad naslepo veruj optimističkom nagađanju), (4) NIKAD ne
  // zovi puni load() ovde — postojeći 4s poll interval i dalje prirodno
  // uskladi sve ostalo (nove porudžbine, listu Gotove, print status).
  function applyItemStatus(orderId: string, itemId: string, nextStatus: StationItem["status"]) {
    setOrders((prev) =>
      prev
        .map((o) => {
          if (o.orderId !== orderId) return o;
          const items = o.items.map((it) => (it.id === itemId ? { ...it, status: nextStatus } : it));
          return { ...o, items };
        })
        // Ista pravilo kao server-strani PENDING_PRODUCTION_STATUSES filter:
        // čim NIJEDNA stavka ove stanice više nije "u toku", porudžbina
        // nestaje sa Aktivne ODMAH — Gotove listu popunjava sledeći poll
        // (do 4s, ne 10s), ne blokira ovaj klik.
        .filter((o) => o.orderId !== orderId || o.items.some((it) => PENDING_STATION_STATUSES_CLIENT.has(it.status)))
    );
  }

  // PREPROD physical QA follow-up (Part D/G) — useCallback sa stabilnim
  // zavisnostima (station je prop, load je sam useCallback) tako da
  // memoizovani OrderCard/ItemRow ispod dobijaju STABILNU referencu ove
  // funkcije preko generacija — bez ovoga bi React.memo bio beskoristan
  // (nova zatvorena funkcija na svaki render KdsClient-a bi izgledala kao
  // "promenjen prop" za svaku karticu). Zaštita od duplog tapa i "zauzeto"
  // izgled dugmeta su SADA u ItemRow (ne ovde) — ova funkcija radi SAMO
  // stvarnu tranziciju (optimistic + API + pomirenje), ne UI stanje dugmeta.
  const advanceItem = useCallback(
    async (orderId: string, itemId: string, expectedStatus: StationItem["status"]) => {
      // Part B/C/H — PREPROD-only dijagnostika (nikad Production, nikad
      // mrežni poziv, samo console.info): dokazuje da li optimističko
      // stanje STVARNO biva ISCRTANO pre/nezavisno od mrežnog puta, umesto
      // da se to samo pretpostavi. dupli requestAnimationFrame je
      // standardna, setTimeout-slobodna tehnika — prvi rAF puca TEK PRE
      // sledećeg iscrtavanja (dakle za frejm koji već sadrži naš commit),
      // drugi puca u SLEDEĆEM frejmu, što je moguće SAMO ako je prvi
      // stvarno prikazan. Ne utiče ni na šta kad je isključeno (samo ne
      // poziva se ispod).
      const perf = environmentLabel !== "PRODUKCIJA";
      const t: (Partial<KdsTapTiming> & { tapAt: number }) | null = perf ? { tapAt: performance.now() } : null;

      const optimisticNext = NEXT_STATUS_CLIENT[expectedStatus];
      // Svaki lokalni upis (optimistički ili potvrđen) dobija SVEŽ redni broj
      // na ISTOJ vremenskoj liniji kao load()'s pollSeq iznad — ovo je ono
      // što sprečava da bilo koji poll GET koji je već bio "u letu" PRE ovog
      // tapa ikad prepiše rezultat ovog tapa, bez obzira kad se taj GET
      // stvarno vrati (dokazan uzrok fizičkog QA "Status stavke je već
      // promenjen" izveštaja — vidi napomenu na load() iznad).
      if (optimisticNext) {
        itemKnownAsOfSeq.current.set(itemId, ++seqRef.current);
        applyItemStatus(orderId, itemId, optimisticNext);
      }
      if (t) t.optimisticStateAt = performance.now();
      setError(null);
      // PREPROD physical QA follow-up — the paint-proof measurement below
      // must NEVER gate the actual request: awaiting nextPaint() here
      // before calling apiFetch would literally delay the real network
      // call by two animation frames whenever diagnostics are on, which is
      // exactly the "network work must happen after visual confirmation,
      // never block it" rule turned backwards. Kick it off but don't await
      // it yet — fetch starts immediately, in parallel.
      const paintProof = t ? nextPaint().then((ts) => { t.optimisticPaintAt = ts; }) : null;
      if (t) t.apiStartAt = performance.now();
      try {
        const result = await apiFetch(`/api/production/items/${orderId}/${itemId}/advance`, {
          method: "POST",
          body: JSON.stringify({ station, expectedStatus }),
        });
        if (t) t.apiEndAt = performance.now();
        // Pomiri sa STVARNIM stanjem sa servera (nikad samo veruj nagađanju
        // iznad) — bez punog reload-a, samo ova jedna stavka.
        const confirmedStatus = result?.item?.status as StationItem["status"] | undefined;
        if (confirmedStatus && confirmedStatus !== optimisticNext) {
          itemKnownAsOfSeq.current.set(itemId, ++seqRef.current);
          applyItemStatus(orderId, itemId, confirmedStatus);
        }
        if (t) {
          await paintProof; // near-instant in practice — the API round-trip above almost always outlasts two animation frames.
          t.reconcileStateAt = performance.now();
          t.reconcilePaintAt = await nextPaint();
          reportKdsTapTiming(`${station}/${itemId.slice(0, 8)}`, t as KdsTapTiming);
        }
      } catch (e) {
        const apiError = e instanceof Error ? (e as ApiError) : undefined;
        // Naše optimističko nagađanje je SADA dokazano pogrešno u oba
        // slučaja ispod — nikad ga više ne tretiraj kao poznato-svež (sledeći
        // load() sme slobodno da ga prepiše autoritativnim stanjem).
        itemKnownAsOfSeq.current.delete(itemId);
        if (apiError?.status === 409) {
          // Zahtev #6 (fizički QA nalaz) — "Status stavke je već promenjen"
          // je OČEKIVANA, bezopasna trka (drugi tap/uređaj/poll je već
          // pomerio TAČNO ovu stavku), NIKAD razlog da se osoblju kaže da
          // ručno osveži ekran. Tiho zatraži svež, autoritativan prikaz —
          // koji god je stvarni pobednik trke, ekran ga odmah preuzima.
          load();
        } else {
          // Stvaran neuspeh (mreža/dozvole/itd.) — ISTO zatraži svež prikaz
          // (nikad vrati ceo `orders` snapshot iz trenutka klika, što bi
          // moglo da regresira i DRUGE stavke promenjene u međuvremenu), ali
          // ovde JOŠ UVEK prijavi grešku — ovo zahteva ljudsku pažnju.
          // NAMERNO await-ovano (za razliku od 409 grane iznad): load()'s
          // sopstveni uspešan put zove setError(null) na kraju — poziv bez
          // čekanja bi tu poruku obrisao pre nego što je iko vidi.
          await load();
          setError(apiError?.message ?? "Greška");
        }
      }
    },
    [station, load, environmentLabel]
  );

  // PREPROD physical QA follow-up (Part D) — useCallback da OrderCard-ovi
  // ostanu memoizovani preko generacija umesto da svaki render KdsClient-a
  // (npr. zbog advanceItem-a za DRUGU porudžbinu) izgleda kao "promenjen
  // prop" za SVAKU karticu na ekranu.
  const handlePrintTicket = useCallback(async (orderId: string) => {
    // A deliberate manual request gets its own audited row and still uses claim/start.
    if (printInFlightRef.current) return;
    printInFlightRef.current = true;
    setPrintBusyId(orderId);
    setError(null);
    try {
      const jobs = await fetchPrintJobs(orderId);
      const original = jobs.find((j) => j.station === station);
      const job = await requestStationPrint(orderId, station, crypto.randomUUID(), original?.id);
      printInFlightRef.current = true;
      setPendingPrint({ orderId, job });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju tiketa");
      printInFlightRef.current = false;
    } finally {
      setPrintBusyId(null);
    }
  }, [station]);

  const handleRetryPrint = useCallback(async (orderId: string, jobId: string) => {
    if (printInFlightRef.current) return;
    printInFlightRef.current = true;
    setRetryBusyId(jobId);
    setError(null);
    try {
      const original = failedPrintJobs.find((j) => j.id === jobId);
      const isSubmissionUnknown = original?.resultOutcome !== "FAILED_BEFORE_SUBMISSION";
      const job = isSubmissionUnknown
        ? await requestStationPrint(orderId, station, crypto.randomUUID(), jobId)
        : await retryPrintJob(orderId, jobId);
      setFailedPrintJobs((prev) => prev.filter((j) => j.id !== jobId));
      // Hardening audit finding — kad je Print Agent aktivan za ovu
      // stanicu, retryPrintJob (server) NAMERNO ostavlja isAutomatic:true
      // da bi agentov sopstveni brz poll (1-3s) prirodno preuzeo posao.
      // KDS operater može gledati ovaj ekran na SASVIM drugom uređaju od
      // fizičkog štampača (telefon, kancelarijski račun) — pokušaj štampe
      // iz OVOG browsera ovde nikad ne bi stigao do prave kuhinjske/šank
      // stampe. Browser pokušaj ostaje SAMO za rezervni (bez agenta) put i
      // za SUBMISSION_UNKNOWN novi otisak (uvek namerno ručan preko
      // requestStationPrint, nepromenjeno).
      if (!isSubmissionUnknown && printerStatus.isOnline) {
        printInFlightRef.current = false;
        return;
      }
      // Explicit manual retry is independent of automatic policy/polling.
      autoSeenRef.current.delete(jobId);
      printInFlightRef.current = true;
      setPendingPrint({ orderId, job });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri ponovnom pokušaju štampe");
      printInFlightRef.current = false;
    } finally {
      setRetryBusyId(null);
    }
  }, [station, failedPrintJobs, printerStatus.isOnline]);

  useEffect(() => {
    if (!pendingPrint) return;
    // Ručno dugme (handlePrintTicket) NAMERNO ne postavlja transport —
    // ostaje uvek na proverenom BrowserPrintTransport-u (zahtev: "Preserve
    // it as a manual fallback"), bez obzira da li je QZ podešen za automatsku
    // štampu.
    printAndConfirm(pendingPrint.orderId, pendingPrint.job.id, pendingPrint.transport ?? defaultPrintTransport, pendingPrint.job.attemptId)
      .catch((e) => setError(e instanceof Error ? e.message : "Greška pri štampi"))
      .finally(() => {
        setPendingPrint(null);
        printInFlightRef.current = false;
        const resolveAutoQueue = printDoneResolveRef.current;
        printDoneResolveRef.current = null;
        resolveAutoQueue?.();
      });
  }, [pendingPrint]);

  const isBar = station === "BAR";
  const accentClass = isBar ? "text-sky-300/70" : "text-amber-300/70";
  const tabActiveClass = isBar ? "bg-sky-500 text-white" : "bg-gold text-white";
  const tabCompletedClass = "bg-success text-white";

  return (
    <div className={`min-h-screen overflow-x-hidden p-3 sm:p-5 ${isBar ? "bg-[#071b2b]" : "bg-graphite-900"}`}>
      {/* Identity row — always one compact line; title truncates instead of
          pushing Logout off-screen at phone width (specifikacija: fizički
          Android test, "Izveštaj" je bio van vidljivog ekrana). */}
      <div className="mb-3 flex items-center justify-between gap-2 border-b border-white/10 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <AppLogo variant="mark" theme="dark" size="sm" />
          <div className="min-w-0">
            <p className={`truncate text-[10px] font-bold uppercase tracking-[.2em] ${accentClass}`}>TableCore · {environmentLabel}</p>
            <h1 className="truncate text-xl font-bold tracking-tight text-cream-100 sm:text-2xl">{title}</h1>
          </div>
        </div>
        {/* PREPROD physical QA follow-up (Part I/J) — koje osoblje je
            ulogovano mora UVEK biti vidljivo, ali diskretno (mala,
            prigušena linija, ne veći/upadljiviji od naslova stanice iznad
            nje), i uvek uz dugme za odjavu koje TAČNO tu sesiju odjavljuje
            (isti /api/pos/me izvor identiteta kao LogoutButton-ova
            /api/auth/logout sesija — nikad drugi/dupliran izvor). Skraćuje
            se, ne guši layout na telefonu. */}
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          {employee && (employee.firstName || employee.lastName) && (
            <p className="max-w-[40vw] truncate text-[11px] font-semibold text-cream-300/70 sm:max-w-none">
              {[employee.firstName, employee.lastName].filter(Boolean).join(" ")}
              {employee.roles.length > 0 && <span className="text-cream-300/50"> · {employeeRoleDisplay(employee.roles)}</span>}
            </p>
          )}
          <LogoutButton theme="dark" />
        </div>
      </div>

      {/* Aktivne/Gotove — primarni operativni kontroli (specifikacija:
          hijerarhija #2, odmah posle identiteta). Puna širina, segmentovana
          kontrola — ne dve odvojene "pilule" — da bude nedvosmisleno
          najistaknutiji element ekrana na telefonu. */}
      <div role="tablist" aria-label="Prikaz porudžbina" className="mb-3 flex gap-1 rounded-lg bg-white/[.06] p-1">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "active"}
          onClick={() => setTab("active")}
          className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md text-sm font-bold transition-colors ${
            tab === "active" ? tabActiveClass : "text-cream-300/70 hover:bg-white/[.06]"
          }`}
        >
          Aktivne
          {orders.length > 0 && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${
              tab === "active" ? "bg-white/25 text-white" : "bg-white/10 text-cream-300/80"
            }`}>
              {orders.length}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "completed"}
          onClick={() => setTab("completed")}
          className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md text-sm font-bold transition-colors ${
            tab === "completed" ? tabCompletedClass : "text-cream-300/70 hover:bg-white/[.06]"
          }`}
        >
          Gotove
          {completedOrders.length > 0 && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${
              tab === "completed" ? "bg-white/25 text-white" : "bg-white/10 text-cream-300/80"
            }`}>
              {completedOrders.length}
            </span>
          )}
        </button>
      </div>

      {/* Sekundarna navigacija (Dostupnost/Izveštaj/štampač status) —
          namerno manja/tiša od gornje segmentovane kontrole i UVEK wrap-uje
          (nikad horizontalni overflow) umesto da forsira jedan red koji je
          širi od telefona. "N aktivnih" je uklonjeno odavde — već je
          prikazano na Aktivne dugmetu iznad, bez dupliranja. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link
          href={station === "KITCHEN" ? "/kitchen/availability" : "/bar/availability"}
          className="flex min-h-9 items-center justify-center rounded-md border border-white/10 bg-white/[.04] px-3 text-xs font-semibold text-cream-300/70 hover:bg-white/[.08]"
        >
          Dostupnost
        </Link>
        <Link
          href={station === "KITCHEN" ? "/kitchen/report" : "/bar/report"}
          className="flex min-h-9 items-center justify-center rounded-md border border-white/10 bg-white/[.04] px-3 text-xs font-semibold text-cream-300/70 hover:bg-white/[.08]"
        >
          Izveštaj
        </Link>
        {/* P0.17 / Problem 3 ispravka: SAMO informativno — podešavanje se
            radi u Admin → Podešavanja → Štampači (ADMIN_ROLES), nikad ovde.
            Nema klika, nema kontrola. Status dolazi ISKLJUČIVO sa servera
            (Print Agent Workstation stanje), nikad iz QZ/browser
            localStorage — taj je po-računaru i ne odražava da li je
            restoranov Print Agent stvarno spreman. */}
        {(() => {
          // Part 13 hardening — JEDAN diskriminisan prekidač (isti
          // agentPrinting.stationPrinterStatus koji Admin koristi), nikad
          // ponovo izveden ovde. PRINTER_UNAVAILABLE (agent online, ali
          // konfigurisan Windows štampač nedostupan) je NOVO — ranije bi
          // ovo pogrešno prikazalo "Štampač spreman".
          const badge: { label: string; title: string; tone: "success" | "warn" | "muted" | "danger" } =
            printerStatus.state === "NOT_CONFIGURED"
              ? { label: "Štampač nije podešen", title: "Nijedan Print Agent nije uparen za ovu stanicu — obratite se administratoru", tone: "muted" }
              : printerStatus.state === "AGENT_OFFLINE"
                ? { label: "Print Agent offline", title: "Radna stanica je uparena, ali Windows Print Agent trenutno ne javlja status", tone: "warn" }
                : printerStatus.state === "PRINTER_UNAVAILABLE"
                  ? { label: "Štampač nedostupan", title: "Print Agent je online, ali konfigurisan Windows štampač nije pronađen/dostupan na tom računaru", tone: "danger" }
                  : hasRecentFailure
                    ? { label: "Poslednja štampa nije uspela", title: "Print Agent je spreman, ali bar jedan tiket nije uspešno odštampan — proveri listu ispod", tone: "danger" }
                    : { label: "Štampač spreman", title: "Print Agent je uparen i spreman za automatsku štampu", tone: "success" };
          const toneClasses: Record<typeof badge.tone, string> = {
            success: "border-success/30 bg-success/10 text-success",
            warn: "border-gold/30 bg-gold-soft/10 text-gold",
            danger: "border-danger/30 bg-danger-soft text-danger",
            muted: "border-white/10 bg-white/[.04] text-cream-300/60",
          };
          const dotClasses: Record<typeof badge.tone, string> = {
            success: "bg-success",
            warn: "bg-gold",
            danger: "bg-danger",
            muted: "bg-cream-300/40",
          };
          return (
            <span title={badge.title} className={`flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-semibold ${toneClasses[badge.tone]}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClasses[badge.tone]}`} aria-hidden="true" />
              {badge.label}
            </span>
          );
        })()}
      </div>

      {error && <div className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      {loading ? (
        <div className="py-24 text-center text-cream-300/60">Učitavanje…</div>
      ) : tab === "active" ? (
        orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <p className="text-lg font-medium text-cream-100">Nema aktivnih porudžbina</p>
            <p className="text-sm text-cream-300/70">Nove porudžbine će se automatski pojaviti ovde.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {orders.map((order) => {
              const waitMin = minutesSince(ticketWaitBasis(order.submittedAt, order.items));
              const isLate = waitMin >= 12;
              const failedJob = failedPrintJobs.find((j) => j.orderId === order.orderId);
              return (
                <OrderCard
                  key={order.orderId}
                  order={order}
                  waitMin={waitMin}
                  isLate={isLate}
                  failedJob={failedJob}
                  printBusy={printBusyId === order.orderId}
                  retryBusy={retryBusyId === failedJob?.id}
                  onPrintTicket={handlePrintTicket}
                  onRetryPrint={handleRetryPrint}
                  onAdvance={advanceItem}
                />
              );
            })}
          </div>
        )
      ) : (
        completedOrders.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <p className="text-lg font-medium text-cream-100">Nema završenih porudžbina u ovoj smeni</p>
            <p className="text-sm text-cream-300/70">Završene porudžbine će se automatski pojaviti ovde.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {completedOrders.map((order) => (
              <div
                key={order.orderId}
                className="overflow-hidden rounded-lg border border-success/20 bg-graphite-700/60 shadow-[0_8px_18px_rgba(0,0,0,.18)]"
              >
                <div className="flex items-center justify-between gap-2 border-b border-white/[.06] bg-success/[.07] px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-xl font-bold tracking-tight text-cream-100">{order.tableLabel}</div>
                    <div className="truncate text-xs font-medium text-cream-300/60">Konobar · {order.waiterName}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-md bg-success/20 px-2.5 py-1 text-xs font-bold tabular-nums text-success">
                      {formatTime(order.completedAt)}
                    </span>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-success" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                  </div>
                </div>

                <div className="space-y-1.5 p-3">
                  {order.items.map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-2 rounded-md border border-white/[.04] bg-graphite-800/60 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold leading-snug text-cream-100/70">
                          {item.quantity}× {item.name}
                        </div>
                        <ModifierList modifiers={item.modifiers} tone="completed" />
                        {item.note && (
                          <div className="mt-0.5 text-xs italic text-cream-300/50">
                            {item.note}
                          </div>
                        )}
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        item.status === "CANCELLED"
                          ? "bg-danger/15 text-danger"
                          : "bg-success/15 text-success"
                      }`}>
                        {item.status === "CANCELLED" ? "Stornirano" : "Gotovo"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {pendingPrint && <TicketPrintPanel content={pendingPrint.job.content as TicketContent} />}
    </div>
  );
}
