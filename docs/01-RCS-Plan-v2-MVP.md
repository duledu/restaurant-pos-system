# Restaurant Control System — Predimplementacioni plan v2 (MVP sa extension points)

Ovaj dokument **zamenjuje deo v1 plana koji se odnosi na obim i redosled implementacije**, ali ne menja fundamentalne arhitektonske principe iz v1 (server kao izvor istine, event/snapshot pristup umesto mutacije, tenant izolacija, modularnost). v1 (`00-RCS-Plan.md`) ostaje referenca za punu viziju sistema; ovaj dokument definiše **šta se gradi sada i zašto sadašnji dizajn ne zatvara vrata punoj verziji**.

---

## 1. Korigovana MVP arhitektura

**Model ostaje modularni monolit, jedna aplikacija, jedna baza:**

```
apps/web/                  Next.js (App Router) — jedina serverska instanca u MVP-u
packages/db/                Prisma schema (pun model iz v1, ali se u MVP-u koristi
                             samo podskup tabela — vidi tačku 4)
packages/domain/
  ├── auth/                 login, PIN, RBAC
  ├── employees/
  ├── shifts/                Shift, CashRegisterSession, ShiftSnapshot, ShiftCorrection
  ├── tables/
  ├── menu/
  ├── orders/                Order, OrderItem, OrderEvent
  ├── production/            ProductionTicket (kuhinja/šank rutiranje)
  ├── payments/
  ├── inventory/             InventoryMovement, StockBalance
  ├── printing/              PrintingProvider interfejs + 1 MVP implementacija
  ├── approvals/             ApprovalRecord
  ├── closing/                ShiftSnapshot/DailyClosing orkestracija (koristi shifts+
                             orders+inventory+payments, ne duplira njihovu logiku)
  ├── reporting/
  ├── audit/
  └── realtime/              RealtimePublisher interfejs + 1 MVP implementacija (SSE)
```

**Real-time (SSE, bez Redis-a, bez WebSocket-a, jedna instanca):**

Next.js API route (`/api/realtime/stream`) drži otvorenu SSE konekciju po klijentu; server-side `RealtimePublisher` singleton (in-memory `EventEmitter` iza interfejsa) prosleđuje događaje pretplaćenim konekcijama filtrirano po `restaurantId:locationId:role`. Kada domain servis (npr. `orders`) završi transakciju, poziva `realtimePublisher.publish(event)` — servis ne zna i ne sme znati da li je ispod SSE, Redis ili nešto treće.

**Zašto SSE a ne polling (korekcija u odnosu na moj prethodni predlog):** slažem se sa tvojom odlukom — SSE je i dalje jednostavan (jedan HTTP response koji se ne zatvara, standardni browser `EventSource` API, bez dodatne infrastrukture), ali eliminiše 3-4 sekunde kašnjenja i nepotrebne pozive kada nema promena. Cena implementacije je zanemarljivo veća od pollinga, a korisničko iskustvo (kuhinja vidi tiket odmah) je bitno bolje — ispravno je da ovo bude MVP, ne kasnija faza.

**Baza:** PostgreSQL, bez Redis-a u MVP-u. Sesije idu kroz potpisane cookie/JWT (Auth.js), ne kroz server-side session store — ovo je namerno, jer izbegava Redis zavisnost dok stvarno ne zatreba (horizontalno skaliranje ili offline queue).

**Printing:** sinhroni pokušaj štampe odmah nakon kreiranja `ProductionTicket`, sa 1-2 automatska retry-ja u samom request handleru (bez background queue-a). Status se čuva u `PrintJob` tabeli (zadržava se — jednostavna, bez worker infrastrukture oko nje).

---

## 2. Tačne izmene u odnosu na prethodni plan (v1)

| Oblast | v1 predlog | v2 (MVP) odluka | Status |
|---|---|---|---|
| Real-time | WebSocket ili SSE + Redis pub/sub | **SSE, jedna instanca, bez Redis-a**, iza `RealtimePublisher` interfejsa | Promenjeno (ranije sam u međukoraku predlagao polling — tvoja SSE odluka je bolja i ostaje) |
| Redis (cache/session/queue) | Od dana 1 | **Uklonjen iz MVP-a u potpunosti** | Promenjeno |
| BullMQ / background workeri | Od dana 1 | **Uklonjeno iz MVP-a**, print/report rade sinhrono u request handleru | Promenjeno |
| Offline / IndexedDB / sync queue | MVP zahtev | **Prebačeno u kasniju fazu**; MVP = jasna greška + retry dugme | Promenjeno |
| Inventory | Pun ledger sa 15 tipova kretanja | **`InventoryMovement` zadržan kao izvor istine**, ali UI izlaže samo 6 jednostavnih akcija (prodaja/zaduženje/povrat/otpis/korekcija su i dalje zasebni `type` u bazi, samo skriveni iza jednostavnijeg UI-ja) | Zadržano u bazi, pojednostavljeno u UI-ju (usklađeno sa tvojim zahtevom) |
| Approval workflow | Poseban `ApprovalRequest` state machine (pending/approved/rejected tok) | **`ApprovalRecord`** — trajan zapis izvršenog odobrenja (PIN na licu mesta = trenutno izvršenje), bez pending/inbox stanja u MVP-u | Pojednostavljeno, ali entitet zadržan (nije bio u mom prethodnom "MVP obimu" kao formalna tabela — sada jeste, po tvom zahtevu) |
| Recepture/BOM | Verzionisano, % otpada, zamenski sastojci | I dalje kasnija faza (nepromenjeno) | Nepromenjeno |
| **ShiftSnapshot** | Nije eksplicitno bio poseban model u v1 (kraj smene je bio "izveštaj koji se računa uživo") | **Nova obavezna MVP tabela** — immutable snapshot upisan u transakciji zatvaranja smene | **Novo u MVP-u** |
| **DailyClosing** | Nije postojao u v1 | **Nova obavezna MVP tabela** — agregira sve smene jednog poslovnog dana, immutable | **Novo u MVP-u** |
| Split računa | Kasnija faza | Nepromenjeno | Nepromenjeno |
| Multi-lokacija UI | Priprema u bazi, ne u UI-ju | Nepromenjeno — UI u MVP-u prikazuje samo trenutnu lokaciju, model podržava više | Nepromenjeno |

---

## 3. MVP naspram pune verzije — matrica po modulu

| Modul | MVP sada | Extension point za punu verziju |
|---|---|---|
| Auth/RBAC | Email+lozinka (admin), PIN (osoblje), fiksne sistemske role | Custom role builder, granularne permisije po polju |
| Restorani/lokacije | Jedan aktivan objekat u UI-ju, model podržava više | Prebacivanje između lokacija, centralni multi-location dashboard |
| Stolovi | Grid prikaz, status enum | Vizuelni floor-plan editor sa pozicioniranjem |
| Meni | Kategorije, artikli, cena, slobodna napomena po stavci | Modifier grupe, varijante, obavezni/opcioni izbori, alergeni, i18n |
| Porudžbine | Status tok, event log, snapshot cene/naziva | Kursevi posluživanja, prioriteti, deljenje/spajanje stolova (može biti MVP+, nije blokirano) |
| Production/Kitchen/Bar | Jedna kuhinjska i jedna šank stanica, auto-rutiranje po `productionStationId` | Više stanica (grill, pizza, dessert...), filtriranje/grupisanje na KDS-u |
| Real-time | SSE, jedna instanca, `RealtimePublisher` interfejs | Redis pub/sav, više instanci, WebSocket ako zatreba |
| Štampa | Jedan printer po stanici, sinhroni retry, `PrintingProvider` interfejs | Print queue (BullMQ), fallback lanci, više printera po stanici, QZ Tray |
| Plaćanje | Gotovina i kartica, ceo račun odjednom | Split payment, refund workflow, terminal integracija |
| Inventar | Stanje, prodaja (auto), zaduženje, povrat, otpis, korekcija — sve kroz `InventoryMovement` | Dobavljači, narudžbenice, prijemnice, transferi, popisi, lotovi/rokovi, ponderisana nabavna cena |
| Recepture | — (nema u MVP-u; prodaja direktno umanjuje `InventoryItem` po prodajnom artiklu) | `Recipe`/`RecipeVersion`/`RecipeIngredient`, teorijska potrošnja, % otpada |
| Odobrenja | `ApprovalRecord` — PIN menadžera, trenutno izvršenje | Pending stanja, udaljeno odobravanje, višestepeno, limiti po ulozi, notifikacije |
| Zatvaranje smene | `ShiftSnapshot` — obavezan, immutable, u transakciji | `ShiftCorrection` UI/notifikacije, automatski podsetnici |
| Dnevno zatvaranje | `DailyClosing` — obavezan, immutable, agregira smene | `DailyClosingCorrection` UI, poređenje po danima/trendovi |
| Izveštaji | Po smeni, danu, konobaru, kategoriji — iz već upisanih agregata | Marže, trendovi, teorijska vs stvarna potrošnja, eksport PDF/Excel |
| Offline | Jasna greška + retry dugme | IndexedDB, sync queue, conflict resolution |
| Audit | Append-only log svih osetljivih radnji | Nepromenjeno — ovo je MVP od početka jer je jeftino i kritično |
| Fiskalizacija | `FiscalizationProvider` interfejs, bez implementacije; dokument označen "nije fiskalni račun" | Sertifikovana integracija kad bude dostupna |

---

## 4. Finalni minimalni skup Prisma modela za MVP

Zadržavamo sve tabele iz v1 Faze-1 šeme (Tenant, Restaurant, Location, User, Employee, Role/Permission/UserRole, Device, Menu/MenuCategory/MenuItem, Floor/RestaurantTable, AuditLog) i **dodajemo** sledeći minimalni skup za pun MVP tok (registracija → porudžbina → kuhinja/šank → plaćanje → inventar → odobrenje → zatvaranje smene → dnevno zatvaranje):

```
ProductionStation      — MVP: tačno 2 reda (KITCHEN, BAR) po restoranu, model podržava više
Order, OrderItem, OrderEvent
ProductionTicket, ProductionTicketItem
Printer, PrintJob
InventoryItem, StockBalance, InventoryMovement
Payment, PaymentMethod
ApprovalRecord
Shift, CashRegisterSession
ShiftSnapshot, ShiftCorrection
DailyClosing, DailyClosingCorrection
```

Namerno **izostavljeno** iz MVP šeme (dodaje se kasnije bez menjanja postojećih tabela): Warehouse (MVP ima jedan implicitni magacin po restoranu — `InventoryItem` nema `warehouseId` u MVP-u, dodaje se kao nullable FK kasnije), Recipe/RecipeVersion/RecipeIngredient, Supplier/PurchaseOrder/GoodsReceipt, Transfer/StockCount, ModifierGroup/Modifier/MenuItemVariant, Discount kao poseban entitet (MVP: popust je polje na `OrderItem`/`Order`, ne poseban model — ako preraste u kupone/pravila, izdvaja se kasnije), Refund/ServiceCharge/Tip kao posebni entiteti, Notification.

---

## 5. Ključni novi modeli

```prisma
// ── INVENTAR (izvor istine je Movement, StockBalance je izveden keš) ──────

model InventoryItem {
  id           String   @id @default(uuid())
  restaurantId String
  name         String
  unit         String   // "kom", "kg", "l" — slobodan tekst u MVP-u, enum kasnije
  lowStockThreshold Decimal? @db.Decimal(12, 3)
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  // warehouseId String?  ← dodaje se kasnije (nullable, bez migracije postojećih redova)

  movements    InventoryMovement[]
  balance      StockBalance?
  menuItemLinks MenuItemInventoryLink[]  // koji prodajni artikal skida koju stavku (1:1 u MVP, BOM kasnije)

  @@index([restaurantId])
}

// Jednostavna veza artikal-menija -> stavka inventara, 1:1 kvantitet u MVP-u.
// Ovo JE extension point: kasnije se zamenjuje RecipeIngredient (1:N sa količinama)
// bez brisanja ove tabele — MenuItem i dalje ima stabilan id na koji se Recipe kači.
model MenuItemInventoryLink {
  id              String @id @default(uuid())
  menuItemId      String @unique  // MVP: jedan link po artiklu
  inventoryItemId String
  quantityPerSale Decimal @db.Decimal(12, 3) @default(1)

  inventoryItem   InventoryItem @relation(fields: [inventoryItemId], references: [id])

  @@index([inventoryItemId])
}

model StockBalance {
  inventoryItemId String   @id
  quantity        Decimal  @db.Decimal(12, 3)
  updatedAt       DateTime @updatedAt

  inventoryItem   InventoryItem @relation(fields: [inventoryItemId], references: [id])
}

model InventoryMovement {
  id              String   @id @default(uuid())
  restaurantId    String
  inventoryItemId String
  type            InventoryMovementType
  quantity        Decimal  @db.Decimal(12, 3)   // pozitivno = ulaz, negativno = izlaz
  previousBalance Decimal  @db.Decimal(12, 3)
  newBalance      Decimal  @db.Decimal(12, 3)
  reason          String?
  relatedOrderId  String?
  relatedShiftId  String?
  createdBy       String
  createdAt       DateTime @default(now())

  inventoryItem   InventoryItem @relation(fields: [inventoryItemId], references: [id])

  @@index([restaurantId])
  @@index([inventoryItemId])
  @@index([relatedShiftId])
  @@index([createdAt])
}

// MVP: 6 tipova. Enum se PROŠIRUJE (dodavanjem vrednosti), ne menja u punoj verziji —
// stare vrednosti ostaju validne, novi tipovi (TRANSFER_IN, STOCK_COUNT_CORRECTION, ...)
// se dodaju bez migracije postojećih redova.
enum InventoryMovementType {
  SALE_CONSUMPTION
  STAFF_ASSIGNMENT
  STAFF_RETURN
  WASTE
  MANUAL_CORRECTION
  OPENING_BALANCE
}

// ── ODOBRENJA ────────────────────────────────────────────────────────────

model ApprovalRecord {
  id             String   @id @default(uuid())
  restaurantId   String
  operationType  ApprovalOperationType
  entityType     String   // "Order", "OrderItem", "InventoryMovement", ...
  entityId       String
  requestedBy    String   // employeeId
  approvedBy     String   // employeeId (menadžer koji je uneo PIN)
  reason         String?
  previousValue  Json?
  newValue       Json?
  deviceId       String?
  result         ApprovalResult @default(APPROVED)
  createdAt      DateTime @default(now())

  @@index([restaurantId])
  @@index([entityType, entityId])
  @@index([createdAt])
}

enum ApprovalOperationType {
  DISCOUNT
  VOID
  ITEM_CANCEL
  INVENTORY_CORRECTION
  REOPEN_PAID_ORDER
}

enum ApprovalResult {
  APPROVED
  DENIED
}
// Napomena: MVP uvek upisuje APPROVED (PIN se proverava pre upisa; ako je PIN
// pogrešan, zapis se uopšte ne kreira — nema "pending/denied" toka u MVP-u).
// Kolona postoji od početka da kasniji "pending" tok (udaljeno odobravanje)
// ne zahteva promenu šeme, samo novu vrednost i novi UI.

// ── ZATVARANJE SMENE ─────────────────────────────────────────────────────

model ShiftSnapshot {
  id                  String   @id @default(uuid())
  shiftId             String   @unique
  restaurantId        String
  locationId          String
  startedAt           DateTime
  closedAt            DateTime
  closedBy            String   // employeeId

  totalRevenue        Decimal  @db.Decimal(12, 2)
  cashRevenue         Decimal  @db.Decimal(12, 2)
  cardRevenue         Decimal  @db.Decimal(12, 2)
  otherRevenue        Decimal  @db.Decimal(12, 2)
  expectedCash        Decimal  @db.Decimal(12, 2)
  countedCash         Decimal  @db.Decimal(12, 2)
  cashDifference       Decimal  @db.Decimal(12, 2)

  receiptCount        Int
  openOrdersCount      Int      // treba biti 0 pri zatvaranju; ako nije, zatvaranje se odbija (v. tačka 7)
  transferredOrderIds  String[] // porudžbine eksplicitno prenete na sledeću smenu (retko, ali podržano)

  totalDiscounts       Decimal  @db.Decimal(12, 2)
  totalComps           Decimal  @db.Decimal(12, 2)   // gratis
  totalVoids           Decimal  @db.Decimal(12, 2)
  totalRefunds         Decimal  @db.Decimal(12, 2)

  kitchenRevenue        Decimal  @db.Decimal(12, 2)
  barRevenue             Decimal  @db.Decimal(12, 2)

  staffAssignmentsSummary Json   // po zaposlenom: izdato/prodato/otpis/vraćeno/razlika
  inventorySummary        Json   // po inventarnoj stavci: očekivano vs prebrojano (za stavke koje su brojane)

  perWaiterResults        Json   // [{ employeeId, revenue, receiptCount, discounts, voids, cashOwed, difference }]

  createdAt            DateTime @default(now())

  @@index([restaurantId])
  @@index([locationId])
  @@index([closedAt])
}

// Snapshot se NIKAD ne update-uje nakon kreiranja. Ispravka ide ovde:
model ShiftCorrection {
  id                String   @id @default(uuid())
  shiftSnapshotId   String
  restaurantId      String
  reason            String
  fieldChanges      Json     // [{ field, oldValue, newValue }]
  correctedBy       String   // employeeId (manager/owner)
  approvalRecordId  String?  // veza na ApprovalRecord ako korekcija zahteva odobrenje
  createdAt         DateTime @default(now())

  @@index([shiftSnapshotId])
  @@index([restaurantId])
}

// ── DNEVNO ZATVARANJE ────────────────────────────────────────────────────

model DailyClosing {
  id                  String   @id @default(uuid())
  restaurantId        String
  locationId          String
  businessDate        DateTime @db.Date
  shiftSnapshotIds    String[]

  totalRevenue        Decimal  @db.Decimal(12, 2)
  cashRevenue         Decimal  @db.Decimal(12, 2)
  cardRevenue         Decimal  @db.Decimal(12, 2)
  otherRevenue        Decimal  @db.Decimal(12, 2)

  kitchenRevenue       Decimal  @db.Decimal(12, 2)
  barRevenue            Decimal  @db.Decimal(12, 2)
  perWaiterResults      Json
  totalDiscounts        Decimal  @db.Decimal(12, 2)
  totalComps             Decimal  @db.Decimal(12, 2)
  totalVoids              Decimal  @db.Decimal(12, 2)
  totalRefunds             Decimal  @db.Decimal(12, 2)

  cashDifferenceTotal    Decimal  @db.Decimal(12, 2)
  inventoryDifferenceSummary Json

  carriedOverOrderIds    String[]  // otvoreno preneto na sledeći dan

  closedBy              String
  createdAt             DateTime @default(now())

  @@unique([restaurantId, locationId, businessDate])
  @@index([restaurantId])
  @@index([businessDate])
}

model DailyClosingCorrection {
  id               String   @id @default(uuid())
  dailyClosingId   String
  restaurantId     String
  reason           String
  fieldChanges     Json
  correctedBy      String
  approvalRecordId String?
  createdAt        DateTime @default(now())

  @@index([dailyClosingId])
  @@index([restaurantId])
}
```

---

## 6. Interfejsi za real-time i štampanje

```ts
// packages/domain/realtime/publisher.ts
//
// Domain servisi (orders, production, inventory...) zavise SAMO od ovog
// interfejsa. Ne importuju SSE kod direktno. Ovo je jedina apstrakcija koju
// uvodimo za real-time — nema dodatnih "provider registry" slojeva dok ne
// zatreba drugi transport.

export interface DomainEvent {
  type: string;               // "order.created", "ticket.ready", "inventory.low", ...
  restaurantId: string;
  locationId?: string;
  targetRoles?: string[];     // ko sme da primi (npr. ["KITCHEN", "MANAGER"])
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface RealtimePublisher {
  publish(event: DomainEvent): Promise<void>;
}

// MVP implementacija: packages/domain/realtime/sse-publisher.ts
// - in-memory registry konekcija po (restaurantId, locationId)
// - publish() prolazi kroz registrovane konekcije i filtrira po targetRoles
// - koristi se kao singleton kroz jednostavan DI (jedan modul, jedan export)
//
// Kasnija implementacija (packages/domain/realtime/redis-publisher.ts):
// - isti RealtimePublisher interfejs
// - publish() radi Redis PUBLISH; svaka instanca aplikacije ima svoj
//   SUBSCRIBE koji prosleđuje ka svojim lokalnim SSE/WS konekcijama
// - domain servisi (order.ts, production.ts, ...) se NE MENJAJU
```

```ts
// packages/domain/printing/provider.ts

export interface PrintJobPayload {
  ticketId: string;
  restaurantId: string;
  printerId: string;
  content: PrintableTicketContent;   // strukturisan sadržaj, ne raw ESC/POS —
                                      // provider sam radi renderovanje za svoj format
}

export interface PrintResult {
  success: boolean;
  errorMessage?: string;
}

export interface PrintingProvider {
  print(job: PrintJobPayload): Promise<PrintResult>;
}

// MVP implementacija: escpos-lan-provider.ts (direktan TCP socket na ESC/POS
// LAN printer) + browser-fallback-provider.ts (vraća payload za window.print()
// kada mrežni printer nije dostupan).
//
// Kasnije: qz-tray-provider.ts, print-queue (BullMQ) koji ORKESTRIRA pozive
// ka istom PrintingProvider interfejsu — sam interfejs se ne menja, samo se
// dodaje sloj queue/retry/fallback-lanac IZNAD njega.
```

```ts
// packages/domain/fiscalization/provider.ts  (definisan, bez MVP implementacije)

export interface FiscalizationProvider {
  fiscalize(orderId: string): Promise<{ fiscalReceiptRef: string } | null>;
}
// MVP: nijedna implementacija se ne registruje; dokumenti se generišu sa
// oznakom "Radni nalog – nije fiskalni račun".
```

---

## 7. Tok zatvaranja smene (jedna DB transakcija)

```
closeShift(shiftId, countedCash, employeeId):

  BEGIN TRANSACTION

  1. LOCK shift row (FOR UPDATE) — sprečava dupli closeShift poziv

  2. openOrders = SELECT Order WHERE shiftId = shiftId AND status NOT IN (PAID, CANCELLED, VOIDED)
     AKO openOrders.length > 0:
        AKO nije eksplicitno markiran kao "prenesi na sledeću smenu" po nalogu menadžera (ApprovalRecord REOPEN/TRANSFER):
           ROLLBACK, vrati grešku "Postoje otvoreni računi: [lista]. Zatvori ih ili ih prenesi uz odobrenje."
        INAČE:
           transferredOrderIds = [...]

  3. payments = SUM(Payment) po metodu WHERE shiftId = shiftId
     expectedCash = shift.openingCash + payments[CASH] - refunds[CASH]
     cashDifference = countedCash - expectedCash

  4. orderStats = agregacija OrderItem/Order po statusu (discounts, comps, voids, refunds,
     kitchenRevenue, barRevenue) WHERE shiftId = shiftId

  5. staffAssignmentsSummary = agregacija StaffAssignment/InventoryMovement
     (STAFF_ASSIGNMENT/STAFF_RETURN/WASTE) za zaposlene aktivne u ovoj smeni

  6. inventorySummary = poređenje StockBalance (očekivano) vs bilo koji uneti
     "prebrojano" unos za stavke koje su deo brojanja na kraju ove smene
     (MVP: brojanje je opciono po stavci — ne blokira zatvaranje ako nije urađeno)

  7. perWaiterResults = agregacija Payment/Order po employeeId

  8. INSERT ShiftSnapshot sa svim gore izračunatim vrednostima (immutable)

  9. UPDATE Shift SET status = CLOSED, closedBy = employeeId, closedAt = now()

  10. INSERT AuditLog (action: "shift.closed", entityId: shiftId, newValue: snapshot summary)

  11. publish DomainEvent "shift.closed" (RealtimePublisher — van transakcije,
      posle uspešnog COMMIT-a)

  COMMIT TRANSACTION
```

Ako bilo koji korak 2–10 baci grešku, cela transakcija se poništava — smena ostaje otvorena, nijedan delimičan snapshot se ne upisuje. Ovo je razlog zašto sve mora biti u jednoj transakciji: `ShiftSnapshot` mora biti sve-ili-ništa u odnosu na promenu statusa smene.

---

## 8. Tok dnevnog zatvaranja

```
closeDailyBusiness(restaurantId, locationId, businessDate, employeeId):

  BEGIN TRANSACTION

  1. shiftSnapshots = SELECT ShiftSnapshot WHERE locationId = locationId
     AND businessDate(shift) = businessDate  (poslovni dan definisan po restoranu,
     npr. 06:00–06:00, ne kalendarski dan — konfigurabilno polje na Restaurant)

  2. AKO postoji smena za taj businessDate koja NIJE zatvorena (status != CLOSED):
        ROLLBACK, vrati grešku "Smena '[naziv]' još nije zatvorena."

  3. Agregacija preko svih shiftSnapshots za taj dan:
     - SUM totalRevenue, cashRevenue, cardRevenue, otherRevenue
     - SUM kitchenRevenue, barRevenue
     - merge perWaiterResults po employeeId (SUM revenue/receiptCount/...)
     - SUM totalDiscounts, totalComps, totalVoids, totalRefunds
     - SUM cashDifference → cashDifferenceTotal
     - merge inventorySummary po inventoryItemId

  4. carriedOverOrderIds = unija transferredOrderIds iz svih shiftSnapshots tog dana

  5. INSERT DailyClosing (immutable) sa @@unique([restaurantId, locationId, businessDate])
     — sprečava duplo zatvaranje istog dana

  6. INSERT AuditLog (action: "daily_closing.created")

  7. publish DomainEvent "daily_closing.created"

  COMMIT TRANSACTION
```

`DailyClosing` se **računa isključivo iz već upisanih `ShiftSnapshot` redova**, nikad direktno iz `Order`/`Payment` tabela — ovo garantuje da je broj koji vlasnik vidi za "juče" identičan broju koji su konobari i menadžer potvrdili na kraju svake smene tog dana, bez mogućnosti da se dva izvora istine razminu.

---

## 9. Plan migracije MVP → puna verzija, po modulu

| Modul | Kako se proširuje | Novi modul/UI samo? | Rizik migracije baze | Kako sprečavamo budući refaktor |
|---|---|---|---|---|
| Real-time | Zameni `sse-publisher.ts` sa `redis-publisher.ts`, isti `RealtimePublisher` interfejs | Da, samo novi provider | Nema (nema DB modela) | Servisi zavise od interfejsa, nikad od SSE specifičnog koda |
| Inventar | Dodaj `Warehouse` tabelu, `warehouseId` kao nullable FK na `InventoryItem`/`InventoryMovement`; zameni `MenuItemInventoryLink` sa `RecipeIngredient` (1:N) | Novi modul (procurement) + proširenje postojećeg | Nizak — dodavanje nullable kolona i novih tabela, bez brisanja/menjanja postojećih | `InventoryMovement` je već ledger od dana 1; enum se samo dodaje, ne menja |
| Odobrenja | Dodaj `status` (PENDING/APPROVED/DENIED) i `respondedAt` na `ApprovalRecord`, dodaj notifikacije | Novi UI (inbox) + proširenje modela (dodavanje kolona) | Nizak — nove nullable kolone | `ApprovalRecord` već ima sva polja potrebna za pending tok (requestedBy odvojeno od approvedBy) |
| Štampa | Dodaj `PrintQueue`/worker iznad `PrintingProvider`; dodaj `fallbackPrinterId` na `Printer` | Novi modul (queue) iza istog interfejsa | Nema — `PrintJob` tabela već postoji sa status enumom | Provider interfejs se ne dira, samo orkestracija oko njega |
| Plaćanje | Dodaj `PaymentAllocation` za split; `Refund` kao poseban entitet | Novi modul + proširenje UI-ja za naplatu | Nizak — nove tabele, `Payment` ostaje kompatibilan | `Payment` već referencira `orderId`, ne pretpostavlja "jedan payment = ceo račun" u logici, samo u MVP UI-ju |
| Recepture | Dodaj `Recipe/RecipeVersion/RecipeIngredient`; migracija podataka: za svaki `MenuItemInventoryLink` kreiraj `RecipeVersion` sa jednim `RecipeIngredient` | Novi modul + skript za migraciju postojećih linkova | Srednji — potrebna je jednokratna data migracija (skriptovano, ne ručno), ali stara tabela se može zadržati kao fallback dok se ne potvrdi da su sve receptura kreirane | `MenuItemInventoryLink` je namerno projektovan kao "recept sa jednim sastojkom" — koncept je isti, samo se generalizuje |
| Zatvaranje smene | Dodaj UI za `ShiftCorrection` (trenutno se korekcija može upisati direktno u bazu/kroz admin akciju, bez posebnog UI-ja) | Samo UI | Nema | Tabela i transakciona logika su MVP od početka |
| Multi-lokacija | Ukloni pretpostavku "trenutna lokacija" iz UI state-a, dodaj location switcher | Samo UI | Nema | Svi modeli već imaju `locationId`/`restaurantId` |
| Offline | Dodaj IndexedDB + sync queue na klijentu, idempotency key polja na mutation endpoint-ima | Novi frontend sloj + manje proširenje API-ja (idempotency middleware) | Nizak | API mutacije se već projektuju kao idempotentne gde ima smisla (npr. order submit) |
| Fiskalizacija | Implementiraj `FiscalizationProvider`, pozovi ga u `payments` servisu na mestu gde se već generiše dokument | Novi provider + jedna integraciona tačka | Nema | Interfejs postoji od početka, poziv je već predviđen (samo trenutno vraća null) |

---

## 10. Odluke koje bi kasnije zahtevale veliki refaktor — i kako ih sada izbegavamo

| Rizična odluka da smo je doneli | Zašto bi kasnije bolela | Kako je MVP dizajn to izbegava |
|---|---|---|
| `quantity` kao golo polje na `InventoryItem`, bez `InventoryMovement` | Nemoguće rekonstruisati istoriju, nemoguć audit na kraju smene | `InventoryMovement` je izvor istine od MVP-a; `StockBalance` je samo keš |
| Direktna promena `OrderItem` cene/količine bez event log-a | Nemoguć audit trail, nemoguće "šta se tačno desilo" | `OrderEvent` append-only od MVP-a (zadržano iz v1) |
| Kraj smene kao "izveštaj koji se računa uživo" (bez snapshot tabele) | Brojevi bi se menjali ako se naknadno doda porudžbina sa starim `shiftId`, izveštaji ne bi bili pouzdani za istoriju | `ShiftSnapshot`/`DailyClosing` su immutable od MVP-a — ovo je najvažnija promena u v2 u odnosu na moj raniji predlog |
| Real-time kod pozvan direktno (npr. `sseSend(...)`) unutar `order.ts` servisa | Zamena transporta (Redis/WS) bi zahtevala menjanje svake poslovne funkcije | `RealtimePublisher` interfejs postoji od prvog reda koda u `orders` modulu |
| `Payment` projektovan kao "tačno jedan po porudžbini" u tipovima/šemi (ne samo u UI-ju) | Uvođenje split plaćanja bi zahtevalo restrukturiranje modela i migraciju postojećih plaćanja | `Payment` je od početka 1:N prema `Order` u šemi (FK je na `Payment.orderId`, ne obrnuto); MVP UI samo ne izlaže split u interfejsu |
| Nedostatak `restaurantId`/`locationId` na nekoj MVP tabeli "jer je za sada jedan restoran" | Multi-tenant retrofit zahteva migraciju podataka i rizik curenja podataka između tenant-a | Svaka MVP tabela ima `restaurantId` (i `locationId` gde je primenljivo) od prvog reda šeme — bez izuzetka |
| `ApprovalRecord` projektovan samo kao "log" bez `requestedBy`/`approvedBy` razdvojenih polja | Udaljeno/višestepeno odobravanje bi zahtevalo novu tabelu i migraciju istorijskih zapisa | Polja su razdvojena od MVP-a, iako se u MVP toku oba popunjavaju u istom trenutku |
| Enum vrednosti koje se moraju MENJATI (ne samo dodavati) kada se doda funkcija | Menjanje/brisanje enum vrednosti u Postgresu je migracija sa rizikom po postojeće redove | Svi MVP enumovi (`InventoryMovementType`, `ApprovalOperationType`, `TableStatus`...) su projektovani kao **podskup** finalnog seta — proširenje je uvek dodavanje nove vrednosti |

---

## Potvrda

**MVP je jednostavan za korišćenje (uči se za ~15 minuta) i brz za razvoj (bez Redis-a, bez queue-a, bez offline sinhronizacije, bez formalnog approval state-machine-a, bez recepture sistema) — dok puna verzija može da se dodaje modul po modul (real-time transport, procurement, split plaćanja, recepture, multi-lokacija UI, offline rad, fiskalizacija) bez rušenja ili ponovnog pisanja osnovnog POS toka.** Svaka tabela koja postoji u MVP šemi (`InventoryMovement`, `ApprovalRecord`, `Payment`, `OrderEvent`, `ShiftSnapshot`, `DailyClosing`) je već projektovana u finalnom, punom obliku svojih ključnih relacija (`restaurantId`/`locationId` scoping, FK-ovi, razdvojena polja za buduće tokove) — proširenja su aditivna (nove kolone, nove tabele, novi provideri iza postojećih interfejsa), ne migracije postojećih redova niti promene postojećih ugovora između modula.
