using System.Drawing;
using System.Drawing.Printing;
using System.Drawing.Text;

namespace TableCore.PrintAgent;

public sealed record AgentConfig(string Station, string PrinterName, int PaperWidthMm)
{
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
        if (Station is not ("KITCHEN" or "BAR") || string.IsNullOrWhiteSpace(PrinterName) || PaperWidthMm is not (58 or 80))
            throw new ArgumentException("Configure KITCHEN/BAR, an exact printerName and paperWidthMm 58/80.");
    }
}

public sealed record TicketLine(string Text, float Size = 11, bool Bold = false);
public sealed record Ticket(TicketLine[] Lines)
{
    public void Validate()
    {
        if (Lines is null || Lines.Length is < 1 or > 80 || Lines.Any(l => l is null ||
            string.IsNullOrWhiteSpace(l.Text) || l.Text.Length > 200 || l.Text.Any(char.IsControl) ||
            !float.IsFinite(l.Size) || l.Size < 8 || l.Size > 24))
            throw new ArgumentException("Ticket requires 1-80 lines, 1-200 printable characters per line, font size 8-24.");
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
    public int HeightUnits { get; }
    public const float Dpi = 203;
    public TicketRaster(Ticket ticket, int widthMm)
    {
        ticket.Validate();
        if (widthMm is not (58 or 80)) throw new ArgumentException("Unsupported paper width.");
        // 58 mm rolls commonly have only 48 mm printable width; 80 mm uses 72 mm.
        var contentMm = widthMm == 58 ? 48 : 72;
        var width = (int)Math.Floor(contentMm / 25.4f * Dpi);
        using var probe = new Bitmap(width, 1);
        probe.SetResolution(Dpi, Dpi);
        using var measure = Graphics.FromImage(probe);
        using var format = new StringFormat(StringFormat.GenericDefault) { Trimming = StringTrimming.None };
        var heights = ticket.Lines.Select(line => {
            using var font = new Font("Arial", line.Size, line.Bold ? FontStyle.Bold : FontStyle.Regular);
            return (int)Math.Ceiling(measure.MeasureString(line.Text, font, width, format).Height) + 3;
        }).ToArray();
        int height = heights.Sum();
        if (height / Dpi * 25.4f > 500) throw new ArgumentException("Ticket exceeds prototype 500 mm limit.");
        Image = new Bitmap(width, height);
        Image.SetResolution(Dpi, Dpi);
        using var graphics = Graphics.FromImage(Image);
        graphics.Clear(Color.White);
        graphics.TextRenderingHint = TextRenderingHint.SingleBitPerPixelGridFit;
        float y = 0;
        for (int i = 0; i < ticket.Lines.Length; i++)
        {
            var line = ticket.Lines[i];
            using var font = new Font("Arial", line.Size, line.Bold ? FontStyle.Bold : FontStyle.Regular);
            graphics.DrawString(line.Text, font, Brushes.Black, new RectangleF(0, y, width, heights[i]), format);
            y += heights[i];
        }
        WidthUnits = (int)Math.Round(widthMm / 25.4 * 100);
        HeightUnits = (int)Math.Ceiling(height / Dpi * 100 + 4 / 25.4 * 100);
    }
    public void Dispose() => Image.Dispose();
}

public sealed record PrintOutcome(string Status, string Guarantee, string? Error = null);

public static class WindowsPrinter
{
    public static string[] Enumerate() => PrinterSettings.InstalledPrinters.Cast<string>().ToArray();

    public static PrintOutcome Print(AgentConfig config, Ticket ticket, string requestId, bool dryRun = false)
    {
        bool submissionStarted = false;
        try
        {
            config.Validate();
            if (!Enumerate().Contains(config.PrinterName, StringComparer.Ordinal))
                throw new ArgumentException("Configured printer is not installed for this Windows account.");
            using var raster = new TicketRaster(ticket, config.PaperWidthMm);
            using var document = new PrintDocument();
            document.PrinterSettings.PrinterName = config.PrinterName;
            document.PrinterSettings.Copies = 1;
            document.PrinterSettings.PrintToFile = false;
            document.DocumentName = "TableCore-" + requestId;
            document.PrintController = new StandardPrintController();
            document.DefaultPageSettings.Landscape = false;
            document.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);
            document.DefaultPageSettings.PaperSize = new PaperSize("TableCore ticket", raster.WidthUnits, raster.HeightUnits);
            // Round-trip through the driver before StartDoc. Reject an A4/default fallback.
            var devmode = document.PrinterSettings.GetHdevmode(document.DefaultPageSettings);
            try { document.DefaultPageSettings.SetHdevmode(devmode); }
            finally { GlobalFree(devmode); }
            var page = document.DefaultPageSettings;
            if (Math.Abs(page.Bounds.Width - raster.WidthUnits) > 2 || Math.Abs(page.Bounds.Height - raster.HeightUnits) > 2)
                throw new InvalidOperationException("Driver rejected compact custom paper size. Configure its roll/custom form.");
            float imageWidth = raster.Image.Width / TicketRaster.Dpi * 100;
            float imageHeight = raster.Image.Height / TicketRaster.Dpi * 100;
            if (page.PrintableArea.Width < imageWidth || page.PrintableArea.Height < imageHeight)
                throw new InvalidOperationException("Driver printable area is too small for this ticket.");
            if (dryRun)
                return new("PREFLIGHT_ONLY", $"Driver reports {page.Bounds.Width} x {page.Bounds.Height} hundredths of an inch; printable area {page.PrintableArea.Width} x {page.PrintableArea.Height}. No Print call, no spool submission.");
            document.PrintPage += (_, e) => {
                if (e.Graphics is null) throw new InvalidOperationException("No printer graphics context.");
                if (Math.Abs(e.PageBounds.Width - raster.WidthUnits) > 2 || Math.Abs(e.PageBounds.Height - raster.HeightUnits) > 2)
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

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern IntPtr GlobalFree(IntPtr memory);
}
