using System.Text.Json;

namespace TableCore.PrintAgent;

/// <summary>
/// Faza 2B — pretvara zamrznut KitchenBarTicketContent JSON payload sa
/// servera (packages/domain/printing/ticket-content.ts, nepromenjen —
/// isti sadržaj koji browser/QZ putevi već koriste, vidi P0.19
/// qz-ticket-html.ts za analognu konverziju na JS strani) u Ticket/
/// TicketLine niz koji Faza 1 TicketRaster/WindowsPrinter.Print već zna
/// da renderuje (Printing.cs, NEPROMENJENO). Polja MORAJU tačno odgovarati
/// KitchenBarTicketContent: kind, stationLabel, tableLabel, waiterName,
/// orderNumber, submittedAt, items[{quantity,name,note?,modifiers?}],
/// isAdditional, paperWidthMm. Postojeća hijerarhija informacija/redosled
/// se NE redizajnira — samo se prevodi u ravnu listu linija.
/// </summary>
public static class TicketPayload
{
    public static (Ticket Ticket, int PaperWidthMm, string Station) Parse(JsonElement content)
    {
        static string GetString(JsonElement el, string prop) =>
            el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

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

        var time = DateTime.TryParse(submittedAt, null, System.Globalization.DateTimeStyles.RoundtripKind, out var parsed)
            ? parsed.ToLocalTime().ToString("HH:mm")
            : DateTime.Now.ToString("HH:mm");
        lines.Add(new("----------------", 10));
        lines.Add(new(time, 10));

        return (new Ticket([.. lines]), paperWidthMm, station);
    }
}
