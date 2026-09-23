using System.Drawing;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

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

    // RECEIPT RENDERING POLISH — deterministic layout-fitting engine.
    //
    // The physical print revealed a real defect no amount of "looks fine in
    // theory" review caught: a two-column row (TicketLine.Row) was drawn by
    // simply near/far-aligning both strings in the same rectangle, trusting
    // that "both sides are short" always holds. It does NOT hold for the
    // TOTAL row specifically — a large, BOLD font combined with a long
    // amount ("999.999,00 RSD") can be wider than the label leaves room
    // for, so the two strings visually collide on the real 58mm printable
    // width. The fix is to actually MEASURE (GDI+ MeasureString, the same
    // engine TicketRaster itself uses to size the page) before committing
    // to a one-line layout, and fall back to a verified-safe arrangement
    // when it wouldn't fit — never a guess, never "worked for one example".
    private static float MeasureWidthPx(string text, float size, bool bold)
    {
        using var bmp = new Bitmap(1, 1);
        bmp.SetResolution(TicketRaster.Dpi, TicketRaster.Dpi);
        using var g = Graphics.FromImage(bmp);
        using var font = new Font("Arial", size, bold ? FontStyle.Bold : FontStyle.Regular);
        return g.MeasureString(text, font).Width;
    }

    // Minimum breathing room between the two columns of a same-line row —
    // small enough to waste no meaningful width on a 58mm roll, large
    // enough that the two strings never visually touch.
    private const float MinRowGapPx = 6f;

    /// <summary>
    /// A label/value money row (Osnovica, PDV, Popust, Plaćanje, Primljeno,
    /// Kusur, and an item's quantity×unit-price breakdown) — fits on one
    /// line when MEASURED to fit, otherwise falls back to the value alone,
    /// right-aligned, on its own line (the label having already been (or
    /// still being) emitted separately) rather than ever overlapping.
    /// These labels are short, fixed Serbian words, so the one-line case is
    /// the overwhelming common path — this only ever activates for a
    /// genuinely extreme value.
    /// </summary>
    private static TicketLine RenderMoneyRow(string label, string value, float size, bool bold, int contentWidthPx)
    {
        var fits = MeasureWidthPx(label, size, bold) + MinRowGapPx + MeasureWidthPx(value, size, bold) <= contentWidthPx;
        return fits ? TicketLine.Row(label, value, size, bold) : TicketLine.Row("", value, size, bold);
    }

    /// <summary>
    /// CRITICAL TOTAL RULE — the single most important line on the receipt
    /// must NEVER collide, clip, or overlap regardless of how large the
    /// total is. Measures "UKUPNO" against "{amount} {currency}" at the
    /// emphasized TOTAL size/weight; if they fit side by side, renders one
    /// clean row. If not (a genuinely long total at a large bold font),
    /// falls back to the label on its own line and the amount right-aligned
    /// on the next — verified against 9,00 through 9.999.999,00 in
    /// SelfTests.cs. Never shrinks the font to force a fit — a total that
    /// doesn't fit at the emphasized size falls back to two lines instead,
    /// so the total is always fully legible.
    /// </summary>
    private static List<TicketLine> RenderTotalLines(string amountWithCurrency, int contentWidthPx)
    {
        const float size = SizeTotal;
        const string label = "UKUPNO";
        if (MeasureWidthPx(label, size, true) + MinRowGapPx + MeasureWidthPx(amountWithCurrency, size, true) <= contentWidthPx)
            return [TicketLine.Row(label, amountWithCurrency, size, true)];
        return [new(label, size, true), TicketLine.Row("", amountWithCurrency, size, true)];
    }

    public static (Ticket Ticket, int PaperWidthMm, string Station) Parse(JsonElement content) =>
        GetString(content, "kind") == "RECEIPT" ? ParseReceipt(content) : ParseKitchenBar(content);

    // #8/#9 (KITCHEN/BAR "STO Sto 3" duplication, 2026-09-2x) — same root
    // principle as the RECEIPT-side fix below (BuildReceiptBodyLines): the
    // table LABEL is already the complete, Admin-chosen display name (e.g.
    // "Sto 3", "Terasa 5", "VIP Sto") and must never be blindly re-derived.
    // The RECEIPT metadata line solves this by rendering a "Field: value"
    // row ("Sto: Sto 1" reads fine as a caption), but the KITCHEN/BAR ticket
    // renders the table identity as ONE large, glanced-at HEADER line, where
    // "STO Sto 3" reads as a genuine duplication and "STO: Sto 3" would look
    // wrong for a header — so that exact pattern isn't reusable verbatim
    // here. Instead: merge a REDUNDANT LEADING "Sto"/"STO" WORD into the
    // "STO" header instead of duplicating it. Deliberately a whole-word,
    // start-anchored match (never a substring strip) — "VIP Sto" and
    // "Bašta Sto 2" contain the word "Sto" but NOT as their own leading
    // word, so they must render unchanged as "STO VIP Sto" / "STO Bašta Sto
    // 2". A label with no leading "Sto" word (numeric, custom, fallback)
    // keeps the exact prior "STO {label}" behavior. Shared by both KITCHEN
    // and BAR because both go through this same ParseKitchenBar function.
    private static readonly Regex LeadingStoWord = new(@"^sto(?=\s|$)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static string FormatTableHeader(string tableLabel)
    {
        var trimmed = tableLabel.Trim();
        var match = LeadingStoWord.Match(trimmed);
        if (!match.Success) return $"STO {trimmed}".Trim();
        var remainder = trimmed[match.Length..].TrimStart();
        return remainder.Length == 0 ? "STO" : $"STO {remainder}";
    }

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
        lines.Add(new(FormatTableHeader(tableLabel), 18, true));
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

    // RECEIPT RENDERING POLISH — typography scale, reduced from the first
    // redesign after real physical printing showed the body font was still
    // far too large for a compact 58mm thermal receipt (kitchen-ticket
    // readability requirements — distance viewing, large quantities — do
    // not apply to a customer receipt held at arm's length). Sized to land
    // close to the ~32-characters-per-line industry guidance for Font A on
    // a 58mm/48mm-printable roll: five deliberate tiers, largest first.
    private const float SizeRestaurantName = 13;
    private const float SizeReceiptNumber = 11;
    private const float SizeTotal = 11; // handled by RenderTotalLines; kept here only for reference in comments
    private const float SizeBody = 9;   // metadata, items, prices, tax rows, payment rows
    private const float SizeFine = 8;   // legal name/address/phone/PIB, modifiers, footer/legal note

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
    /// `paperWidthMm` drives every collision-fitting decision below via
    /// TicketRaster.ContentWidthPx — never a hardcoded 58mm assumption, so
    /// an 80mm route gets a wider fitting budget for free.
    /// </summary>
    private static List<TicketLine> BuildReceiptBodyLines(JsonElement content, int paperWidthMm)
    {
        var contentWidthPx = TicketRaster.ContentWidthPx(paperWidthMm);
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
        if (!string.IsNullOrWhiteSpace(tableLabel)) lines.Add(new($"Sto: {tableLabel}", SizeBody));
        if (!string.IsNullOrWhiteSpace(waiterName)) lines.Add(new($"Konobar: {waiterName}", SizeBody));
        lines.Add(new(FormatDate(issuedAt), SizeFine));
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
                lines.Add(new($"{quantity} × {name}", SizeBody));

                // basePrice falls back to lineTotal for a receipt issued
                // before basePrice existed (P3.2) — same rule as before.
                var basePriceRaw = GetStringOrNull(item, "basePrice") ?? GetString(item, "lineTotal");
                var baseUnitPrice = GetDecimalOrZero(basePriceRaw);
                var baseLineTotal = baseUnitPrice * quantity;
                lines.Add(quantity > 1
                    // "3 × 200,00 ... 600,00" — unit price on the left,
                    // extended total on the right, same line, MEASURED to
                    // fit (an extreme unit price/quantity combination falls
                    // back to the total alone rather than ever colliding).
                    ? RenderMoneyRow($"{quantity} × {FormatMoney(baseUnitPrice)}", FormatMoney(baseLineTotal), SizeBody, false, contentWidthPx)
                    // Quantity 1: the unit price and the line total are the
                    // same number — showing both would just repeat it, so
                    // print the total alone, right-aligned.
                    : TicketLine.Row("", FormatMoney(baseLineTotal), SizeBody));

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
                            > 0 => RenderMoneyRow($"  + {modName}", FormatMoney(modTotal), SizeFine, false, contentWidthPx),
                            < 0 => RenderMoneyRow($"  − {modName}", FormatMoney(Math.Abs(modTotal)), SizeFine, false, contentWidthPx),
                            _ => new($"  {modName}", SizeFine),
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
                lines.Add(RenderMoneyRow($"Osnovica{suffix}", Money(GetString(entry, "taxableAmount")), SizeBody, false, contentWidthPx));
                lines.Add(RenderMoneyRow($"PDV{suffix}", Money(GetString(entry, "taxAmount")), SizeBody, false, contentWidthPx));
            }
            if (taxBreakdown.Length == 0)
            {
                // Defensive fallback for a malformed/missing breakdown —
                // still shows SOMETHING authoritative (the frozen subtotal/
                // tax totals) rather than silently rendering nothing.
                lines.Add(RenderMoneyRow("Osnovica", Money(GetString(content, "subtotal")), SizeBody, false, contentWidthPx));
                lines.Add(RenderMoneyRow("PDV", Money(GetString(content, "taxTotal")), SizeBody, false, contentWidthPx));
            }
        }
        var discountAmount = GetStringOrNull(content, "discountAmount");
        if (discountAmount != null && GetDecimalOrZero(discountAmount) > 0)
            lines.Add(RenderMoneyRow("Popust", $"-{Money(discountAmount)}", SizeBody, false, contentWidthPx));

        lines.Add(TicketLine.Rule());
        // CRITICAL TOTAL RULE — never a same-line guess; see RenderTotalLines.
        lines.AddRange(RenderTotalLines($"{Money(GetString(content, "total"))} {currency}", contentWidthPx));
        lines.Add(TicketLine.Rule());

        lines.Add(RenderMoneyRow("Plaćanje", PaymentMethodLabel.GetValueOrDefault(paymentMethod, paymentMethod), SizeBody, false, contentWidthPx));
        if (paymentMethod == "CASH")
        {
            lines.Add(RenderMoneyRow("Primljeno", Money(GetString(content, "tenderedAmount")), SizeBody, false, contentWidthPx));
            lines.Add(RenderMoneyRow("Kusur", Money(GetString(content, "changeAmount")), SizeBody, false, contentWidthPx));
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
            // bold, centered, uppercased line (never several giant lines),
            // and the single largest element on the receipt.
            new(string.IsNullOrWhiteSpace(restaurantName) ? "TABLECORE" : restaurantName.ToUpperInvariant(), SizeRestaurantName, true, TicketAlign.Center),
        };
        if (!string.IsNullOrWhiteSpace(restaurantLegalName)) lines.Add(new(restaurantLegalName, SizeFine, false, TicketAlign.Center));
        if (!string.IsNullOrWhiteSpace(address)) lines.Add(new(address, SizeFine, false, TicketAlign.Center));
        if (!string.IsNullOrWhiteSpace(phone)) lines.Add(new(phone, SizeFine, false, TicketAlign.Center));
        if (!string.IsNullOrWhiteSpace(taxIdNumber)) lines.Add(new($"PIB: {taxIdNumber}", SizeFine, false, TicketAlign.Center));
        lines.Add(TicketLine.Rule());
        lines.Add(new($"RAČUN #{receiptNumber}", SizeReceiptNumber, true, TicketAlign.Center));

        lines.AddRange(BuildReceiptBodyLines(content, paperWidthMm));

        lines.Add(TicketLine.Rule());
        var thankYou = string.IsNullOrWhiteSpace(footerText) ? "Hvala na poseti!" : footerText;
        lines.Add(new(thankYou, SizeBody, false, TicketAlign.Center));
        // Non-fiscal status — this is still the current NON-FISCAL TableCore
        // receipt (see requirement #6); emphasized in caps like a real legal
        // disclaimer, exact wording stays Admin-configurable — bold but
        // deliberately never larger than TOTAL (SizeFine < SizeTotal).
        if (!string.IsNullOrWhiteSpace(legalNote)) lines.Add(new(legalNote.ToUpperInvariant(), SizeFine, true, TicketAlign.Center));

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
        var body = BuildReceiptBodyLines(JsonDocument.Parse(syntheticJson).RootElement, paperWidthMm);

        var header = new List<TicketLine>
        {
            new("TABLECORE", SizeRestaurantName, true, TicketAlign.Center),
            new("TEST ŠTAMPE", SizeReceiptNumber, true, TicketAlign.Center),
            TicketLine.Rule(),
            new($"Radna stanica: {workstationName}", SizeFine, false, TicketAlign.Center),
            new($"Štampač: {printerName}   Papir: {paperWidthMm} mm", SizeFine, false, TicketAlign.Center),
            new($"Ruta: RECEIPT   Verzija: {agentVersion}", SizeFine, false, TicketAlign.Center),
            new("Test znakova: č ć ž š đ Č Ć Ž Š Đ", SizeFine, false, TicketAlign.Center),
            TicketLine.Rule(),
        };
        var footer = new List<TicketLine>
        {
            TicketLine.Rule(),
            new("TEST USPEŠAN", SizeReceiptNumber, true, TicketAlign.Center),
            new("TEST ŠTAMPE — NIJE RAČUN", SizeFine, true, TicketAlign.Center),
        };
        return new Ticket([.. header, .. body, .. footer]);
    }
}
