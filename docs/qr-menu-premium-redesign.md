# QR menu premium redesign — 2026-09-28

The public presentation has been rebuilt around a photographic opening, kitchen/bar navigation, compact image-and-price rows and occasional editorial photography. The Admin preview uses the same component and CSS. The photographed MASA golden screen is an **isolated local visual fixture**, not a representation of the current PREPROD restaurant content.

## 1. Design audit

The rejected component used a 160px cover strip, no kitchen/bar navigation, an initial-letter restaurant fallback, mechanical heading/rule sections and an overly narrow desktop canvas. Its modal did not provide native modal focus containment. The earlier card grid had already been removed; this change replaces the remaining presentation rather than restyling it.

The three reference images were not accessible as attachments or local paths in this session. After this was raised, the user instructed us to continue. The written reference descriptions drove the composition; no direct image-to-image comparison is claimed.

## 2. Golden screen

390px, dark theme, elegant typography, KUHINJA: a 264px food photograph with restaurant identity and table context; two 48px primary mode controls; a 56px category/search strip; numbered editorial category title; two photographed rows and an unavailable text-only row; a larger photographic dish after those compact rows. Normal photographed rows measure approximately 101px, text-only rows 78px.

- [Golden 390px — LOCAL FIXTURE](../.tmp/qr-menu/golden-390.png)
- [Full menu — LOCAL FIXTURE](../.tmp/qr-menu/golden-390-full.png)
- [Actual Next route, real MASA data, 390px](../.tmp/qr-menu/next-real-390.png)

## 3. Hero

Configured cover images load eagerly in the browser with reserved geometry and a controlled gradient. The restaurant name, optional tagline, existing logo and resolved table label come from the existing public payload. Failed or absent covers switch to a theme-driven typographic treatment with a subtle accent drawing. Logos use contain cropping. No letters, broken-image blocks or invented restaurant identity are inserted.

## 4. KUHINJA / ŠANK

The authoritative source is `MenuItem.preparationStation`: KITCHEN and BAR select their respective modes, KITCHEN_AND_BAR appears in both. NONE uses the existing `MenuCategory.type` FOOD/DRINK relationship. There are no category-name lists. Both fields were added explicitly to the existing allowlisted public projection and Admin preview adapter. The filtering helper is shared by the presentation and tests.

## 5. Menu rows

An open CSS grid allocates 72px to a mobile photograph, a flexible name/description column and an intrinsic price column. Desktop thumbnails are 80px. Price digits align right with tabular numerals; RSD is secondary below the amount. Names wrap independently, including the long Serbian test name. Descriptions use stored content and clamp to two lines in browsing; details show the full text.

## 6. Photography

Every usable item image renders, including unavailable items. A category with at least three photographed items may feature an available photographed item after the first three compact rows, in source order. This happens at most once per three categories, not before every category. Desktop selectively places that photograph alongside the row sequence. No product card grid, cart or ordering controls exist.

The fixture uses bounded stock photographs downloaded from Unsplash to `.tmp/qr-menu/assets`. They are illustrative only; fixture photos, sample descriptions, tagline, table context and DARK/ELEGANT selections are never written to PREPROD. Images in production keep their configured source URLs: no remote image proxy or server fetch is introduced. Below-fold images are lazy, all image areas reserve dimensions, and only the neutral body font is preloaded.

## 7. Real data audit

Read through an explicit PREPROD resolver, after checking the live DEVELOPMENT marker, inside `BEGIN READ ONLY` / `ROLLBACK`.

| MASA data | Result |
| --- | ---: |
| Active items | 135 |
| Usable item image URLs | 0 |
| Items without images | 135 |
| Cover | Absent |
| Logo | Absent |
| Kitchen / bar | 73 / 62 |
| Active categories | 16 |
| QR settings row | Absent; existing WARM/MODERN defaults apply |

The live restaurant cannot show food photography until authentic restaurant assets are configured. The implementation does not change that business data or silently force the dark fixture theme on MASA.

## 8. No-image state

The image column disappears entirely; the name/description expands while price alignment remains stable. Failed item images follow the same path. Unavailable text retains readable contrast, a quiet status label and desaturated photography when present. Inactive items remain excluded by the existing query.

## 9. ui-ux-pro-max

Read the installed 2.13.0 skill, ran its design-system search, then narrowed an unsuitable conversion-oriented result with the `luxury hospitality editorial` style search. Applied its Editorial Grid / Magazine guidance to the larger photographic moments, asymmetric desktop canvas and display typography; retained neutral Inter for dense dish information. Applied the skill's 44px targets, 4.5:1 text contrast, semantic theme colors, explicit focus indicators, reserved image dimensions and reduced-motion guidance. The skill's generic next/image recommendation was intentionally superseded by the user's browser-fetch/SSRF requirement. No ordering or conversion flow was adopted.

## 10. Responsive

360, 390, 412, 768 and 1440px were rendered. Container queries also keep the 364px inner Admin preview mobile-shaped inside a 1440px viewport. Category overflow is contained inside its navigation rail. Page `scrollWidth` equals layout `clientWidth`; mobile visual viewport expansion is checked separately. All measured interactive targets are at least 44px. Additional narrow-container styling preserves mode labels at 200% zoom.

## 11. Visual QA and iteration

The 390px screenshot was rendered and inspected, then refined: stronger dish text, aligned name/price tops, minimum category hit widths and real font loading. Browser tests caught an end-of-page anchor selection issue; the explicit clicked category is now honored. Real-data rendering exposed a decorative hero line expanding the viewport; the decoration is now clipped within the hero. Unit tests caught React autofocus stealing the recorded modal opener; native dialog focusing now preserves return focus. A contrast test measured ELEGANT secondary text at 4.459:1; its semantic token was darkened and the same test passed. A 200% zoom screenshot prompted removal of decorative mode icons/numbers at very narrow container widths.

Inspected screenshots include golden 360/390/412/768/1440, the complete 390px composition, ŠANK, detail, long-name search, light/elegant themes, actual Next MASA 390/1440, the narrow preview and 200% zoom. Golden imagery was verified before responsive hardening.

## 12. Exact files changed

- `apps/web/app/m/[slug]/public-menu-view.tsx`
- `apps/web/app/m/[slug]/public-menu.module.css`
- `apps/web/lib/public-menu.ts`
- `apps/web/app/(admin)/qr-menu/qr-menu-client.tsx`
- `packages/domain/qrmenu/qr-menu-service.ts`
- `packages/shared/qr-menu-theme.ts`
- `tests/unit/public-menu.test.ts`
- `tests/unit/public-menu-view.test.ts`
- `tests/unit/qr-menu-theme.test.ts`
- `tests/integration/qr-menu.test.ts`
- `scripts/visual/qr-menu-fixture.tsx`
- `scripts/visual/qr-menu-browser.mjs`
- `docs/qr-menu-premium-redesign.md`

Pre-existing `.claude/settings.json` and `artifacts/` work is excluded from the commit.

## 13. Backend / database

The only domain change explicitly projects existing station and category-type fields needed for frontend filtering. Slug resolution, tenant predicates, availability, table-token scoping, routes, URL validation and publication behavior are unchanged. Client type imports reuse the domain contract without bundling server code. No raw Prisma object is exposed. `next.config.js`, middleware and Prisma schema/migrations are unchanged. No PREPROD database writes were performed. Existing migrations were applied only to the isolated local TEST database for integration tests.

## 14. Automated verification

| Check | Result |
| --- | --- |
| Baseline full unit suite before implementation | 675 passed / 680; 5 failures |
| Final QR theme + helper + mounted frontend tests | 24 / 24 |
| Final full unit suite | 688 passed / 693; same 5 failures, no new failures |
| QR integration suite | 27 / 27, isolated local TEST database |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS; existing WorkstationsPanel dependency warning |
| Exact configured Vercel build | PASS; 155 pages generated |
| `git diff --check` | PASS |

The exact build command, from `apps/web`, was:

```text
npx prisma generate --schema=../../packages/db/prisma/schema.prisma && next build
```

The five unchanged WorkstationsPanel failures concern heartbeat convergence, independent route readiness, unconfirmed printer availability, reusing one physical printer, and LOGIN_AWARE terminal role display. Baseline and final JSON reports are in `.tmp/qr-menu/`. Failures were compared by test identity, not assumed from their count. Local Prisma generation initially encountered the DLL held by the existing dev server (and later a concurrent integration run); after the owning processes released it, the identical build command passed. No generator bypass was used.

## 15. Browser QA

**Local PASS / overall PARTIAL.** The requested `browser-qa` skill was not installed despite searching local skill/plugin locations. Actual headless Chromium/CDP was used instead, not claimed as skill execution. The final matrix contains **55 passing cases**, no runtime exceptions and no layout/target failures: both modes, requested viewport sizes, all four color and typography presets, native modal focus containment, Escape/focus restoration, search/empty states, sticky category navigation, missing/broken images, preview containment, reduced motion and 200% zoom. Ten cases exercise the actual built Next `/m/masa` route against PREPROD's read-only menu data, not an API mock.

PREPROD public access returns HTTP 302 to `https://vercel.com/sso-api`. Deployment Protection blocks anonymous end-to-end PREPROD browser verification; no protection settings were changed.

- [Machine-readable browser evidence](../.tmp/qr-menu/browser-results.json)
- [Detail at 390px](../.tmp/qr-menu/detail-390.png)
- [Desktop photographic fixture](../.tmp/qr-menu/golden-1440.png)

Reproduce after a Next build with `node scripts/visual/qr-menu-browser.mjs`. It downloads fixture photos only when absent and supports `CHROME_PATH`. An optional locally captured `.tmp/qr-menu/real-menu.json` adds the real-data snapshot checks. Use `--runtime=http://127.0.0.1:3100` to also exercise an already-running local Next build. No visual fixture route is shipped in the application.

## 16. PREPROD

Work is confined to `develop`. Commit/push follow completed verification. The final response records the exact commit and Vercel status; [deployment evidence](../.tmp/qr-menu/deployment.json) records the corresponding SHA, URL, protection response and unchanged Production deployment.

## 17. Production

**Production code was NOT changed.**

**Production database was NOT changed.**

No `main` merge, Production deploy, Production migration or Production write was performed.
