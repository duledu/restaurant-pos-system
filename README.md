# Restaurant Control System — Evropa MM

Multi-tenant restoranski POS sistem: konobari, stolovi, porudžbine, kuhinja,
šank, smene, meni, RBAC, audit log. Vlasnički administrativni panel.

> **Status:** Faza 1-4 implementirane (auth/RBAC, meni, smene i konobarski
> POS, kuhinja/šank KDS). Vidi `docs/` za pun arhitektonski plan i plan po
> fazama.

## Sadržaj

- [Project Overview](#project-overview)
- [Features](#features)
- [Technology Stack](#technology-stack)
- [User Roles](#user-roles)
- [Project Structure](#project-structure)
- [Requirements](#requirements)
- [Local Installation](#local-installation)
- [Environment Variables](#environment-variables)
- [Database Setup](#database-setup)
- [Docker PostgreSQL Setup](#docker-postgresql-setup)
- [Prisma Migrations](#prisma-migrations)
- [Seed Data](#seed-data)
- [Test Accounts](#test-accounts)
- [Running the App](#running-the-app)
- [Testing User Roles](#testing-user-roles)
- [GitHub Setup](#github-setup)
- [Vercel Deployment](#vercel-deployment)
- [Production Database](#production-database)
- [Security Notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Useful Commands](#useful-commands)
- [License](#license)

## Project Overview

RCS je modularni monolit (jedna Next.js aplikacija, jedna PostgreSQL baza)
projektovan da počne jednostavno (MVP za jedan restoran, jednu kuhinju, jedan
šank) ali da se proširi modul-po-modul (multi-lokacija, inventar, recepture,
fiskalizacija) bez rušenja osnovnog POS toka. Vidi `docs/01-RCS-Plan-v2-MVP.md`
za arhitektonske odluke i extension point-ove.

## Features

- Email/lozinka prijava (admin/menadžer) + PIN prijava (konobar/kuhinja/šank) sa lockout zaštitom
- RBAC sa server-side proverom na svakom endpointu i svakoj ruti (ne samo UI sakrivanje)
- Menu Management: kategorije, artikli, cene, dostupnost, kuhinja/šank rutiranje — sve iz baze, bez redeploy-a
- Konobarski POS: grid stolova, dodavanje artikala, slanje porudžbine sa zaštitom od duplog slanja (idempotency key)
- Kuhinja/Šank KDS: kartice porudžbina, zvučna notifikacija, statusi (Novo → Prihvaćeno → U pripremi → Spremno)
- Audit log za sve osetljive radnje (cena, brisanje, prijava, slanje porudžbine...)
- Append-only istorija (OrderEvent, AuditLog) — ništa se tiho ne prepisuje

## Technology Stack

Next.js 14 (App Router) · TypeScript (strict) · React 18 · PostgreSQL 16 ·
Prisma ORM · Tailwind CSS · Zod · SSE (real-time, bez Redis-a u MVP-u)

## User Roles

| Rola | Pristup |
|---|---|
| OWNER / ADMIN | `/admin` — pun pristup |
| MANAGER | `/admin` — meni, zaposleni (bez cene artikla ako nije eksplicitno dozvoljeno) |
| WAITER | `/waiter` — stolovi, porudžbine |
| KITCHEN | `/kitchen` — samo stavke za kuhinju |
| BAR | `/bar` — samo stavke za šank |

Uloga se proverava i na klijentu (redirect) i na serveru (svaki layout i
API endpoint) — ručni unos URL-a za tuđu ulogu ne radi.

## Project Structure

```
apps/web/              Next.js aplikacija (admin/waiter/kitchen/bar rute + API)
packages/db/            Prisma schema, migracije, seed
packages/auth/           RBAC, sesije, PIN/password autentifikacija
packages/domain/         Poslovni moduli (menu, orders, shifts, production, audit...)
packages/shared/         Zod šeme, tipovi, role→ruta mapiranje
docker/                  docker-compose (lokalni Postgres)
tests/                   unit i integration testovi (vitest)
docs/                    arhitektonski planovi po fazama
```

## Requirements

- Node.js ≥ 20
- npm ≥ 10 (workspaces)
- Docker + Docker Compose (za lokalni Postgres) **ili** pristup cloud Postgres bazi (Neon/Supabase) **ili** ništa od navedenog — vidi "Lokalni razvoj bez Dockera" ispod.

## Local Installation

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd restaurant-control-system
cp .env.example .env
npm install
```

## Lokalni razvoj bez Dockera (jedna komanda, čista mašina)

Ako nemaš Docker (ili ne želiš da diraš postojeću sistemsku Postgres
instalaciju), `npm run dev:local` pokreće KOMPLETNO samodovoljno okruženje —
bez Docker-a, bez sistemskog Postgres servisa, bez potrebe za `.env` fajlom:

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd restaurant-control-system
npm install
npm run dev:local
```

Ova jedna komanda (`scripts/dev-local.mjs`):

1. Preuzima i pokreće pravi Postgres 16 binarni fajl (`embedded-postgres`
   paket) u `.local-postgres-data/` na portu **55432** — potpuno odvojeno od
   bilo koje sistemske Postgres instalacije na 5432, ne dira je i ne
   zahteva njenu lozinku.
2. Pri prvom pokretanju inicijalizuje klaster i kreira bazu `rcs_dev`.
3. Primenjuje Prisma migracije (`prisma migrate deploy`).
4. Seed-uje dev naloge (samo ako još ne postoje — bezbedno za ponovno
   pokretanje).
5. Pokreće Next.js dev server sa `DATABASE_URL` ubrizganim direktno u
   proces (nema potrebe da praviš `.env`).

Ctrl+C u tom terminalu gasi i Next.js i embedded Postgres. Podaci ostaju u
`.local-postgres-data/` (gitignored) između pokretanja — samo prvi put se
inicijalizuju i seed-uju.

Ako želiš samo bazu (npr. za pokretanje `tests/integration/*` protiv
realnog Postgres-a) bez Next.js dev servera:

```bash
npm run db:local
```

Dev nalozi za prijavu (kreirani seed-om, vidi `packages/db/prisma/seed.ts`):

| Email | Lozinka | Rola | Prijava vodi na |
|---|---|---|---|
| owner@dev.local | DevOwner123! | OWNER | /menu |
| admin@dev.local | DevAdmin123! | ADMIN | /menu |
| manager@dev.local | DevManager123! | MANAGER | /menu |
| konobar1@dev.local | DevWaiter123! | WAITER | /waiter |
| kuhinja@dev.local | DevKitchen123! | KITCHEN | /kitchen |
| sank@dev.local | DevBar123! | BAR | /bar |

## Environment Variables

Vidi `.env.example` za kompletnu, komentarisanu listu. Minimalno potrebno
za lokalni rad:

```env
DATABASE_URL=postgresql://rcs:rcs_dev_password@localhost:5432/rcs_dev?schema=public
AUTH_SECRET=<generiši: openssl rand -base64 32>
NODE_ENV=development
```

## Database Setup

### Docker PostgreSQL Setup

```bash
npm run docker:up
```

Pokreće PostgreSQL 16 na `localhost:5432` (baza `rcs_dev`, korisnik `rcs`) —
tačne vrednosti su već u `.env.example`.

Alternativa: cloud PostgreSQL (Neon, Supabase) — samo zameni `DATABASE_URL`
u `.env` vrednošću koju dobiješ od provajdera.

## Prisma Migrations

```bash
npm run db:generate     # generiše Prisma Client (potreban internet pristup)
npm run db:migrate      # primenjuje migracije (razvoj)
npm run db:migrate:deploy   # primenjuje migracije (produkcija, non-interactive)
```

Početna migracija (`packages/db/prisma/migrations/20260805100000_init/`) je
već u repozitorijumu i sadrži kompletnu Fazu 1-3 šemu. `npm run db:migrate`
je primenjuje na tvoju bazu.

## Seed Data

```bash
npm run db:seed          # restoran, lokacija, 10 stolova, role/permisije, test nalozi
npm run db:seed:menu     # meni (16 kategorija, 137 artikala) — vidi test accounts ispod
```

`db:seed:menu` zahteva `RESTAURANT_ID` env promenljivu — ispisuje je
`db:seed` na kraju svog izlaza.

Seed je idempotentan gde je to bitno (meni koristi UPSERT po slug-u —
ponovno pokretanje ne pravi duplikate). `db:seed` (Faza 1 dev podaci) pravi
NOV restoran na svako pokretanje — namerno, za čist razvojni reset.

## Test Accounts

⚠️ Samo za lokalni razvoj. **Promeniti pre produkcije.**

| Rola | Email | Lozinka |
|---|---|---|
| Owner | owner@dev.local | DevOwner123! |
| Admin | admin@dev.local | DevAdmin123! |
| Manager | manager@dev.local | DevManager123! |
| Konobar | konobar1@dev.local | DevWaiter123! |
| Kuhinja | kuhinja@dev.local | DevKitchen123! |
| Šank | sank@dev.local | DevBar123! |

PIN prijava (konobar/kuhinja/šank na registrovanom uređaju): konobar1 →
`1001`, kuhinja → `2001`, šank → `3001`.

Development blok sa test nalozima na `/login` se prikazuje SAMO kad je
`NODE_ENV=development` — nikad u produkciji.

## Running the App

```bash
npm run dev
```

Aplikacija je na `http://localhost:3000`. Root ruta (`/`) automatski
preusmerava na login ili odgovarajući dashboard po ulozi.

## Testing User Roles

1. Prijavi se kao `owner@dev.local` → `/admin` → proveri meni
2. Kreiraj/proveri konobara u Admin panelu (ili koristi seed nalog)
3. Prijavi se kao konobar → `/waiter/tables` → otvori smenu → izaberi sto
4. Dodaj hranu i piće → pošalji porudžbinu
5. Prijavi se (drugi browser/inkognito) kao `kuhinja@dev.local` → `/kitchen` → hrana se pojavljuje
6. Prijavi se kao `sank@dev.local` → `/bar` → piće se pojavljuje
7. Kuhinja/šank pomeraju status kroz Prihvaćeno → U pripremi → Spremno
8. Konobar na svom ekranu vidi status uživo (osvežava se automatski)

## GitHub Setup

```bash
git init
git add .
git commit -m "Initial restaurant POS system"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

Zameni `YOUR_GITHUB_REPOSITORY_URL` stvarnim URL-om tvog repozitorijuma.

## Vercel Deployment

> Ovaj deo dokumentuje korake za KASNIJE — deployment nije još urađen.

1. Napravi GitHub repozitorijum i pushuj kod (vidi gore)
2. Uvezi projekat na [vercel.com/new](https://vercel.com/new)
3. Podesi environment promenljive u Vercel dashboard-u (Settings → Environment Variables): `DATABASE_URL`, `AUTH_SECRET`, `NODE_ENV=production`
4. Poveži produkcionu PostgreSQL bazu (Neon/Supabase preporučeno za Vercel)
5. Build komanda (Vercel default je dovoljan, ali eksplicitno): `npx prisma generate && npx prisma migrate deploy && npm run build`
6. Pokreni produkcioni seed RUČNO i KONTROLISANO (ne automatski na svaki deploy) — vidi Production Database ispod
7. Proveri da build prolazi u Vercel dashboard-u pre nego što podeliš link

## Production Database

- Preporučeno: Neon ili Supabase (serverless-friendly PostgreSQL, radi dobro sa Vercel-om)
- `npx prisma migrate deploy` (ne `migrate dev`) za primenu migracija u produkciji — ne kreira nove migracije, samo primenjuje postojeće
- Produkcioni seed (ako je uopšte potreban) pokrenuti ručno, jednom, sa produkcionim vrednostima — nikad development test naloge

## Security Notes

- Sve poslovne kalkulacije (cena, dostupnost, RBAC) se rade isključivo na serveru
- PIN i lozinke se čuvaju samo kao hash (scrypt)
- `AUTH_SECRET` mora biti jak nasumičan string u produkciji — aplikacija baca grešku ako je ostavljen na default vrednost dok je `NODE_ENV=production`
- Test nalozi se prikazuju na login ekranu SAMO u development modu

## Troubleshooting

**`prisma generate` javlja grešku o preuzimanju engine binarnih fajlova**
→ Proveri internet konekciju / firewall pravila prema `binaries.prisma.sh`.

**`npm run build` puca sa "@prisma/client did not initialize yet"**
→ Pokreni `npm run db:generate` pre build-a.

**Port 5432 je zauzet**
→ Već imaš lokalni Postgres. Promeni port u `docker/docker-compose.yml` i u `DATABASE_URL`.

**Seed javlja grešku o duplikatu**
→ `db:seed` pravi nov restoran svaki put — ako želiš čist reset, obriši i ponovo kreiraj bazu (`npm run docker:down && npm run docker:up`).

## Useful Commands

```bash
npm run dev              # razvoj
npm run build            # produkcioni build
npm run typecheck        # TypeScript provera bez emitovanja
npm run lint             # ESLint
npm run test:unit        # vitest (unit + integration)
npm run db:studio        # Prisma Studio (vizuelni pregled baze)
npm run docker:up        # pokreni lokalni Postgres
npm run docker:down      # zaustavi lokalni Postgres
```

## License

Proprietary — All Rights Reserved. Vidi `LICENSE`. Kod se ne sme kopirati,
menjati niti distribuirati bez izričite pisane dozvole vlasnika.
