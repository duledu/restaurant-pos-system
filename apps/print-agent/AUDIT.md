# Existing printing audit

Inspected before prototype code was written. Source behavior takes precedence over older comments that still describe the browser as the only transport.

| Area | Current behavior |
| --- | --- |
| `packages/db/prisma/schema.prisma`: PrintJob | Frozen JSON content, station/type, lifecycle, attempts, timestamps, failure reason and reprint links. Unique `(orderId, dispatchKey)` prevents duplicate dispatch rows. |
| `packages/domain/printing/print-service.ts`: dispatch | Kitchen/Bar routing comes from OrderItemStation; no second routing authority. Submit/void/payment dispatch happens after business commits. Upserts use stable submit/void/receipt keys; additional order rounds have separate suffixes. |
| Ticket content | `ticket-content.ts` builds structured Kitchen/Bar, STORNO and Receipt snapshots. Kitchen/Bar include names, quantities, notes, modifier strings, station, table, waiter, time and additional-order marker; no prices. Receipt uses frozen receipt data. Reprint is audited with a new dispatch key. |
| PrinterConfig | One row per location/station, with name, type, 58/80 width, isEnabled, autoPrint, copies and reserved address fields. Width is snapshotted at dispatch, default 80. It must not be re-read to alter an existing job. |
| Claim | beginPrintAttempt performs atomic updateMany WHERE PENDING → PRINTING, with station/location/tenant access checks. One concurrent claimant wins. |
| KDS dispatch | KdsClient polls every four seconds, serializes a local queue, tracks seen IDs, calls beginPrintJob, then resolves a transport using **claimed.content**. Failed jobs require explicit retry. |
| Eligibility | Current pending list derives autoPrintEligible from **isEnabled**, default true. It does not use PrinterConfig.autoPrint. Preserve this behavior in Phase 1; align it deliberately in a later migration/rollout. |
| Transport | `apps/web/lib/print-transport.ts`: PrintTransport.print(): Promise<void>, BrowserPrintTransport and QzPrintTransport. Browser isolates a rendered ticket and measures page height. QZ takes the frozen structured snapshot through qz-ticket-html and qz-client. |
| QZ selection | qz-auto-transport.ts selects QZ using per-browser localStorage settings. Missing library/connection falls back to browser. Once connected, printer failures propagate; no secondary print attempt. |
| QZ output | qz-client.ts enumerates/validates the named printer, measures ticket HTML height, configures explicit width/height, and submits pixel HTML. It does not claim physical-paper acknowledgement. |
| Browser UI | TicketPrintPanel renders Kitchen/Bar, STORNO and Receipt snapshots. Waiter bill-client retains the receipt/browser path. |
| Confirmation/retry | printAndConfirm awaits transport, then confirms success. confirmPrintResult marks PRINTED/FAILED and increments attempts; beginPrintAttempt also increments attempts. retryPrintJob resets a FAILED row to PENDING. No changes made. |

## Exact future insertion point

A `PrintAgentTransport implements PrintTransport` can sit alongside QzPrintTransport in `apps/web/lib/print-transport.ts`. Its constructor must capture job ID, immutable claimed content and a scoped device/attempt identity. Selection belongs at the existing `resolveAutoPrintTransport` call in `KdsClient` immediately **after** a successful `beginPrintJob`; a failed claim must never invoke it. Future mapping must translate all supported snapshot kinds explicitly, including STORNO, preserve notes/modifiers/additional markers and paper width, and reject a station/width mismatch rather than silently changing a frozen job.

The Phase 1 `/print` line DTO is deliberately not that production snapshot contract. No frontend transport, browser token exposure, schema mutation or server endpoint has been added. Browser-origin requests are blocked. An outbound Phase 2 agent will instead receive the claimed job directly from a server dispatcher using the same claim service. It will need an exclusive station/device assignment so browser/QZ and agent dispatchers cannot race during rollout.

The current Promise<void> transport can represent “submission returned” but cannot express accepted/unknown/physically printed separately. Before activation, explicitly define success as a submission acknowledgement, add structured outcome handling for uncertain cases, and avoid automatically falling back to another transport after an ambiguous submit. Do not plug ACCEPTED into confirm success.

## Existing duplicate-prevention limits to resolve before production

- Stale PRINTING rows older than 90 seconds return to PENDING during station polling. An agent must reconcile a durable local submission record before printing a reclaimed job.
- A lost server confirmation after successful spool submission currently enters the printAndConfirm failure path. That is not evidence that no paper printed.
- confirmPrintResult does not condition its update on a claim generation/status. A late acknowledgement could affect a newer attempt. Production agent acknowledgements need scoped attempt tokens and conditional transitions.
- Dispatch uniqueness and atomic claims prevent duplicate records/concurrent attempts; they do not guarantee exactly-once physical output across process crashes or network uncertainty. POC replay suppression is process-local only.

These are audit findings, not changes to the existing production lifecycle.
