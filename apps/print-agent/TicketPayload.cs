using System.Globalization;
using System.Text.Json;

namespace TableCore.PrintAgent;

/// <summary>
/// Konvertuje zamrznut PrintJob.content JSON payload sa servera
/// (packages/domain/printing/ticket-content.ts, nepromenjen — isti sadržaj
/// koji browser/QZ putevi već koriste preko TicketPrintPanel.tsx) u Ticket/
/// TicketLine niz koji Faza 1 TicketRaster/WindowsPrinter.Print već zna da
/// renderuje (Printing.cs, nepromenjeno). Dispatch po "kind" — dva potpuno
/// različita oblika deljena kroz JEDAN PrintJob.content stub:
///
///  - KitchenBarTicketContent (kind: KITCHEN|BAR): stationLabel, tableLabel,
///    waiterName, orderNumber, submittedAt, items[{quantity,name,note?,
///    modifiers?:string[]}], isAdditional, paperWidthMm.
///  - ReceiptTicketContent (kind: RECEIPT): restaurantName/address/phone/
///    taxIdNumber/legalNote/footerText, receiptNumber, tableLabel,
///    waiterName, issuedAt, items[{quantity,name,unitPrice,lineTotal,
///    basePrice?,modifiers?:{name,priceDelta}[]}], subtotal, taxTotal,
///    discountAmount, total, currency, paymentMethod, tenderedAmount,
///    changeAmount.
///
/// PREPROD physical QA follow-up (receipt #425 — "Driver printable area is
/// too small for this ticket", the receipt never actually printed): before
/// this fix, EVERY job type (including RECEIPT) went through the
/// KitchenBar-shaped parser below regardless of its real content shape —
/// RECEIPT was never given its own parser when it became Agent-routable.
/// The result was never a valid receipt at all: `kind`/`stationLabel` don't
/// exist on ReceiptTicketContent, so the printed "station" line always read
/// "KUHINJA"; unit/line prices, subtotal/tax/discount/total, payment
/// method/tendered/change, and every legal/footer/restaurant-identity line
/// were silently dropped (their property names never matched), and each
/// modifier (an object {name,priceDelta} on a real receipt, not a plain
/// string) failed the KitchenBar parser's `ValueKind == String` check and
/// was silently skipped too. Fixing this ALSO makes a real multi-item
/// receipt legitimately much taller than before (adding back subtotal/tax/
/// payment/legal lines that were missing) — see Printing.cs's paired fix
/// for why the driver's margin can't be assumed to scale linearly with
/// that added height.
/// </summary>
public static class TicketPayload
{
    private static string GetString(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static string? GetStringOrNull(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>Server sends Prisma Decimal values as plain strings (e.g.
    /// "700.00"). Formats with exactly 2 decimals, invariant culture (never
    /// the host machine's locale — this is printed text, not user input),
    /// matching the browser's `Number(x).toFixed(2)` rendering exactly.
    /// Falls back to the raw string if it's ever not parseable, rather than
    /// silently printing "0.00" for a genuinely malformed value.</summary>
    private static string Money(string raw) =>
        decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out var value)
            ? value.ToString("F2", CultureInfo.InvariantCulture)
            : raw;

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
        lines.Add(new("----------------", 10));
        lines.Add(new(time, 10));

        return (new Ticket([.. lines]), paperWidthMm, station);
    }

    private static readonly Dictionary<string, string> PaymentMethodLabel = new() { ["CASH"] = "GOTOVINA", ["CARD"] = "KARTICA" };

    /// <summary>Mirrors TicketPrintPanel.tsx's ReceiptTicket component,
    /// field-for-field and in the same order — the printed thermal receipt
    /// and the (secondary, fallback) browser-rendered one must never show
    /// materially different information for the same frozen Receipt/Payment
    /// snapshot. TicketLine has no column/alignment support (unlike the
    /// browser's flex layout), so each label+amount pair is combined into
    /// one left-aligned line (e.g. "Osnovica: 5500.00") rather than
    /// right-aligning the amount — a deliberate, minor cosmetic
    /// simplification, not a content gap.</summary>
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
        var tableLabel = GetString(content, "tableLabel");
        var waiterName = GetString(content, "waiterName");
        var issuedAt = GetString(content, "issuedAt");
        var currency = GetString(content, "currency");
        var paymentMethod = GetString(content, "paymentMethod");
        var paperWidthMm = content.TryGetProperty("paperWidthMm", out var pw) && pw.TryGetInt32(out var pwVal) ? pwVal : 80;

        var lines = new List<TicketLine>
        {
            new(string.IsNullOrWhiteSpace(restaurantName) ? "TABLECORE" : restaurantName, 16, true),
        };
        if (!string.IsNullOrWhiteSpace(restaurantLegalName)) lines.Add(new(restaurantLegalName, 10));
        if (!string.IsNullOrWhiteSpace(address)) lines.Add(new(address, 10));
        if (!string.IsNullOrWhiteSpace(phone)) lines.Add(new(phone, 10));
        if (!string.IsNullOrWhiteSpace(taxIdNumber)) lines.Add(new($"PIB: {taxIdNumber}", 10));
        lines.Add(new("----------------", 10));
        lines.Add(new($"RACUN #{receiptNumber}", 14, true));
        lines.Add(new($"STO {tableLabel}".Trim(), 12));
        if (!string.IsNullOrWhiteSpace(waiterName)) lines.Add(new($"KONOBAR: {waiterName}", 10));
        var time = DateTime.TryParse(issuedAt, null, DateTimeStyles.RoundtripKind, out var parsedIssued)
            ? parsedIssued.ToLocalTime().ToString("yyyy-MM-dd HH:mm")
            : DateTime.Now.ToString("yyyy-MM-dd HH:mm");
        lines.Add(new(time, 10));
        lines.Add(new("----------------", 10));

        if (content.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in items.EnumerateArray())
            {
                var quantity = item.TryGetProperty("quantity", out var q) && q.TryGetInt32(out var qVal) ? qVal : 1;
                var name = GetString(item, "name");
                // Mirrors ReceiptTicket.tsx: base price × quantity on the item's
                // own line (basePrice falls back to lineTotal for a receipt
                // issued before basePrice existed — same rule, same fallback).
                var basePrice = GetStringOrNull(item, "basePrice") ?? GetString(item, "lineTotal");
                if (!string.IsNullOrWhiteSpace(name))
                {
                    var baseLineTotal = decimal.TryParse(basePrice, NumberStyles.Number, CultureInfo.InvariantCulture, out var baseVal) ? baseVal * quantity : (decimal?)null;
                    lines.Add(new(baseLineTotal.HasValue ? $"{quantity}x {name}  {baseLineTotal.Value.ToString("F2", CultureInfo.InvariantCulture)}" : $"{quantity}x {name}", 13, true));
                }
                if (item.TryGetProperty("modifiers", out var mods) && mods.ValueKind == JsonValueKind.Array)
                {
                    foreach (var m in mods.EnumerateArray())
                    {
                        var modName = GetString(m, "name");
                        var priceDelta = GetString(m, "priceDelta");
                        if (string.IsNullOrWhiteSpace(modName)) continue;
                        var modTotal = decimal.TryParse(priceDelta, NumberStyles.Number, CultureInfo.InvariantCulture, out var deltaVal) ? (deltaVal * quantity).ToString("F2", CultureInfo.InvariantCulture) : priceDelta;
                        lines.Add(new($"  + {modName}  {modTotal}", 10));
                    }
                }
            }
        }

        lines.Add(new("----------------", 10));
        lines.Add(new($"Osnovica: {Money(GetString(content, "subtotal"))}", 11));
        lines.Add(new($"PDV: {Money(GetString(content, "taxTotal"))}", 11));
        var discountAmount = GetStringOrNull(content, "discountAmount");
        if (discountAmount != null && decimal.TryParse(discountAmount, NumberStyles.Number, CultureInfo.InvariantCulture, out var discountVal) && discountVal > 0)
            lines.Add(new($"Popust: -{Money(discountAmount)}", 11));
        lines.Add(new($"UKUPNO: {Money(GetString(content, "total"))} {currency}", 15, true));
        lines.Add(new("----------------", 10));
        lines.Add(new($"Placanje: {PaymentMethodLabel.GetValueOrDefault(paymentMethod, paymentMethod)}", 11));
        if (paymentMethod == "CASH")
        {
            lines.Add(new($"Primljeno: {Money(GetString(content, "tenderedAmount"))}", 11));
            lines.Add(new($"Kusur: {Money(GetString(content, "changeAmount"))}", 11));
        }
        lines.Add(new("----------------", 10));
        if (!string.IsNullOrWhiteSpace(footerText)) lines.Add(new(footerText, 10));
        lines.Add(new("Hvala na poseti!", 10));
        if (!string.IsNullOrWhiteSpace(legalNote)) lines.Add(new(legalNote, 9));

        return (new Ticket([.. lines]), paperWidthMm, "RECEIPT");
    }
}
