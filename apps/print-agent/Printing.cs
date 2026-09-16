using System.Drawing;
using System.Drawing.Printing;
using System.Drawing.Text;

namespace TableCore.PrintAgent;

/// <summary>
/// Printing V2 — one route (KITCHEN/BAR/RECEIPT) mapped to one Windows
/// printer + paper width. Replaces the old flat AgentConfig(Station,
/// PrinterName, PaperWidthMm), which locked one whole agent installation to
/// exactly one station/printer forever. The same physical printer may
/// appear in more than one PrintRoute (e.g. all three routes -> POS-58).
/// </summary>
public sealed record PrintRoute(string Type, string PrinterName, int PaperWidthMm)
{
    public void Validate()
    {
        if (Type is not ("KITCHEN" or "BAR" or "RECEIPT") || string.IsNullOrWhiteSpace(PrinterName) || PaperWidthMm is not (58 or 80))
            throw new ArgumentException("Configure KITCHEN/BAR/RECEIPT, an exact printerName and paperWidthMm 58/80.");
    }
}

/// <summary>
/// Printing V2 — local cache of this agent's server-authoritative print
/// routes. Setup/Admin no longer write a single station/printer here;
/// AgentRunner persists whatever the server's poll/heartbeat response
/// reports (see DeliveryClient), so this file is always a mirror, never a
/// competing source of truth. Only FULLY configured routes (real printer
/// name + paper width) are ever included — see workstation-service.ts
/// getAgentRoutes, which never reports a route with no printer chosen yet.
/// </summary>
public sealed record AgentConfig(PrintRoute[] Routes)
{
    private static readonly System.Text.Json.JsonSerializerOptions JsonOptions =
        new(System.Text.Json.JsonSerializerDefaults.Web) { WriteIndented = true };

    public static AgentConfig Parse(string json)
    {
        var config = System.Text.Json.JsonSerializer.Deserialize<AgentConfig>(json,
            new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))
            ?? throw new ArgumentException("Missing configuration.");
        config.Validate();
        return config;
    }
    public void Validate()
    {
        if (Routes is null || Routes.Length == 0)
            throw new ArgumentException("Configure at least one print route (KITCHEN/BAR/RECEIPT).");
        foreach (var route in Routes) route.Validate();
        if (Routes.Select(r => r.Type).Distinct().Count() != Routes.Length)
            throw new ArgumentException("Each route type (KITCHEN/BAR/RECEIPT) may appear at most once.");
    }
    public PrintRoute? RouteFor(string type) => Routes.FirstOrDefault(r => r.Type == type);
    public string ToJson() => System.Text.Json.JsonSerializer.Serialize(this, JsonOptions);

    /// <summary>
    /// Printing V2 upgrade path — a machine paired before this version wrote
    /// a flat {"station":"KITCHEN","printerName":"POS-58","paperWidthMm":58}
    /// agent.config.json, which no longer parses as the new {"routes":[...]}
    /// shape. Falls back to reading that OLD shape and converting it
    /// in-memory to a one-route AgentConfig, so an upgraded agent keeps
    /// printing with NO re-pairing/reinstall — AgentRunner persists the
    /// converted result back to disk in the new shape on first successful
    /// parse (see AgentRunner.Run). Returns MigratedFromLegacy=false (and
    /// the normal Parse result) whenever the file is already in the new
    /// shape or genuinely invalid either way.
    /// </summary>
    public static (AgentConfig Config, bool MigratedFromLegacy) ParseWithLegacyFallback(string json)
    {
        try { return (Parse(json), false); }
        catch (Exception primary)
        {
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.TryGetProperty("station", out var stationEl) && stationEl.ValueKind == System.Text.Json.JsonValueKind.String
                    && root.TryGetProperty("printerName", out var printerEl) && printerEl.ValueKind == System.Text.Json.JsonValueKind.String
                    && root.TryGetProperty("paperWidthMm", out var widthEl) && widthEl.ValueKind == System.Text.Json.JsonValueKind.Number)
                {
                    var legacy = new AgentConfig([new PrintRoute(stationEl.GetString()!, printerEl.GetString()!, widthEl.GetInt32())]);
                    legacy.Validate();
                    return (legacy, true);
                }
            }
            catch
            {
                // Legacy shape didn't match/validate either — fall through
                // and surface the ORIGINAL (new-shape) parse error, which is
                // more useful for a genuinely corrupt/unrelated file.
            }
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(primary).Throw();
            throw; // unreachable — Throw() above always throws; satisfies the compiler's return-path analysis.
        }
    }
}

public enum TicketAlign { Left, Center, Right }

/// <summary>
/// RECEIPT RENDERING POLISH — extended with `Align`/`RightText`/`IsRule`,
/// all optional and defaulted so every EXISTING call site (KITCHEN/BAR
/// tickets, Test Print, self-tests) that only ever passed
/// (Text, Size, Bold) positionally keeps compiling and rendering
/// byte-for-byte identically. Nothing about KITCHEN/BAR rendering changes.
/// </summary>
public sealed record TicketLine(string Text, float Size = 11, bool Bold = false, TicketAlign Align = TicketAlign.Left, string? RightText = null, bool IsRule = false)
{
    /// <summary>
    /// Full-width horizontal divider, drawn as an actual thin filled
    /// rectangle rather than repeated dash characters — its length is
    /// therefore ALWAYS exactly the raster's real usable width, never a
    /// guessed/fixed character count, and it can never be thrown off by
    /// font/character-width differences between drivers, sizes, or the
    /// Serbian character set. This is the fix for the "separators look too
    /// short" complaint: the old fixed 16-dash string was sized for nothing
    /// in particular and fell well short of the real usable width.
    /// </summary>
    public static TicketLine Rule() => new("RULE", 4, false, TicketAlign.Left, null, true);

    /// <summary>
    /// Two-column row on one line: `left` at the start, `right` at the end,
    /// same font/size — used for "3 × 200,00 ... 600,00" item lines and
    /// every label/amount financial-summary/payment row ("Osnovica ...
    /// 4.800,00"). Both sides are short, non-wrapping strings by design;
    /// long, variable-length text (item names) always gets its own
    /// full-width line instead (see TicketPayload.ParseReceipt) so wrapping
    /// a long name never has to fight for space with a price column.
    /// Passing an empty `left` (e.g. a quantity-1 item whose unit price
    /// would just repeat its own total) renders as a right-aligned amount
    /// alone, cleanly, without an empty leading column.
    /// </summary>
    public static TicketLine Row(string left, string right, float size = 11, bool bold = false) =>
        new(left, size, bold, TicketAlign.Left, right);
}
public sealed record Ticket(TicketLine[] Lines)
{
    public void Validate()
    {
        if (Lines is null || Lines.Length is < 1 or > 80) throw new ArgumentException("Ticket requires 1-80 lines.");
        foreach (var l in Lines)
        {
            if (l is null) throw new ArgumentException("Ticket lines cannot be null.");
            if (l.IsRule) continue; // a rule carries no real text — nothing else to validate.
            var hasContent = !string.IsNullOrWhiteSpace(l.Text) || !string.IsNullOrWhiteSpace(l.RightText);
            if (!hasContent || l.Text.Length > 200 || l.Text.Any(char.IsControl) ||
                (l.RightText?.Length ?? 0) > 200 || (l.RightText?.Any(char.IsControl) ?? false) ||
                !float.IsFinite(l.Size) || l.Size < 8 || l.Size > 24)
                throw new ArgumentException("Ticket lines require 1-200 printable characters (left and/or right column), font size 8-24.");
        }
    }

    /// <summary>
    /// Faza 2C, sekcija 15 — namenski test dokument za Admin/Setup "Test
    /// Print" dugme. Prolazi kroz ISTI WindowsPrinter.Print put kao pravi
    /// tiket (dokazuje da agent -> štampač lanac stvarno radi), ali NIKAD
    /// ne dodiruje Order/Payment/PrintJob niti DeliveryClient/server —
    /// pozivalac (SetupForm.cs) štampa ovo ISKLJUČIVO preko lokalnog
    /// WindowsPrinter.Print poziva, van AgentRunner/AgentDatabase puta.
    /// Jasno obeleženo da se ne pomeša sa pravim tiketom.
    /// </summary>
    public static Ticket TestPrint(string workstationName, string station, string printerName, int paperWidthMm, string agentVersion, DateTime? localTime = null) => new([
        new("TABLECORE TEST PRINT", 16, true),
        new("----------------", 10),
        new($"Stanica: {station}", 12),
        new($"Radna stanica: {workstationName}", 11),
        new($"Stampac: {printerName}", 11),
        new($"Sirina papira: {paperWidthMm} mm", 11),
        new($"Verzija agenta: {agentVersion}", 11),
        new($"Vreme: {(localTime ?? DateTime.Now):yyyy-MM-dd HH:mm:ss}", 11),
        new("----------------", 10),
        new("Ovo NIJE porudzbina.", 10),
        new("Test znakova: č ć ž š đ", 10),
    ]);

    public static Ticket Example(string station, DateTime? localTime = null) => new([
        new("TABLECORE", 16, true), new(station == "BAR" ? "ŠANK" : "KUHINJA", 14, true),
        new("STO 2", 18, true), new("1x Pljeskavica"), new("2x Coca-Cola"),
        new("Napomena:", 10), new("BEZ LUKA", 13, true),
        new("Test znakova:", 10), new("č ć ž š đ", 10), new("Č Ć Ž Š Đ", 10),
        new("----------------", 10), new((localTime ?? DateTime.Now).ToString("HH:mm"), 10)]);
}

public sealed class TicketRaster : IDisposable
{
    public Bitmap Image { get; }
    public int WidthUnits { get; }
    // NAMERNO nepromenjeno (sadržaj + fiksnih ~4mm) — koristi se ISKLJUČIVO
    // kao PRVI (probni) zahtev ka drajveru u WindowsPrinter.Print, da se
    // izmeri STVARNA neštampiva margina TOG drajvera. Konačna visina papira
    // koja se stvarno šalje na štampu se računa OTUD (ContentHeightUnits +
    // izmerena margina), NIKAD od ove fiksne procene — vidi WindowsPrinter.Print.
    public int HeightUnits { get; }
    // Čist sadržaj, BEZ ikakvog bafera — jedina vrednost koja mora stati
    // unutar page.PrintableArea.Height posle ispravnog sizing-a. Nikad se ne
    // skraćuje/seče; WindowsPrinter.Print traži dovoljno prostora OKO ove
    // vrednosti, nikad je ne umanjuje.
    public int ContentHeightUnits { get; }
    public const float Dpi = 203;
    // RECEIPT RENDERING POLISH — a divider drawn as an actual thin filled
    // bar (see TicketLine.Rule) rather than text, so its length is always
    // exactly the real raster width and it never depends on font metrics.
    // ~2 px line + padding above/below reads as a clean, deliberate divider
    // at 203 DPI without wasting much vertical space on a 58 mm roll.
    private const int RuleRowHeightPx = 16;
    private const int RuleThicknessPx = 2;

    /// <summary>
    /// RECEIPT RENDERING POLISH — the printable width in pixels for a given
    /// configured paperWidthMm, derived (never hardcoded per-receipt-type)
    /// so both the raster itself and TicketPayload's layout-fitting
    /// decisions (TOTAL collision protection, item price alignment) always
    /// agree on exactly the same number. 58 mm rolls commonly have only
    /// 48 mm printable width; 80 mm uses 72 mm — this is the ONE place
    /// that mapping lives, so a future wider layout for 80mm only ever
    /// requires changing the mapping here, never re-deriving it elsewhere.
    /// </summary>
    public static int ContentWidthPx(int widthMm)
    {
        if (widthMm is not (58 or 80)) throw new ArgumentException("Unsupported paper width.");
        var contentMm = widthMm == 58 ? 48 : 72;
        return (int)Math.Floor(contentMm / 25.4f * Dpi);
    }

    public TicketRaster(Ticket ticket, int widthMm)
    {
        ticket.Validate();
        var width = ContentWidthPx(widthMm);
        using var probe = new Bitmap(width, 1);
        probe.SetResolution(Dpi, Dpi);
        using var measure = Graphics.FromImage(probe);
        using var format = new StringFormat(StringFormat.GenericDefault) { Trimming = StringTrimming.None };
        var heights = ticket.Lines.Select(line => {
            if (line.IsRule) return RuleRowHeightPx;
            using var font = new Font("Arial", line.Size, line.Bold ? FontStyle.Bold : FontStyle.Regular);
            var leftHeight = (int)Math.Ceiling(measure.MeasureString(line.Text, font, width, format).Height);
            var rightHeight = line.RightText is null ? 0 : (int)Math.Ceiling(measure.MeasureString(line.RightText, font, width, format).Height);
            return Math.Max(leftHeight, rightHeight) + 3;
        }).ToArray();
        int height = heights.Sum();
        if (height / Dpi * 25.4f > 500) throw new ArgumentException("Ticket exceeds prototype 500 mm limit.");
        Image = new Bitmap(width, height);
        Image.SetResolution(Dpi, Dpi);
        using var graphics = Graphics.FromImage(Image);
        graphics.Clear(Color.White);
        graphics.TextRenderingHint = TextRenderingHint.SingleBitPerPixelGridFit;
        using var centerFormat = new StringFormat(StringFormat.GenericDefault) { Trimming = StringTrimming.None, Alignment = StringAlignment.Center };
        using var farFormat = new StringFormat(StringFormat.GenericDefault) { Trimming = StringTrimming.None, Alignment = StringAlignment.Far };
        float y = 0;
        for (int i = 0; i < ticket.Lines.Length; i++)
        {
            var line = ticket.Lines[i];
            if (line.IsRule)
            {
                graphics.FillRectangle(Brushes.Black, 0, y + (RuleRowHeightPx - RuleThicknessPx) / 2f, width, RuleThicknessPx);
                y += heights[i];
                continue;
            }
            using var font = new Font("Arial", line.Size, line.Bold ? FontStyle.Bold : FontStyle.Regular);
            var rect = new RectangleF(0, y, width, heights[i]);
            if (line.RightText is not null)
            {
                // Two-column row: left text near-aligned, right text
                // far-aligned, same rect/font — both are short, non-wrapping
                // strings by design (see TicketLine.Row), so they never
                // fight for space with each other.
                if (!string.IsNullOrEmpty(line.Text)) graphics.DrawString(line.Text, font, Brushes.Black, rect, format);
                graphics.DrawString(line.RightText, font, Brushes.Black, rect, farFormat);
            }
            else
            {
                var lineFormat = line.Align switch { TicketAlign.Center => centerFormat, TicketAlign.Right => farFormat, _ => format };
                graphics.DrawString(line.Text, font, Brushes.Black, rect, lineFormat);
            }
            y += heights[i];
        }
        WidthUnits = (int)Math.Round(widthMm / 25.4 * 100);
        ContentHeightUnits = (int)Math.Ceiling(height / Dpi * 100);
        // Nepromenjena formula (ceiling nad ZBIROM, ne zbir dva ceiling-a) —
        // isti bajt-za-bajt rezultat kao pre ovog fixa, da postojeći
        // self-test ("page height includes measured raster and 4 mm feed")
        // ostane tačan bez izmene.
        HeightUnits = (int)Math.Ceiling(height / Dpi * 100 + 4 / 25.4 * 100);
    }
    public void Dispose() => Image.Dispose();
}

public sealed record PrintOutcome(string Status, string Guarantee, string? Error = null);

public static class WindowsPrinter
{
    public static string[] Enumerate() => PrinterSettings.InstalledPrinters.Cast<string>().ToArray();

    public static PrintOutcome Print(PrintRoute route, Ticket ticket, string requestId, bool dryRun = false)
    {
        bool submissionStarted = false;
        try
        {
            route.Validate();
            if (!Enumerate().Contains(route.PrinterName, StringComparer.Ordinal))
                throw new ArgumentException("Configured printer is not installed for this Windows account.");
            using var raster = new TicketRaster(ticket, route.PaperWidthMm);
            using var document = new PrintDocument();
            document.PrinterSettings.PrinterName = route.PrinterName;
            document.PrinterSettings.Copies = 1;
            document.PrinterSettings.PrintToFile = false;
            document.DocumentName = "TableCore-" + requestId;
            document.PrintController = new StandardPrintController();
            document.DefaultPageSettings.Landscape = false;
            document.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);

            // PRVI (probni) prolaz — traži stranicu veličine raster.HeightUnits
            // (sadržaj + nominalnih ~4mm, TicketRaster.HeightUnits, nepromenjeno)
            // SAMO da bi se izmerila STVARNA neštampiva margina OVOG drajvera
            // za ovu širinu papira (page.Bounds.Height - page.PrintableArea.Height).
            // Ta margina je svojstvo drajvera/hardvera, ne nešto što nagađamo —
            // upravo ono što je nedostajalo pre ovog fixa (fiksnih ~4mm je bilo
            // dovoljno za kratak Test Print, ali ne i za dužu pravu porudžbinu
            // na istom štampaču, jer stvarna margina ovog drajvera premašuje 4mm).
            RoundTripPaperSize(document, raster.WidthUnits, raster.HeightUnits);
            var probePage = document.DefaultPageSettings;

            // DRUGI (konačan) prolaz — tačna visina = čist sadržaj
            // (ContentHeightUnits, NIKAD skraćen/isečen) + STVARNO izmerena
            // margina ovog drajvera. Nikad fiksan/nagađan broj. Zasebna,
            // čisto-aritmetička funkcija (ComputeFinalHeightUnits ispod) —
            // testirana direktno u SelfTests.cs sa sintetičkim vrednostima
            // margine, bez potrebe za stvarnim/virtuelnim štampačem koji baš
            // ima nenulti margin.
            float imageWidth = raster.Image.Width / TicketRaster.Dpi * 100;
            float imageHeight = raster.Image.Height / TicketRaster.Dpi * 100;
            var finalHeightUnits = ComputeFinalHeightUnits(raster.ContentHeightUnits, probePage.Bounds.Height, probePage.PrintableArea.Height);

            // Physical PREPROD failure (real receipt #425, POS-58): a SHORT
            // probe (content + a nominal ~4mm) measured this driver's margin
            // correctly for a short ticket (Test Print, 11-12 lines), but a
            // much TALLER real receipt (30+ lines once priced/taxed/totalled
            // — see TicketPayload.ParseReceipt) still failed "printable area
            // too small" even after using that SAME measured margin. Some
            // custom/continuous-roll thermal drivers do NOT report a margin
            // that scales linearly with requested page height — the margin
            // measured at a short height understates the real margin at a
            // much taller one. Re-measure (never assume) at the ACTUAL
            // height just tried and grow again if still short, bounded so a
            // driver that truly can never fit this content still fails
            // deterministically rather than looping forever. For any ticket
            // short enough that the original single-probe estimate was
            // already sufficient (every KITCHEN/BAR ticket and Test Print to
            // date), this executes exactly one iteration — byte-for-byte the
            // same behavior as before this fix.
            const int maxHeightAttempts = 4;
            PageSettings page;
            var attempt = 1;
            while (true)
            {
                RoundTripPaperSize(document, raster.WidthUnits, finalHeightUnits);
                page = document.DefaultPageSettings;
                if (Math.Abs(page.Bounds.Width - raster.WidthUnits) > 2 || Math.Abs(page.Bounds.Height - finalHeightUnits) > 2)
                    throw new InvalidOperationException("Driver rejected compact custom paper size. Configure its roll/custom form.");
                if (page.PrintableArea.Height >= imageHeight || attempt >= maxHeightAttempts) break;
                finalHeightUnits = ComputeFinalHeightUnits(raster.ContentHeightUnits, page.Bounds.Height, page.PrintableArea.Height);
                attempt++;
            }
            // I posle ispravnog sizing-a (uklj. ponovljenog merenja iznad),
            // ovo ostaje kao STVARNA bezbednosna provera (zahtev
            // specifikacije: "only fail if content truly cannot fit after
            // proper sizing") — nikad se ne pretvara u "štampaj svejedno";
            // sadržaj se NIKAD ne seče/skraćuje da bi prošao ovu proveru.
            if (page.PrintableArea.Width < imageWidth || page.PrintableArea.Height < imageHeight)
                throw new InvalidOperationException("Driver printable area is too small for this ticket.");
            if (dryRun)
                return new("PREFLIGHT_ONLY", $"Driver reports {page.Bounds.Width} x {page.Bounds.Height} hundredths of an inch; printable area {page.PrintableArea.Width} x {page.PrintableArea.Height}. No Print call, no spool submission.");
            document.PrintPage += (_, e) => {
                if (e.Graphics is null) throw new InvalidOperationException("No printer graphics context.");
                if (Math.Abs(e.PageBounds.Width - raster.WidthUnits) > 2 || Math.Abs(e.PageBounds.Height - finalHeightUnits) > 2)
                    throw new InvalidOperationException("Driver changed paper size during submission.");
                e.Graphics.PageUnit = GraphicsUnit.Display;
                // Graphics origin is the printable area; center within that area.
                e.Graphics.DrawImage(raster.Image, new RectangleF(
                    Math.Max(0, (page.PrintableArea.Width - imageWidth) / 2), 0, imageWidth, imageHeight));
                e.HasMorePages = false;
            };
            submissionStarted = true;
            document.Print();
            return new("SUBMITTED_TO_SPOOLER", "PrintDocument.Print returned without error; no spool job ID or physical-paper acknowledgement is exposed.");
        }
        catch (Exception ex)
        {
            return new(submissionStarted ? "SUBMISSION_UNKNOWN" : "FAILED_BEFORE_SUBMISSION",
                submissionStarted ? "Windows submission was attempted; partial output is possible. Do not automatically retry." : "PrintDocument.Print was not called.", ex.Message);
        }
    }

    /// <summary>
    /// Čista aritmetika (bez ijednog Windows/GDI poziva) — namerno izdvojeno
    /// da bi SelfTests.cs moglo direktno da proveri ponašanje za RAZLIČITE
    /// margine drajvera (0, ~4mm, margina veća od stare fiksne procene) bez
    /// potrebe za stvarnim štampačem koji baš ima tu tačnu marginu. Nikad ne
    /// vraća manje od contentHeightUnits (sadržaj se nikad ne skraćuje) —
    /// samo dodaje STVARNO izmerenu marginu drajvera (probeBoundsHeight -
    /// probePrintableAreaHeight, nikad negativno, zaokruženo NAGORE).
    /// </summary>
    internal static int ComputeFinalHeightUnits(int contentHeightUnits, int probeBoundsHeight, float probePrintableAreaHeight)
    {
        var verticalInsetUnits = (int)Math.Ceiling(Math.Max(0f, probeBoundsHeight - probePrintableAreaHeight));
        return contentHeightUnits + verticalInsetUnits;
    }

    /// <summary>
    /// Postavlja traženu veličinu papira i odmah je "vraća kroz" drajver
    /// (GetHdevmode/SetHdevmode) tako da document.DefaultPageSettings posle
    /// ovog poziva odražava ono što je DRAJVER stvarno prihvatio/izmerio
    /// (Bounds/PrintableArea), ne samo ono što smo tražili. Pozvano DVA puta
    /// u Print() — jednom da se izmeri stvarna margina, jednom sa konačnom,
    /// ispravnom visinom.
    /// </summary>
    private static void RoundTripPaperSize(PrintDocument document, int widthUnits, int heightUnits)
    {
        document.DefaultPageSettings.PaperSize = new PaperSize("TableCore ticket", widthUnits, heightUnits);
        var devmode = document.PrinterSettings.GetHdevmode(document.DefaultPageSettings);
        try { document.DefaultPageSettings.SetHdevmode(devmode); }
        finally { GlobalFree(devmode); }
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern IntPtr GlobalFree(IntPtr memory);
}
