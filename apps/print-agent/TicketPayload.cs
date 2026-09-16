using System.Globalization;
using System.Text.Json;

namespace TableCore.PrintAgent;

/// <summary>
/// Konvertuje zamrznut PrintJob.content JSON payload sa servera
/// (packages/domain/printing/ticket-content.ts, nepromenjen — isti sadržaj
/// koji browser/QZ putevi već koriste preko TicketPrintPanel.tsx) u Ticket/
/// TicketLine niz koji Faza 1 TicketRaster/WindowsPrinter.Print već zna da
/// renderuje. Dispatch po "kind" — dva potpuno različita oblika deljena
/// kroz JEDAN PrintJob.content stub:
///
///  - KitchenBarTicketContent (kind: KITCHEN|BAR): stationLabel, tableLabel,
///    waiterName, orderNumber, submittedAt, items[{quantity,name,note?,
///    modifiers?:string[]}], isAdditional, paperWidthMm.
///  - ReceiptTicketContent (kind: RECEIPT): restaurantName/address/phone/
///    taxIdNumber/legalNote/footerText, receiptNumber, tableLabel,
///    waiterName, issuedAt, items[{quantity,name,unitPrice,lineTotal,
///    basePrice?,modifiers?:{name,priceDelta}[]}], subtotal, taxTotal,
///    taxBreakdown[{taxRate,taxableAmount,taxAmount}], showTaxBreakdown?,
///    discountAmount, total, currency, paymentMethod, tenderedAmount,
///    changeAmount.
///
/// RECEIPT RENDERING POLISH — this is the SECOND rewrite of the RECEIPT
/// side of this file. The first (PREPROD #425 investigation) fixed
/// correctness — RECEIPT stopped being silently parsed as a KITCHEN/BAR
/// ticket, so real prices/totals/tax/payment/legal text finally appeared at
/// all. This rewrite fixes QUALITY: real typography hierarchy, right-aligned
/// money columns, drawn (not dash-character) separators, Serbian money/date
/// formatting, a restaurant-identity/table/VAT model audit (see
/// packages/domain/settings/settings-service.ts and print-service.ts for
/// the server-side half), and a Test Print that exercises this EXACT
/// renderer instead of a disconnected diagnostic ticket. KITCHEN/BAR
/// parsing below is completely untouched.
/// </summary>
public static class TicketPayload
{
    private static string GetString(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static string? GetStringOrNull(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool GetBoolOrDefault(JsonElement el, string prop, bool fallback) =>
        el.TryGetProperty(prop, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False) ? v.GetBoolean() : fallback;

    private static decimal GetDecimalOrZero(string raw) =>
        decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out var value) ? value : 0m;

    // RECEIPT RENDERING POLISH — Serbian money formatting ("5.760,00": dot
    // thousands separator, comma decimal separator), built explicitly
    // rather than relying on an installed "sr-Latn-RS" culture on the host
    // Windows machine — deterministic regardless of what's installed,
    // same "never trust the host machine's locale" principle the old
    // Money() helper already used for parsing.
    private static readonly NumberFormatInfo SerbianMoneyFormat = new()
    {
        NumberDecimalSeparator = ",",
        NumberGroupSeparator = ".",
        NumberDecimalDigits = 2,
        NumberGroupSizes = [3],
    };

    private static string FormatMoney(decimal value) => value.ToString("N2", SerbianMoneyFormat);

    /// <summary>Server sends Prisma Decimal values as plain strings (e.g.
    /// "700.00"). Falls back to the raw string if it's ever not parseable,
    /// rather than silently printing "0,00" for a genuinely malformed
    /// value.</summary>
    private static string Money(string raw) =>
        decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out var value) ? FormatMoney(value) : raw;

    private static string FormatDate(string raw)
    {
        var parsed = DateTime.TryParse(raw, null, DateTimeStyles.RoundtripKind, out var value) ? value.ToLocalTime() : DateTime.Now;
        // Serbian convention: "16.09.2026. 18:56" — a literal full stop
        // after the year, no seconds (a receipt customer/waiter reads at a
        // glance, not an audit log).
        return parsed.ToString("dd.MM.yyyy'.' HH:mm", CultureInfo.InvariantCulture);
    }

    public static (Ticket Ticket, int PaperWidthMm, string Station) Parse(JsonElement content) =>
        GetString(content, "kind") == "RECEIPT" ? ParseReceipt(content) : ParseKitchenBar(content);

    private static (Ticket Ticket, int PaperWidthMm, string Station) ParseKitchenBar(JsonElement content)
    {
        var stationLabel = GetString(content, "stationLabel");
        var tableLabel = GetString(content, "tableLabel");
        var waiterName = GetString(content, "waiterName");
        var orderNumber = GetString(content, "orderNumber");
        var submittedAt = GetString(content, "submittedAt");
        var isAdditional = content.TryGetProperty("isAdditional", out var ia) && ia.ValueKind == JsonValueKind.True;
        var paperWidthMm = content.TryGetProperty("paperWidthMm", out var pw) && pw.TryGetInt32(out var pwVal) ? pwVal : 80;
        var kind = GetString(content, "kind");
        var station = kind == "BAR" ? "BAR" : "KITCHEN";

        var lines = new List<TicketLine>
        {
            new("TABLECORE", 16, true),
            new(string.IsNullOrWhiteSpace(stationLabel) ? station : stationLabel, 14, true),
        };
        if (isAdditional) lines.Add(new("DODATNA PORUDZBINA", 12, true));
        lines.Add(new($"STO {tableLabel}".Trim(), 18, true));
        if (!string.IsNullOrWhiteSpace(orderNumber)) lines.Add(new($"NARUDZBINA #{orderNumber}", 10));
        if (!string.IsNullOrWhiteSpace(waiterName)) lines.Add(new($"KONOBAR: {waiterName}", 10));

        if (content.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in items.EnumerateArray())
            {
                var quantity = item.TryGetProperty("quantity", out var q) && q.TryGetInt32(out var qVal) ? qVal : 1;
                var name = GetString(item, "name");
                if (!string.IsNullOrWhiteSpace(name)) lines.Add(new($"{quantity}x {name}", 13, true));

                if (item.TryGetProperty("modifiers", out var mods) && mods.ValueKind == JsonValueKind.Array)
                {
                    foreach (var m in mods.EnumerateArray())
                    {
                        if (m.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(m.GetString()))
                            lines.Add(new($"  {m.GetString()}", 10));
                    }
                }

                var note = GetString(item, "note");
                if (!string.IsNullOrWhiteSpace(note)) lines.Add(new($"  * {note}", 10));
            }
        }

        var time = DateTime.TryParse(submittedAt, null, DateTimeStyles.RoundtripKind, out var parsed)
            ? parsed.ToLocalTime().ToString("HH:mm")
            : DateTime.Now.ToString("HH:mm");
        lines.Add(TicketLine.Rule());
        lines.Add(new(time, 10));

        return (new Ticket([.. lines]), paperWidthMm, station);
    }

    private static readonly Dictionary<string, string> PaymentMethodLabel = new() { ["CASH"] = "GOTOVINA", ["CARD"] = "KARTICA" };

    /// <summary>
    /// The receipt BODY — metadata (table/waiter/date), items, financial
    /// summary and payment section. Deliberately factored out of
    /// <see cref="ParseReceipt"/> so a REAL receipt and the Admin "Test
    /// Print" diagnostic (see AgentRunner.cs) render this exact section
    /// through ONE implementation — the actual quality bar this task exists
    /// to raise — while each wraps it in its own, clearly different
    /// header/footer (a real restaurant identity vs. an unmistakable
    /// "TEST ŠTAMPE" banner). Never calculates anything itself — every
    /// number comes straight from the already-frozen `content` payload.
    /// </summary>
    private static List<TicketLine> BuildReceiptBodyLines(JsonElement content)
    {
        var tableLabel = GetString(content, "tableLabel");
        var waiterName = GetString(content, "waiterName");
        var issuedAt = GetString(content, "issuedAt");
        var currency = GetString(content, "currency");
        var paymentMethod = GetString(content, "paymentMethod");
        // Missing (older receipts dispatched before this field existed) ->
        // true, matching the always-shown behavior every restaurant had
        // before the Admin toggle existed (see settings-service.ts).
        var showTaxBreakdown = GetBoolOrDefault(content, "showTaxBreakdown", true);

        var lines = new List<TicketLine>();

        // Metadata — the table LABEL is already the complete, authoritative,
        // Admin-chosen display name (e.g. "Sto 1", "Terasa 5", "12" — see
        // table-service.ts, free-form up to 40 chars). The previous
        // "STO {label}" render prepended a SECOND "STO" on top of a label
        // that (per this restaurant's own seed convention) already reads
        // "Sto 1", producing the reported "STO Sto 1" duplication. Trust the
        // label as-is; never re-derive or re-prefix it.
        if (!string.IsNullOrWhiteSpace(tableLabel)) lines.Add(new($"Sto: {tableLabel}", 11));
        if (!string.IsNullOrWhiteSpace(waiterName)) lines.Add(new($"Konobar: {waiterName}", 11));
        lines.Add(new(FormatDate(issuedAt), 10));
        lines.Add(TicketLine.Rule());

        if (content.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in items.EnumerateArray())
            {
                var quantity = item.TryGetProperty("quantity", out var q) && q.TryGetInt32(out var qVal) ? qVal : 1;
                var name = GetString(item, "name");
                if (string.IsNullOrWhiteSpace(name)) continue;

                // Item name gets its OWN full-width line — never sharing
                // space with a price column — so a long/very long name can
                // wrap freely (TicketRaster already word-wraps a bounded
                // rectangle) without ever overlapping or displacing a price.
                lines.Add(new($"{quantity} × {name}", 12));

                // basePrice falls back to lineTotal for a receipt issued
                // before basePrice existed (P3.2) — same rule as before.
                var basePriceRaw = GetStringOrNull(item, "basePrice") ?? GetString(item, "lineTotal");
                var baseUnitPrice = GetDecimalOrZero(basePriceRaw);
                var baseLineTotal = baseUnitPrice * quantity;
                lines.Add(quantity > 1
                    // "3 × 200,00 ... 600,00" — unit price on the left,
                    // extended total on the right, same line.
                    ? TicketLine.Row($"{quantity} × {FormatMoney(baseUnitPrice)}", FormatMoney(baseLineTotal), 12)
                    // Quantity 1: the unit price and the line total are the
                    // same number — showing both would just repeat it, so
                    // print the total alone, right-aligned.
                    : TicketLine.Row("", FormatMoney(baseLineTotal), 12));

                if (item.TryGetProperty("modifiers", out var mods) && mods.ValueKind == JsonValueKind.Array)
                {
                    foreach (var m in mods.EnumerateArray())
                    {
                        var modName = GetString(m, "name");
                        if (string.IsNullOrWhiteSpace(modName)) continue;
                        var priceDelta = GetDecimalOrZero(GetString(m, "priceDelta"));
                        var modTotal = priceDelta * quantity;
                        lines.Add(modTotal switch
                        {
                            > 0 => TicketLine.Row($"  + {modName}", FormatMoney(modTotal), 10),
                            < 0 => TicketLine.Row($"  − {modName}", FormatMoney(Math.Abs(modTotal)), 10),
                            _ => new($"  {modName}", 10),
                        });
                    }
                }
            }
        }

        lines.Add(TicketLine.Rule());
        if (showTaxBreakdown)
        {
            var taxBreakdown = content.TryGetProperty("taxBreakdown", out var tb) && tb.ValueKind == JsonValueKind.Array
                ? tb.EnumerateArray().ToArray()
                : [];
            // Multiple simultaneous VAT rates are already a real, supported
            // case (packages/domain/orders/order-totals.ts groups by rate) —
            // collapsing them into one fake blended line would misreport
            // the actual tax breakdown. Only omit the "(rate%)" suffix when
            // there is exactly one rate, matching the simpler common case.
            var multiRate = taxBreakdown.Length > 1;
            foreach (var entry in taxBreakdown)
            {
                var rate = GetString(entry, "taxRate");
                var suffix = multiRate ? $" ({rate}%)" : "";
                lines.Add(TicketLine.Row($"Osnovica{suffix}", Money(GetString(entry, "taxableAmount")), 11));
                lines.Add(TicketLine.Row($"PDV{suffix}", Money(GetString(entry, "taxAmount")), 11));
            }
            if (taxBreakdown.Length == 0)
            {
                // Defensive fallback for a malformed/missing breakdown —
                // still shows SOMETHING authoritative (the frozen subtotal/
                // tax totals) rather than silently rendering nothing.
                lines.Add(TicketLine.Row("Osnovica", Money(GetString(content, "subtotal")), 11));
                lines.Add(TicketLine.Row("PDV", Money(GetString(content, "taxTotal")), 11));
            }
        }
        var discountAmount = GetStringOrNull(content, "discountAmount");
        if (discountAmount != null && GetDecimalOrZero(discountAmount) > 0)
            lines.Add(TicketLine.Row("Popust", $"-{Money(discountAmount)}", 11));

        lines.Add(TicketLine.Rule());
        lines.Add(TicketLine.Row("UKUPNO", $"{Money(GetString(content, "total"))} {currency}", 15, true));
        lines.Add(TicketLine.Rule());

        lines.Add(TicketLine.Row("Plaćanje", PaymentMethodLabel.GetValueOrDefault(paymentMethod, paymentMethod), 11));
        if (paymentMethod == "CASH")
        {
            lines.Add(TicketLine.Row("Primljeno", Money(GetString(content, "tenderedAmount")), 11));
            lines.Add(TicketLine.Row("Kusur", Money(GetString(content, "changeAmount")), 11));
        }

        return lines;
    }

    /// <summary>Mirrors TicketPrintPanel.tsx's ReceiptTicket component in
    /// substance (same fields, same authoritative frozen values) — layout
    /// itself is now a deliberate thermal-receipt design (see
    /// BuildReceiptBodyLines), not a line-for-line mirror of the browser's
    /// flex layout.</summary>
    private static (Ticket Ticket, int PaperWidthMm, string Station) ParseReceipt(JsonElement content)
    {
        var restaurantName = GetString(content, "restaurantName");
        var restaurantLegalName = GetStringOrNull(content, "restaurantLegalName");
        var address = GetStringOrNull(content, "address");
        var phone = GetStringOrNull(content, "phone");
        var taxIdNumber = GetStringOrNull(content, "taxIdNumber");
        var legalNote = GetString(content, "legalNote");
        var footerText = GetStringOrNull(content, "footerText");
        var receiptNumber = content.TryGetProperty("receiptNumber", out var rn) && rn.TryGetInt32(out var rnVal) ? rnVal.ToString(CultureInfo.InvariantCulture) : "?";
        var paperWidthMm = content.TryGetProperty("paperWidthMm", out var pw) && pw.TryGetInt32(out var pwVal) ? pwVal : 80;

        var lines = new List<TicketLine>
        {
            // Restaurant identity is prominent but not wasteful — a single
            // bold, centered, uppercased line (never several giant lines).
            new(string.IsNullOrWhiteSpace(restaurantName) ? "TABLECORE" : restaurantName.ToUpperInvariant(), 15, true, TicketAlign.Center),
        };
        if (!string.IsNullOrWhiteSpace(restaurantLegalName)) lines.Add(new(restaurantLegalName, 9, false, TicketAlign.Center));
        if (!string.IsNullOrWhiteSpace(address)) lines.Add(new(address, 9, false, TicketAlign.Center));
        if (!string.IsNullOrWhiteSpace(phone)) lines.Add(new(phone, 9, false, TicketAlign.Center));
        if (!string.IsNullOrWhiteSpace(taxIdNumber)) lines.Add(new($"PIB: {taxIdNumber}", 9, false, TicketAlign.Center));
        lines.Add(TicketLine.Rule());
        lines.Add(new($"RAČUN #{receiptNumber}", 13, true, TicketAlign.Center));

        lines.AddRange(BuildReceiptBodyLines(content));

        lines.Add(TicketLine.Rule());
        var thankYou = string.IsNullOrWhiteSpace(footerText) ? "Hvala na poseti!" : footerText;
        lines.Add(new(thankYou, 10, false, TicketAlign.Center));
        // Non-fiscal status — this is still the current NON-FISCAL TableCore
        // receipt (see requirement #6); emphasized in caps like a real legal
        // disclaimer, exact wording stays Admin-configurable.
        if (!string.IsNullOrWhiteSpace(legalNote)) lines.Add(new(legalNote.ToUpperInvariant(), 9, true, TicketAlign.Center));

        return (new Ticket([.. lines]), paperWidthMm, "RECEIPT");
    }

    /// <summary>
    /// RECEIPT RENDERING POLISH, requirement #17 — Admin → Štampači → Test
    /// Print for a RECEIPT route must exercise the REAL receipt body
    /// renderer (BuildReceiptBodyLines above), not a disconnected
    /// diagnostic ticket, so a renderer regression can never hide behind a
    /// Test Print that "looks fine" while real receipts don't. Built
    /// ENTIRELY LOCALLY in the Agent from hardcoded synthetic data — no
    /// server round trip for content, no real Order/Payment/Receipt/
    /// PrintJob row, no accounting/inventory/KDS effect (see
    /// AgentRunner.HandleTestPrintRequest, which only asks the SERVER
    /// whether a test print was requested and for which route — never for
    /// what to print). The header/footer are deliberately DIFFERENT from a
    /// real receipt's (clearly marked "TEST ŠTAMPE", never "RAČUN #") so it
    /// can never be mistaken for a real customer transaction, while the
    /// stress-test data below (short/long/very-long names, quantity 1/2/3,
    /// Serbian characters, multiple VAT rates, modifiers, a cash payment
    /// with change) exercises every rendering path a real receipt can hit.
    /// </summary>
    public static Ticket BuildReceiptTestPrintTicket(string workstationName, string printerName, int paperWidthMm, string agentVersion)
    {
        const string syntheticJson = """
            {
              "kind": "RECEIPT",
              "tableLabel": "Terasa 5",
              "waiterName": "Marko Marković",
              "issuedAt": "2026-09-16T18:56:00.000Z",
              "showTaxBreakdown": true,
              "items": [
                { "quantity": 1, "name": "Kafa", "basePrice": "180.00", "lineTotal": "180.00" },
                { "quantity": 2, "name": "Pivo", "basePrice": "300.00", "lineTotal": "600.00" },
                { "quantity": 3, "name": "Šopska salata", "basePrice": "350.00", "lineTotal": "1050.00" },
                {
                  "quantity": 1, "name": "Dimljeni svinjski vrat sa mladim krompirom i lepinjom",
                  "basePrice": "1450.00", "lineTotal": "1600.00",
                  "modifiers": [
                    { "name": "Extra kačkavalj", "priceDelta": "150.00" },
                    { "name": "Bez luka", "priceDelta": "0.00" }
                  ]
                },
                { "quantity": 1, "name": "Specijalni dnevni meni sa dodatnim prilogom po izboru kuvara i domaćim hlebom", "basePrice": "12500.00", "lineTotal": "12500.00" }
              ],
              "subtotal": "15930.00",
              "taxTotal": "2653.34",
              "taxBreakdown": [
                { "taxRate": "20", "taxableAmount": "13100.00", "taxAmount": "2620.00" },
                { "taxRate": "10", "taxableAmount": "333.40", "taxAmount": "33.34" }
              ],
              "discountAmount": null,
              "total": "18583.34",
              "currency": "RSD",
              "paymentMethod": "CASH",
              "tenderedAmount": "20000.00",
              "changeAmount": "1416.66"
            }
            """;
        var body = BuildReceiptBodyLines(JsonDocument.Parse(syntheticJson).RootElement);

        var header = new List<TicketLine>
        {
            new("TABLECORE", 15, true, TicketAlign.Center),
            new("TEST ŠTAMPE", 12, true, TicketAlign.Center),
            TicketLine.Rule(),
            new($"Radna stanica: {workstationName}", 9, false, TicketAlign.Center),
            new($"Štampač: {printerName}   Papir: {paperWidthMm} mm", 9, false, TicketAlign.Center),
            new($"Ruta: RECEIPT   Verzija: {agentVersion}", 9, false, TicketAlign.Center),
            new("Test znakova: č ć ž š đ Č Ć Ž Š Đ", 9, false, TicketAlign.Center),
            TicketLine.Rule(),
        };
        var footer = new List<TicketLine>
        {
            TicketLine.Rule(),
            new("TEST USPEŠAN", 12, true, TicketAlign.Center),
            new("TEST ŠTAMPE — NIJE RAČUN", 9, true, TicketAlign.Center),
        };
        return new Ticket([.. header, .. body, .. footer]);
    }
}
