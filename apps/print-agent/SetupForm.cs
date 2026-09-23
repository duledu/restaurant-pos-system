using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;

namespace TableCore.PrintAgent;

/// <summary>
/// Faza 2C — interaktivan ekran za uparivanje i podešavanje. Pokreće se
/// SAMO kad korisnik dvoklikne EXE (ili prečicu na Start meniju) bez
/// argumenata i proces NIJE Windows servis (vidi Program.cs) — servis
/// (Session 0) ne sme i ne može prikazati UI. Ovo je JEDINO mesto gde
/// restoranski menadžer ikad vidi prozor od agenta; sve ostalo (SCM
/// start/stop, poll petlja, štampa) radi nevidljivo u pozadini.
///
/// NIKAD ne prikazuje sirov trajan kredencijal niti njegov heš — samo
/// status "Povezano sa TableCore", ime restorana/stanice/štampača.
/// </summary>
public sealed class SetupForm : Form
{
    // TableCore brend boje (isto kao apps/web/tailwind.config.* graphite/gold)
    // — jedina promena stila u ovom fajlu je _pairButton (primarni CTA za
    // uparivanje); ostala dugmad (_testPrintButton/_saveButton) NAMERNO
    // ostaju podrazumevani WinForms izgled, da se ne redizajnira ceo ekran.
    private static readonly Color BrandGraphite = Color.FromArgb(0x0A, 0x19, 0x31);
    private static readonly Color BrandGraphiteHover = Color.FromArgb(0x1A, 0x3D, 0x63);
    private static readonly Color BrandGraphiteDisabled = Color.FromArgb(0x9A, 0x9F, 0xA6);
    // #3 (Setup redesign, 2026-09-2x) — presentation-only palette additions.
    // Nothing below changes what any control DOES, only how the existing
    // sections (connection status, printer-assignment cards, advanced/
    // diagnostics) are visually grouped — see the card/banner/toggle panels
    // built in the constructor.
    private static readonly Color CardBackground = Color.FromArgb(0xF6, 0xF7, 0xF9);
    private static readonly Color CardBorder = Color.FromArgb(0xE1, 0xE4, 0xE9);
    private static readonly Color BannerConnectedBg = Color.FromArgb(0xEA, 0xF7, 0xEE);
    private static readonly Color BannerConnectedBorder = Color.FromArgb(0x9F, 0xD9, 0xB2);
    private static readonly Color BannerPendingBg = Color.FromArgb(0xFB, 0xF4, 0xE7);
    private static readonly Color BannerPendingBorder = Color.FromArgb(0xE9, 0xCE, 0x9A);
    private static readonly Color BrandSuccess = Color.FromArgb(0x1E, 0x7A, 0x3C);

    private readonly Label _statusLabel = new() { AutoSize = true, MaximumSize = new Size(420, 0) };
    private readonly TextBox _pairingCodeBox = new() { Width = 220, PlaceholderText = "XXXX-XXXX-XXXX" };
    private readonly Button _pairButton = new()
    {
        Text = "Poveži",
        Width = 160,
        Height = 36,
        FlatStyle = FlatStyle.Flat,
        BackColor = BrandGraphite,
        ForeColor = Color.White,
        Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
        Cursor = Cursors.Hand,
        Margin = new Padding(8, 0, 0, 0),
    };
    // AutoSize=false + fiksna visina, UVEK vidljiva (nikad Visible=false) —
    // NAMERNO, da se prostor za ovu poruku rezerviše u layout-u OD POČETKA,
    // pa pojava/promena teksta (npr. "Poveži" -> "Povezivanje..." ->
    // uspeh/neuspeh) NIKAD ne pomera/menja visinu ičega ispod (Stanica/
    // Štampač/Širina papira/Test Print/Sačuvaj) — upravo bug prijavljen sa
    // fizičkog test računara (donja dugmad su nestajala/sekla se kad bi se
    // ova poruka pojavila, jer je ranije bila AutoSize+Visible=false, što
    // MENJA ukupnu visinu sadržaja u trenutku kad ekran ima fiksnu visinu).
    // Word-wrap via MaximumSize+AutoSize keeps the form from clipping long
    // Serbian messages at 125 %/150 % DPI on Windows 11 where font ascent
    // pushes past the original fixed 32 px height.
    private readonly Label _pairFeedbackLabel = new() { AutoSize = true, MaximumSize = new Size(440, 0), TextAlign = ContentAlignment.TopLeft };
    // Physical QA follow-up — explicit re-pair confirmation. Reserved-space,
    // always-visible-when-active label (same "never Visible=false toggling
    // that changes layout height mid-flow" convention as _pairFeedbackLabel)
    // shown ONLY while re-pair mode is unlocked (see EnterRepairMode) — both
    // for a manual "Ponovo upari" click and for an incoming tablecore-print://
    // URI's explicit re-pair intent while already paired.
    private readonly Label _repairWarningLabel = new() { AutoSize = false, Size = new Size(420, 34), TextAlign = ContentAlignment.TopLeft, ForeColor = Color.Firebrick, Visible = false };
    private readonly Button _repairCancelButton = new() { Text = "Otkaži", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(10, 6, 10, 6), Margin = new Padding(8, 0, 0, 0), Visible = false };
    // PRINTING P0 — "IZABERI NAMENU" step. Three route rows
    // (KUHINJA / ŠANK / RAČUN) — each with its own printer + paper-width
    // picker + clear button + per-route status text. The operator picks
    // which Windows printer serves each destination type on THIS
    // workstation. Picking is local (WindowsPrinter.Enumerate is purely
    // in-process); persisting to the server happens on Sačuvaj namenu via
    // DeliveryClient.UpsertRouteAssignment. The same printer may be picked
    // for multiple routes (KUHINJA + ŠANK on a single POS-58 is a common
    // small-restaurant setup).
    private sealed class RouteDraftRow
    {
        public required string Type { get; init; }
        public required string RestaurantLabel { get; init; }
        public required ComboBox PrinterBox { get; init; }
        public required ComboBox PaperWidthBox { get; init; }
        public required Button ClearButton { get; init; }
        public required Label StatusLabel { get; init; }
    }
    private readonly List<RouteDraftRow> _routeDrafts = new();
    private readonly string[] _availablePrinters;
    // PRINTING P0 — additional wizard feedback labels, separate from
    // _pairFeedbackLabel (which is reserved for pairing) and
    // _saveFeedbackLabel (which is reserved for the full
    // test+confirm+close flow). Keeping them apart avoids the operator
    // confusion of "did the just-clicked button succeed or fail".
    private readonly Label _namenuFeedbackLabel = new() { AutoSize = false, Size = new Size(420, 32), TextAlign = ContentAlignment.TopLeft };
    private readonly Label _discoveredPrintersLabel = new() { AutoSize = true, MaximumSize = new Size(420, 0) };
    private readonly Button _saveNamenuButton = new() { Text = "Sačuvaj namenu", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(10, 6, 10, 6) };
    // PRINTING P0 — the "Napredno / dijagnostika" affordance kept ONLY
    // for IT support who genuinely need to print to an arbitrary
    // Windows printer regardless of server routing. Hidden in an
    // Advanced section so normal restaurant staff never see it.
    private readonly ComboBox _testRouteTypeBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    private readonly ComboBox _printerBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    private readonly ComboBox _paperWidthBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    // AutoSize + Padding umesto podrazumevane FIKSNE WinForms veličine
    // dugmeta (75x23 px na 96 DPI) — taj fiksni raster ne ostavlja dovoljno
    // vertikalnog prostora za tekst na 125%/150% Windows skaliranju (upravo
    // prijavljen bug: "Test"/"Sačuvaj" tekst vertikalno isečen). AutoSize
    // meri STVARNU visinu teksta pri TRENUTNOM DPI/font skaliranju i uvek
    // ostavlja Padding oko nje — ispravno na 100/125/150% bez potrebe da se
    // cela forma uveličava.
    private readonly Button _testPrintButton = new() { Text = "Probna štampa (dijagnostika)", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(10, 6, 10, 6) };
    private readonly Button _saveButton = new() { Text = "Testiraj i završi podešavanje", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(10, 6, 10, 6) };
    // PREPROD physical QA follow-up (Part A1) — isti "rezervisan prostor,
    // fiksna visina" obrazac kao _pairFeedbackLabel iznad (namerno
    // ODVOJENO od njega: ovo je povratna informacija za Sačuvaj, ne za
    // Poveži, i pojavljuje se tek posle Testa štampe/dugmadi ispod, ne pre
    // njih — mešanje ta dva bi zbunilo korisnika o TOME koja radnja je
    // upravo uspela/pala).
    private readonly Label _saveFeedbackLabel = new() { AutoSize = false, Size = new Size(420, 40), TextAlign = ContentAlignment.TopLeft };
    private readonly Label _versionLabel = new() { AutoSize = true, Text = $"TableCore Print Agent v{AgentVersion.Current}" };
    private readonly Label _endpointLabel = new() { AutoSize = true };

    // #3 (Setup redesign) — connection status banner. Wraps the EXISTING
    // _statusLabel (its Text/logic is still set exclusively by
    // RefreshStatus below, completely unchanged) in a colored card so the
    // paired/unpaired state reads as the dominant thing on screen instead
    // of a plain gray line at the top.
    private readonly Panel _connectionBanner = new()
    {
        AutoSize = true,
        AutoSizeMode = AutoSizeMode.GrowAndShrink,
        Padding = new Padding(12, 10, 12, 10),
        BackColor = BannerPendingBg,
    };
    // #3 — pairing controls (code box / Poveži / Otkaži / feedback /
    // re-pair warning) become SECONDARY once paired: collapsed by default
    // behind this link, expandable for recovery. Never removes the
    // capability — see RefreshStatus/EnterRepairMode/ExitRepairMode/OnPair,
    // which only gain a couple of ADDITIVE _pairingDetailsPanel.Visible
    // lines; none of their existing decision logic changes.
    private readonly LinkLabel _pairingToggleLink = new()
    {
        Text = "Ponovo upari / promeni računar",
        AutoSize = true,
        Visible = false,
        Margin = new Padding(0, 10, 0, 0),
        LinkColor = BrandGraphite,
        LinkBehavior = LinkBehavior.HoverUnderline,
    };
    // TableLayoutPanel (not plain Panel) — this holds SEVERAL stacked
    // children (label/pairRow/feedback/warning) added via Controls.Add in
    // the constructor; a plain Panel does not auto-stack its children
    // (they'd all sit at Location (0,0) and overlap), matching the same
    // ColumnCount=1 vertical-stack pattern used by `layout`/`advancedInner`
    // elsewhere in this file.
    private readonly TableLayoutPanel _pairingDetailsPanel = new()
    {
        AutoSize = true,
        AutoSizeMode = AutoSizeMode.GrowAndShrink,
        ColumnCount = 1,
    };
    // #3/#6 — technical/diagnostic content (raw endpoint, agent version,
    // the "print to any printer regardless of routing" diagnostic tool)
    // moved behind a collapsed-by-default "Napredno / Dijagnostika"
    // disclosure instead of always being visible in the normal flow.
    // Nothing about what these controls DO changes — same fields, same
    // event handlers, only their default container visibility.
    private readonly LinkLabel _advancedToggleLink = new()
    {
        Text = "▸ Napredno / Dijagnostika",
        AutoSize = true,
        Margin = new Padding(0, 18, 0, 0),
        LinkColor = SystemColors.GrayText,
        LinkBehavior = LinkBehavior.HoverUnderline,
    };
    private readonly Panel _advancedPanel = new()
    {
        AutoSize = true,
        AutoSizeMode = AutoSizeMode.GrowAndShrink,
        Visible = false,
        Margin = new Padding(0, 6, 0, 0),
    };

    private readonly AgentEndpoint _endpoint = null!;
    private readonly string? _endpointError;
    private readonly string? _prefillPairingCode;

    public SetupForm() : this([], null) { }

    /// <summary>
    /// Faza 2C — bezbednosni zahtev, sekcija 8: "Setup/service configuration
    /// must expose enough information to confirm which endpoint is active."
    /// Argumenti (--mode/--server) se prosleđuju SAMO kad je Setup ekran
    /// eksplicitno pokrenut sa njima (razvoj/prihvatno testiranje preko
    /// interaktivnog puta u Program.cs) — instalacioni Start meniju prečica
    /// pokreće bez argumenata, što znači Production/tablecore.net, isto kao
    /// servis. AKO je rezolucija nevalidna, ne rušimo ceo ekran — status red
    /// prikazuje grešku i uparivanje ostaje onemogućeno dok se ne ispravi
    /// (isto "fail closed, nikad tih pad na produkciju" pravilo kao
    /// AgentService.cs/Program.cs).
    ///
    /// Printing V2 — <paramref name="prefillPairingCode"/> dolazi iz
    /// tablecore-print:// URI aktivacije (Admin "Otvori TableCore Print
    /// Agent" dugme, vidi Program.cs/SetupArgumentDispatch). SAMO popunjava
    /// tekst polja pre uparivanja — nikad ne pokreće OnPair() automatski
    /// (korisnik i dalje mora eksplicitno kliknuti "Poveži"), i nikad se ne
    /// koristi ako je mašina VEĆ uparena (vidi Initialize ispod) — otvaranje
    /// agenta iz Admin panela nikad ne dira postojeće uparivanje.
    /// </summary>
    public SetupForm(string[] args, string? prefillPairingCode)
    {
        _prefillPairingCode = prefillPairingCode;
        try
        {
            _endpoint = AgentEndpoint.Resolve(args);
            // Professional audit fix — this used to call only
            // PairingClient.ConfigureBypassHeader, which is exactly why
            // pairing (PairingClient's own HttpClient) worked physically
            // while the immediate Save-time heartbeat (DeliveryClient's
            // SEPARATE HttpClient) did not: it went out with no bypass
            // header, Vercel's edge rejected it, and Setup wrongly reported
            // "proverite internet konekciju". See AgentEndpoint.
            // ConfigureAgentHttpClients for the full explanation.
            AgentEndpoint.ConfigureAgentHttpClients(_endpoint);
        }
        catch (AgentEndpointConfigurationException ex)
        {
            _endpointError = ex.Message;
        }
        Text = "TableCore Print Agent — podešavanje";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AcceptButton = _pairButton;
        // AutoSize umesto fiksne Height — forma UVEK raste da stane sav
        // sadržaj (bez obzira na DPI/font skaliranje na stvarnom Windows 11
        // test računaru, dužinu prevoda, ili broj redova poruke), nikad ne
        // seče donju akcionu traku (Test Print/Sačuvaj). AutoScaleMode.Font
        // (podrazumevano za WinForms) obezbeđuje da se i sami kontrolski
        // elementi skaliraju sa sistemskim DPI-jem pre nego što se izmeri
        // ukupna visina za AutoSize — širina ostaje fiksna preko
        // MinimumSize/MaximumSize, samo visina je promenljiva.
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        MinimumSize = new Size(520, 0);

        _pairButton.FlatAppearance.BorderSize = 0;
        _pairButton.FlatAppearance.MouseOverBackColor = BrandGraphiteHover;
        _pairButton.FlatAppearance.MouseDownBackColor = BrandGraphiteHover;

        // Cached printer enumeration — used both to populate the
        // IZABERI NAMENU combo boxes below AND to display the
        // "discovered printers" count for the operator. Snapshot taken
        // at form construction so the operator always sees what the
        // wizard itself sees (matches what the running Service will
        // see in AgentRunner).
        _availablePrinters = WindowsPrinter.Enumerate();

        // Dock=Top (ne Fill) + AutoSize — panel zauzima tačno onoliko visine
        // koliko mu treba sadržaj, forma iznad raste da je isprati. Dodatan
        // razmak na dnu (Padding bottom 24 umesto 16) da donja dugmad nikad
        // ne budu tik uz ivicu prozora.
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            Padding = new Padding(16, 16, 16, 24),
        };

        // #3 — connection status banner (POVEŽI / connected state). Bigger,
        // bolded _statusLabel inside a colored card — RefreshStatus below
        // still owns 100% of _statusLabel's TEXT and continues to also
        // color/size this SAME banner panel based on paired state.
        _statusLabel.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
        _connectionBanner.Controls.Add(_statusLabel);
        layout.Controls.Add(_connectionBanner);

        // #3 — pairing/recovery becomes secondary: collapsed behind a link
        // once paired (see RefreshStatus/EnterRepairMode/ExitRepairMode/
        // OnPair for the additive Visible toggles), always expanded while
        // unpaired since pairing IS the primary task at that point.
        layout.Controls.Add(_pairingToggleLink);
        _pairingDetailsPanel.Controls.Add(new Label { Text = "Kod za uparivanje:", AutoSize = true, Margin = new Padding(0, 16, 0, 2) });
        var pairRow = new FlowLayoutPanel { AutoSize = true, WrapContents = true };
        _pairingCodeBox.Margin = new Padding(0, 6, 8, 0);
        _pairButton.Margin = new Padding(0, 0, 8, 0);
        pairRow.Controls.Add(_pairingCodeBox);
        pairRow.Controls.Add(_pairButton);
        pairRow.Controls.Add(_repairCancelButton);
        _pairingDetailsPanel.Controls.Add(pairRow);
        _pairFeedbackLabel.Margin = new Padding(0, 4, 0, 0);
        _pairingDetailsPanel.Controls.Add(_pairFeedbackLabel);
        _repairWarningLabel.Margin = new Padding(0, 0, 0, 0);
        _pairingDetailsPanel.Controls.Add(_repairWarningLabel);
        layout.Controls.Add(_pairingDetailsPanel);

        // PRINTING P0 — IZABERI NAMENU step. The operator picks which
        // Windows printer + paper width serves each route (KUHINJA /
        // ŠANK / RAČUN) for THIS workstation. The same physical printer
        // is allowed to serve multiple routes (KUHINJA + ŠANK on a
        // single POS-58 is a common small-restaurant setup) — the UI
        // deliberately does not prevent this.
        _discoveredPrintersLabel.Margin = new Padding(0, 20, 0, 0);
        _discoveredPrintersLabel.Text = _availablePrinters.Length switch
        {
            0 => "Nijedan štampač nije detektovan na ovom računaru.",
            1 => "Detektovan 1 štampač na ovom računaru.",
            _ => $"Detektovano {_availablePrinters.Length} štampača na ovom računaru.",
        };
        _discoveredPrintersLabel.ForeColor = _availablePrinters.Length == 0 ? Color.Firebrick : SystemColors.GrayText;
        layout.Controls.Add(_discoveredPrintersLabel);
        // #3 — "rute"/"namena" (developer/internal terms) replaced with a
        // plain restaurant-facing section title in the primary UX; the
        // underlying route TYPE strings (KITCHEN/BAR/RECEIPT) and server
        // API are untouched — this is a label only.
        layout.Controls.Add(new Label
        {
            Text = "Štampači",
            AutoSize = true,
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            Margin = new Padding(0, 10, 0, 2),
        });
        layout.Controls.Add(new Label
        {
            Text = "Izaberi koji štampač i širinu papira koristi svaka namena:",
            AutoSize = true,
            MaximumSize = new Size(440, 0),
            ForeColor = SystemColors.GrayText,
            Margin = new Padding(0, 0, 0, 6),
        });
        BuildRouteDraftRows();
        foreach (var row in _routeDrafts)
        {
            var routeCard = BuildRouteCardPanel(row);
            routeCard.Margin = new Padding(0, 0, 0, 8);
            layout.Controls.Add(routeCard);
        }
        var namenuActionRow = new FlowLayoutPanel { AutoSize = true, WrapContents = true, Margin = new Padding(0, 4, 0, 0) };
        namenuActionRow.Controls.Add(_saveNamenuButton);
        layout.Controls.Add(namenuActionRow);
        _namenuFeedbackLabel.Margin = new Padding(0, 4, 0, 0);
        layout.Controls.Add(_namenuFeedbackLabel);

        // #3 — TESTIRAJ → POTVRDI → SPREMNO is one continuous action
        // (OnSave already drives test-print → human confirmation → ready
        // per route internally); _saveButton is now the sole, visually
        // primary control in this row. The old always-visible diagnostic
        // "Probna štampa" button moves into Napredno/Dijagnostika below —
        // same field, same Click handler, only its container changes.
        _saveButton.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
        var actionRow = new FlowLayoutPanel { AutoSize = true, WrapContents = true, Margin = new Padding(0, 18, 0, 0) };
        actionRow.Controls.Add(_saveButton);
        layout.Controls.Add(actionRow);
        _saveFeedbackLabel.Margin = new Padding(0, 4, 0, 0);
        layout.Controls.Add(_saveFeedbackLabel);

        // #3/#6 — technical/diagnostic information (raw server endpoint,
        // agent version, ad hoc "print to any printer" tool) is real and
        // useful for support, but must not dominate the normal restaurant
        // setup flow — moved behind this collapsed-by-default disclosure.
        layout.Controls.Add(_advancedToggleLink);
        var advancedInner = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            Padding = new Padding(10, 8, 10, 8),
        };
        advancedInner.Controls.Add(new Label { Text = "Probna štampa na proizvoljnom štampaču (dijagnostika):", AutoSize = true, MaximumSize = new Size(420, 0), ForeColor = SystemColors.GrayText, Margin = new Padding(0, 0, 0, 4) });
        var diagnosticRow = new FlowLayoutPanel { AutoSize = true, WrapContents = true };
        diagnosticRow.Controls.Add(_testRouteTypeBox);
        diagnosticRow.Controls.Add(_printerBox);
        diagnosticRow.Controls.Add(_paperWidthBox);
        advancedInner.Controls.Add(diagnosticRow);
        _testPrintButton.Margin = new Padding(0, 8, 0, 0);
        advancedInner.Controls.Add(_testPrintButton);
        _versionLabel.Margin = new Padding(0, 16, 0, 0);
        advancedInner.Controls.Add(_versionLabel);
        _endpointLabel.Margin = new Padding(0, 2, 0, 0);
        _endpointLabel.ForeColor = _endpointError is null ? SystemColors.GrayText : Color.Firebrick;
        _endpointLabel.Text = _endpointError is null
            ? $"Server: {_endpoint.DescribeForLog()}"
            : $"Nevalidno podešavanje servera: {_endpointError}";
        advancedInner.Controls.Add(_endpointLabel);
        _advancedPanel.Controls.Add(advancedInner);
        layout.Controls.Add(_advancedPanel);

        Controls.Add(layout);

        _pairingToggleLink.Click += (_, _) => _pairingDetailsPanel.Visible = !_pairingDetailsPanel.Visible;
        _advancedToggleLink.Click += (_, _) =>
        {
            _advancedPanel.Visible = !_advancedPanel.Visible;
            _advancedToggleLink.Text = _advancedPanel.Visible ? "▾ Napredno / Dijagnostika" : "▸ Napredno / Dijagnostika";
        };

        // Diagnostic OnTestPrint path — populate its combo boxes too
        // so tech support can still print to any printer regardless
        // of routing. Kept distinct from the IZABERI NAMENU rows
        // (different layout, intentionally not shown by default in
        // normal restaurant-staff flow).
        _testRouteTypeBox.Items.AddRange(["KITCHEN", "BAR", "RECEIPT"]);
        _testRouteTypeBox.SelectedIndex = 0;
        _paperWidthBox.Items.AddRange(["58", "80"]);
        _printerBox.Items.AddRange(_availablePrinters);

        // Physical QA follow-up — clicking the primary button while ALREADY
        // paired must not immediately attempt to pair with whatever
        // (probably empty/disabled) text happens to be in the box; it must
        // first unlock re-pair mode so the user can actually type/verify a
        // code. This is the fix for the reported "the only pairing action
        // is Ponovo upari, but the field stays disabled with no way to
        // enter a new code" — a manual re-pair was structurally impossible
        // before this, not just the URI-prefill case.
        _pairButton.Click += async (_, _) =>
        {
            if (CredentialStore.HasStoredCredential() && !_repairUnlocked)
            {
                EnterRepairMode(presetCode: null, viaUri: false);
                return;
            }
            await OnPair();
        };
        _repairCancelButton.Click += (_, _) => ExitRepairMode();
        _saveButton.Click += async (_, _) => await OnSave();
        _testPrintButton.Click += (_, _) => OnTestPrint();
        _saveNamenuButton.Click += async (_, _) => await OnSaveNamenu();

        Load += (_, _) => Initialize();
    }

    private string? _connectedName;
    private int _configuredRouteCount;
    private bool _repairUnlocked;

    private void Initialize()
    {
        AgentPaths.EnsureProgramDataDirectory();
        var paired = CredentialStore.HasStoredCredential();
        LoadExistingConfigIfPresent();
        RefreshStatus(paired);

        // PairingFlow.Resolve is the single, independently self-tested
        // source of truth for CASE A/B — see PairingFlow.cs. This method
        // just applies whatever it decides to the actual controls.
        var uiState = PairingFlow.Resolve(paired, _prefillPairingCode);
        switch (uiState.Mode)
        {
            case PairingUiMode.ConfirmRepair:
                // CASE B, already paired — explicit URI re-pair intent must
                // win, but ONLY as a visible, confirmable offer (never a
                // silent credential swap).
                EnterRepairMode(uiState.PairingCodeBoxText, viaUri: true);
                break;
            case PairingUiMode.PrefillUnpaired:
                // CASE B, unpaired — ordinary pre-fill, no extra
                // confirmation needed (no existing pairing to protect).
                _pairingCodeBox.Text = uiState.PairingCodeBoxText;
                _pairingCodeBox.Enabled = uiState.PairingCodeBoxEnabled;
                ShowPairFeedback("Kod je automatski popunjen sa Admin panela — proveri i klikni „Poveži“.", isError: false);
                break;
            case PairingUiMode.NormalSettings:
                // CASE A — RefreshStatus(paired) above already applied this
                // exact state (disabled+empty when paired, enabled+empty
                // when not); nothing about an existing pairing is touched.
                break;
        }

        if (_endpointError is not null)
        {
            SetPairButtonEnabled(false);
            _pairingCodeBox.Enabled = false;
            ShowPairFeedback($"Server nije ispravno podešen, uparivanje je onemogućeno: {_endpointError}", isError: true);
        }
    }

    /// <summary>
    /// Unlocks the pairing field for a NEW code — either because the user
    /// clicked "Ponovo upari" themselves, or because an incoming
    /// tablecore-print:// URI carried an explicit new pairing code while
    /// this machine is already paired. Never submits anything by itself;
    /// the user still has to click "Poveži ponovo" (see the required
    /// confirmation UX) or "Otkaži" to back out — see ExitRepairMode.
    /// </summary>
    private void EnterRepairMode(string? presetCode, bool viaUri)
    {
        _repairUnlocked = true;
        _pairingCodeBox.Enabled = true;
        _pairingCodeBox.Text = presetCode ?? "";
        _pairButton.Text = "Poveži ponovo";
        _repairCancelButton.Visible = true;
        _pairingDetailsPanel.Visible = true; // #3 — re-pair always expands the (otherwise collapsed) pairing section
        if (viaUri)
        {
            _repairWarningLabel.Text = "Ovaj računar je već povezan sa TableCore.\nNovi kod će zameniti postojeće uparivanje.";
            _repairWarningLabel.Visible = true;
            ShowPairFeedback("Kod je automatski popunjen sa Admin panela.", isError: false);
        }
        else
        {
            _repairWarningLabel.Visible = false;
            ShowPairFeedback("Unesite novi kod za uparivanje.", isError: false);
        }
    }

    /// <summary>"Otkaži" — backs out of re-pair mode without touching the
    /// existing credential in any way. Also the natural rest state after a
    /// successful re-pair (see OnPair's success path).</summary>
    private void ExitRepairMode()
    {
        _repairUnlocked = false;
        _repairWarningLabel.Visible = false;
        _repairCancelButton.Visible = false;
        RefreshStatus(paired: true); // #3 — also re-collapses _pairingDetailsPanel since _repairUnlocked is now false
        ShowPairFeedback("", isError: false);
    }

    /// <summary>
    /// Flat-stilizovano dugme ne posivi automatski BackColor kad je
    /// Enabled=false (za razliku od podrazumevanog WinForms izgleda) — ovo
    /// eksplicitno prebacuje boju, jedino mesto gde se _pairButton.Enabled
    /// menja u celom fajlu.
    /// </summary>
    private void SetPairButtonEnabled(bool enabled)
    {
        _pairButton.Enabled = enabled;
        _pairButton.BackColor = enabled ? BrandGraphite : BrandGraphiteDisabled;
    }

    private void ShowPairFeedback(string message, bool isError)
    {
        // NIKAD ne dirati .Visible ovde — vidi komentar na deklaraciji
        // _pairFeedbackLabel iznad (rezervisan prostor, fiksna visina).
        _pairFeedbackLabel.Text = message;
        _pairFeedbackLabel.ForeColor = isError ? Color.Firebrick : Color.FromArgb(0x1E, 0x7A, 0x3C);
    }

    /// <summary>Samo za popunjavanje probne-štampe kontrola pogodnom
    /// polaznom vrednošću (poslednja poznata ruta, ako postoji) — nikad ne
    /// utiče na stvarno rutiranje, koje je server-autoritativno (vidi
    /// AgentRunner.ApplyServerRoutes).</summary>
    private void LoadExistingConfigIfPresent()
    {
        if (!File.Exists(AgentPaths.ConfigFilePath)) return;
        try
        {
            var config = AgentConfig.Parse(File.ReadAllText(AgentPaths.ConfigFilePath));
            _configuredRouteCount = config.Routes.Length;
            // PRINTING P0 — populate the IZABERI NAMENU combo boxes from
            // any locally-cached routes so a returning operator sees
            // their last selection (still subject to the wizard's
            // Sačuvaj namenu step before it reaches the server).
            foreach (var route in config.Routes)
            {
                var draft = _routeDrafts.FirstOrDefault(r => r.Type == route.Type);
                if (draft is null) continue;
                draft.PrinterBox.SelectedItem = route.PrinterName;
                draft.PaperWidthBox.SelectedItem = route.PaperWidthMm.ToString();
            }
            // Diagnostic combo boxes — populate from the FIRST route for
            // backward-compat with the original "test any printer" use.
            var first = config.Routes.FirstOrDefault();
            if (first is not null)
            {
                _testRouteTypeBox.SelectedItem = first.Type;
                _paperWidthBox.SelectedItem = first.PaperWidthMm.ToString();
                if (_printerBox.Items.Contains(first.PrinterName)) _printerBox.SelectedItem = first.PrinterName;
            }
        }
        catch
        {
            // Nepotpuna/oštećena konfiguracija — korisnik i dalje može
            // upariti/testirati ispod, ne blokiramo Setup ekran zbog toga.
        }
    }

    /// <summary>
    /// PRINTING P0 — populates the three IZABERI NAMENU rows (KUHINJA /
    /// ŠANK / RAČUN). Each row carries its own printer + paper-width
    /// combo box + clear button + status label. Combo boxes are
    /// DropDownList (not editable) so the operator cannot type a name
    /// that doesn't exist on the machine — WindowsPrinter.Enumerate
    /// already gave us the only valid set.
    /// </summary>
    private void BuildRouteDraftRows()
    {
        var routeSpecs = new (string Type, string Label)[]
        {
            ("KITCHEN", "Kuhinja"),
            ("BAR", "Šank"),
            ("RECEIPT", "Račun"),
        };
        foreach (var (type, label) in routeSpecs)
        {
            var printerBox = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                Width = 220,
                Enabled = _availablePrinters.Length > 0,
            };
            foreach (var p in _availablePrinters) printerBox.Items.Add(p);
            // Empty default — operator MUST explicitly pick a printer
            // (no "first available" auto-pick: that would silently bind
            // a route to the wrong printer, defeating the wizard).
            if (printerBox.Items.Count > 0) printerBox.SelectedIndex = -1;

            var paperWidthBox = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                Width = 100,
            };
            paperWidthBox.Items.AddRange(["58", "80"]);
            paperWidthBox.SelectedIndex = 0;

            var clearButton = new Button
            {
                Text = "Obriši",
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Padding = new Padding(10, 4, 10, 4),
                Enabled = false, // enabled only when a printer is picked
            };

            var statusLabel = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(420, 0),
                Text = "Izaberi štampač za ovu namenu (opciono — rute koje nisu podešene ne štampaju).",
                ForeColor = SystemColors.GrayText,
            };

            // Enable "Obriši" only when a printer is chosen.
            printerBox.SelectedIndexChanged += (_, _) =>
            {
                clearButton.Enabled = printerBox.SelectedItem is string;
                if (printerBox.SelectedItem is null)
                {
                    statusLabel.Text = "Izaberi štampač za ovu namenu (opciono — rute koje nisu podešene ne štampaju).";
                    statusLabel.ForeColor = SystemColors.GrayText;
                }
                else
                {
                    statusLabel.Text = $"Štampač: {printerBox.SelectedItem}. Klikni „Sačuvaj namenu“ da se primeni.";
                    statusLabel.ForeColor = SystemColors.GrayText;
                }
            };
            clearButton.Click += (_, _) =>
            {
                printerBox.SelectedIndex = -1;
                statusLabel.Text = "Izaberi štampač za ovu namenu (opciono — rute koje nisu podešene ne štampaju).";
                statusLabel.ForeColor = SystemColors.GrayText;
            };

            _routeDrafts.Add(new RouteDraftRow
            {
                Type = type,
                RestaurantLabel = label,
                PrinterBox = printerBox,
                PaperWidthBox = paperWidthBox,
                ClearButton = clearButton,
                StatusLabel = statusLabel,
            });
        }
    }

    /// <summary>
    /// PRINTING P0 — builds the inner panel for a single route row:
    /// [Kuhinja] [Štampač combo] [Širina combo] [Obriši]
    /// Below: per-row status label with word-wrap for long messages.
    /// AutoSize on every control + flow panel that wraps on narrow
    /// widths (DPI-safe at 100/125/150 %).
    /// </summary>
    // #3 — visual "card" per route (KUHINJA/ŠANK/RAČUN): a bordered,
    // tinted panel instead of a bare flow of controls, so the three
    // purposes read as distinct, clearly grouped choices rather than one
    // undifferentiated block. Same controls (row.PrinterBox/PaperWidthBox/
    // ClearButton/StatusLabel), same event wiring from BuildRouteDraftRows
    // — only the container/typography around them changes. WrapContents
    // stays true (unchanged) so the row never gets clipped at higher DPI.
    private TableLayoutPanel BuildRouteCardPanel(RouteDraftRow row)
    {
        // Single Panel with the native BorderStyle.FixedSingle — deliberately
        // NOT nested Dock=Fill panels inside an AutoSize parent (a classic
        // WinForms sizing trap: AutoSize wants to measure children, Dock=Fill
        // wants to fill the already-measured parent — the two can deadlock
        // to a 0-size control). BorderStyle avoids that entirely while still
        // giving each route its own visually distinct bordered/tinted card.
        var card = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            BackColor = CardBackground,
            BorderStyle = BorderStyle.FixedSingle,
            Padding = new Padding(9, 7, 9, 7),
        };
        var headerRow = new FlowLayoutPanel
        {
            AutoSize = true,
            WrapContents = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = CardBackground,
            Margin = new Padding(0, 0, 0, 4),
        };
        var typeLabel = new Label
        {
            Text = row.RestaurantLabel,
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 10f, FontStyle.Bold),
            BackColor = CardBackground,
            Margin = new Padding(0, 6, 10, 0),
        };
        headerRow.Controls.Add(typeLabel);
        headerRow.Controls.Add(row.PrinterBox);
        headerRow.Controls.Add(row.PaperWidthBox);
        headerRow.Controls.Add(row.ClearButton);
        card.Controls.Add(headerRow);
        row.StatusLabel.Margin = new Padding(0, 2, 0, 0);
        row.StatusLabel.BackColor = CardBackground;
        card.Controls.Add(row.StatusLabel);
        return card;
    }

    /// <summary>
    /// PRINTING P0 — IZABERI NAMENU save handler. Persists the
    /// operator's per-route printer + paper-width picks to the server
    /// via DeliveryClient.UpsertRouteAssignment, which calls
    /// workstation-service.upsertPrintRouteByAgent under the Agent's
    /// own bearer credential. Routes the operator left empty are
    /// DELETED server-side (so they don't appear in heartbeat route
    /// lists or Admin panels).
    ///
    /// Intended to be called BEFORE the OnSave() physical-test+confirm
    /// flow — OnSave now requires the routes to already exist server-
    /// side (otherwise it would just fall back to the old "set up
    /// routes in Admin" message).
    /// </summary>
    private async Task OnSaveNamenu()
    {
        var credential = CredentialStore.Load();
        if (credential is null)
        {
            ShowNamenuFeedback("Računar još nije uparen — prvo se poveži kodom iznad.", isError: true);
            return;
        }
        if (_availablePrinters.Length == 0)
        {
            ShowNamenuFeedback("Nijedan štampač nije detektovan na ovom računaru — instaliraj drajver i pokreni podešavanje ponovo.", isError: true);
            return;
        }

        _saveNamenuButton.Enabled = false;
        var previousText = _saveNamenuButton.Text;
        _saveNamenuButton.Text = "Čuvanje…";
        ShowNamenuFeedback("Čuvanje namene štampača…", isError: false);
        try
        {
            var anySaved = false;
            foreach (var row in _routeDrafts)
            {
                if (row.PrinterBox.SelectedItem is not string printerName)
                {
                    // Empty route — explicit DELETE so the server stops
                    // returning it in heartbeat route lists.
                    await DeliveryClient.DeleteRouteAssignment(_endpoint.BaseUrl, credential, row.Type);
                    continue;
                }
                var widthText = row.PaperWidthBox.SelectedItem as string ?? "58";
                if (!int.TryParse(widthText, out var widthMm)) widthMm = 58;
                var ok = await DeliveryClient.UpsertRouteAssignment(
                    _endpoint.BaseUrl, credential, row.Type,
                    printerName: printerName,
                    paperWidthMm: widthMm,
                    isEnabled: true,
                    isPrimary: false);
                if (ok)
                {
                    anySaved = true;
                    row.StatusLabel.Text = $"✓ Sačuvano: {printerName}, {widthMm} mm.";
                    row.StatusLabel.ForeColor = Color.FromArgb(0x1E, 0x7A, 0x3C);
                }
                else
                {
                    row.StatusLabel.Text = $"✗ Nije sačuvano za {row.RestaurantLabel} — pokušaj ponovo.";
                    row.StatusLabel.ForeColor = Color.Firebrick;
                }
            }
            _configuredRouteCount = _routeDrafts.Count(r => r.PrinterBox.SelectedItem is string);
            RefreshStatus(paired: true);
            ShowNamenuFeedback(
                anySaved
                    ? "✓ Namena štampača sačuvana. Sledeći korak: klikni „Testiraj i završi podešavanje“ da potvrdiš da tiketi fizički izlaze."
                    : "Nijedna ruta nije podešena — kad odabereš štampač, klikni „Sačuvaj namenu“ ponovo.",
                isError: !anySaved);
        }
        catch (Exception ex)
        {
            ShowNamenuFeedback($"Čuvanje namene nije uspelo: {ex.Message}", isError: true);
        }
        finally
        {
            _saveNamenuButton.Enabled = true;
            _saveNamenuButton.Text = previousText;
        }
    }

    private void ShowNamenuFeedback(string message, bool isError)
    {
        _namenuFeedbackLabel.Text = message;
        _namenuFeedbackLabel.ForeColor = isError ? Color.Firebrick : Color.FromArgb(0x1E, 0x7A, 0x3C);
    }

    private void RefreshStatus(bool paired)
    {
        if (paired)
        {
            var routesText = _configuredRouteCount > 0
                ? $"{_configuredRouteCount} {(_configuredRouteCount == 1 ? "ruta štampe podešena" : "rute štampe podešene")}."
                : "Rute štampe još nisu podešene — podesi ih u Admin panelu (Podešavanja → Štampači).";
            var label = (_connectedName is null ? "Povezano sa TableCore." : $"Povezano sa TableCore: {_connectedName}.") + " " + routesText;
            _pairingCodeBox.Enabled = false;
            _pairButton.Text = "Ponovo upari (novi kod)";
            // #3 — presentation only: paired state reads as a prominent
            // green "connected" banner, and the pairing/re-pair controls
            // (still fully functional, never removed) collapse behind the
            // secondary toggle link instead of dominating the screen.
            _connectionBanner.BackColor = BannerConnectedBg;
            _statusLabel.Text = "✓ Računar je povezan. " + label;
            _pairingToggleLink.Visible = true;
            if (!_repairUnlocked) _pairingDetailsPanel.Visible = false;
        }
        else
        {
            _statusLabel.Text = "Nije upareno. Unesite kod za uparivanje iz Admin panela (Podešavanja → Štampači).";
            _pairingCodeBox.Enabled = true;
            _pairButton.Text = "Poveži";
            // #3 — unpaired: pairing IS the primary task, so it stays
            // expanded and the toggle link (nothing to collapse to) hides.
            _connectionBanner.BackColor = BannerPendingBg;
            _pairingToggleLink.Visible = false;
            _pairingDetailsPanel.Visible = true;
        }
    }

    private async Task OnPair()
    {
        if (_endpointError is not null)
        {
            ShowPairFeedback($"Server nije ispravno podešen, uparivanje je onemogućeno: {_endpointError}", isError: true);
            return;
        }
        var code = _pairingCodeBox.Text.Trim();
        if (code.Length == 0)
        {
            ShowPairFeedback("Unesite kod za uparivanje.", isError: true);
            return;
        }
        var previousButtonText = _pairButton.Text;
        SetPairButtonEnabled(false);
        _pairingCodeBox.Enabled = false;
        _pairButton.Text = "Povezivanje…";
        ShowPairFeedback("Povezivanje sa serverom…", isError: false);
        try
        {
            var result = await PairingClient.PairForSetup(_endpoint.BaseUrl, code);
            if (!result.Success)
            {
                ShowPairFeedback(result.ErrorMessage ?? "Uparivanje nije uspelo.", isError: true);
                _pairButton.Text = previousButtonText;
                return;
            }
            _connectedName = result.Name;
            _pairingCodeBox.Clear();
            // A successful (re-)pair always ends repair mode cleanly and
            // resets the stale route count from whatever the PREVIOUS
            // pairing had cached locally — the new machine identity starts
            // with zero routes server-side until Admin configures them (see
            // OnSave, which will correctly report "0 routes" on the next
            // heartbeat and overwrite this local guess).
            _repairUnlocked = false;
            _repairWarningLabel.Visible = false;
            _repairCancelButton.Visible = false;
            _configuredRouteCount = 0;
            RefreshStatus(paired: true);
            var who = _connectedName is null ? "" : $" — {_connectedName}";
            ShowPairFeedback($"✓ Upareno{who}. Klikni dugme ispod da preuzmeš rute štampe sa servera.", isError: false);
        }
        finally
        {
            SetPairButtonEnabled(true);
            // Repair mode staying unlocked after a FAILED attempt (old
            // credential intentionally untouched — see class doc) must keep
            // the field editable so the user can correct/retry the code,
            // even though CredentialStore.HasStoredCredential() still
            // (correctly) reports the untouched OLD credential as present.
            _pairingCodeBox.Enabled = _repairUnlocked || !CredentialStore.HasStoredCredential();
        }
    }

    /// <summary>
    /// PRINTING P0 — the wizard's main entry point. After pairing is
    /// confirmed, this drives:
    ///
    ///   DETECT      → heartbeat pulls (a) the server's authoritative route
    ///                 list for this workstation AND (b) per-route readiness
    ///                 (visibleToService, physicalTestConfirmed) in a single
    ///                 round-trip.
    ///   CONFIGURE   → routes are server-authoritative (chosen in Admin),
    ///                 NOT in this wizard. The wizard only VERIFIES them.
    ///   PHYSICAL    → for each enabled route, runs the EXACT same
    ///   TEST          WindowsPrinter.Print physical layer used by real
    ///                 jobs (Ticket.TestPrint per type), one route at a time.
    ///   HUMAN       → after every successful physical test, asks the
    ///   CONFIRMATION  operator "Da li je test tiket uspešno odštampan?"
    ///                 — spooler success alone is NEVER sufficient. The
    ///                 operator's YES is forwarded to the server via
    ///                 /api/agent/routes/{type}/confirm-physical and
    ///                 persisted as physicalTestConfirmed=true.
    ///   READY       → only declared when EVERY enabled route has
    ///                 visibleToService=true AND physicalTestConfirmed=true.
    ///                 Until then, Setup stays open and surfaces the next
    ///                 step the operator must take.
    ///
    /// The Service-side visibility check is enforced HERE, before any
    /// physical test. If Setup enumerates a printer (logged-in user
    /// context) but the running Service identity (NT SERVICE\
    /// TableCorePrintAgent) cannot, the wizard blocks with a clear,
    /// actionable Serbian error — NO mention of "service identity",
    /// "per-user install", or PowerShell. The next step is "odštampaj ovaj
    /// tiket sa bilo kog drugog uređaja da potvrdiš da štampač radi,
    /// pa ponovo pokreni podešavanje posle reinstalacije drajvera za
    /// sve korisnike".
    /// </summary>
    private async Task OnSave()
    {
        var credential = CredentialStore.Load();
        if (credential is null)
        {
            _saveFeedbackLabel.Text = "Radna stanica još nije uparena — unesite kod za uparivanje iznad pre nastavka.";
            _saveFeedbackLabel.ForeColor = Color.Firebrick;
            return;
        }

        _saveButton.Enabled = false;
        var previousSaveText = _saveButton.Text;
        _saveButton.Text = "DETEKCIJA…";
        _saveFeedbackLabel.Text = "Preuzimanje ruta štampe sa servera i provera dostupnosti…";
        _saveFeedbackLabel.ForeColor = SystemColors.GrayText;
        try
        {
            AgentPaths.EnsureProgramDataDirectory();
            var installedPrinters = WindowsPrinter.Enumerate();
            var outcome = await DeliveryClient.Heartbeat(
                _endpoint.BaseUrl, credential,
                agentVersion: AgentVersion.Current,
                osDescription: Environment.OSVersion.VersionString,
                availablePrinters: installedPrinters,
                routes: null);

            if (!outcome.Success)
            {
                _saveFeedbackLabel.Text = "Server trenutno nije potvrdio povezivanje. Pokušajte ponovo za par trenutaka pre zatvaranja.";
                _saveFeedbackLabel.ForeColor = Color.Firebrick;
                _saveButton.Enabled = true;
                _saveButton.Text = previousSaveText;
                return;
            }

            // Persist routes locally — same as the running Service would.
            if (outcome.Routes.Count > 0)
            {
                var config = new AgentConfig([.. outcome.Routes.Select(r => new PrintRoute(r.Type, r.PrinterName, r.PaperWidthMm))]);
                var tempPath = AgentPaths.ConfigFilePath + ".tmp";
                File.WriteAllText(tempPath, config.ToJson());
                File.Move(tempPath, AgentPaths.ConfigFilePath, overwrite: true);
                _configuredRouteCount = outcome.Routes.Count;
            }
            else
            {
                _configuredRouteCount = 0;
                _saveFeedbackLabel.Text = "✓ Povezano. Rute štampe još nisu podešene — podesi ih u Admin panelu (Podešavanja → Štampači), pa ponovo pokreni podešavanje na ovom računaru.";
                _saveFeedbackLabel.ForeColor = Color.FromArgb(0x1E, 0x7A, 0x3C);
                RefreshStatus(paired: true);
                _saveButton.Enabled = true;
                _saveButton.Text = previousSaveText;
                return;
            }

            // ─────────────────────────────────────────────────────────────
            // PRINTING P0 — wizard steps.
            // ─────────────────────────────────────────────────────────────

            // ── STEP 1: Service-side visibility ─────────────────────────
            var invisible = outcome.RouteReadiness
                .Where(r => r.Readiness == "AGENT_CANNOT_SEE")
                .ToList();
            if (invisible.Count > 0)
            {
                var list = string.Join("\n", invisible.Select(r => $"  • {r.Type}: štampač {r.PrinterName} (Setup ga vidi, ali servis ga ne vidi)"));
                var msg =
                    "TableCore servis ne može da pristupi izabranom štampaču.\n\n" +
                    "Servis koji štampa tikete radi u pozadini i nema pristup štampačima koji su instalirani samo za jednog korisnika. " +
                    "Ovo je najčešći razlog zašto štampa radi iz ovog prozora, ali ne i za stvarne porudžbine.\n\n" +
                    "Šta da uradite:\n" +
                    "  1. Ponovo instalirajte drajver štampača i izaberite opciju \"Za sve korisnike\" (ili \"Everyone\").\n" +
                    "  2. Restartujte ovaj računar.\n" +
                    "  3. Pokrenite TableCore Print Agent ponovo.\n\n" +
                    "Štampači na kojima servis ne vidi izabrano:\n" + list + "\n\n" +
                    "Podešavanje se ne može završiti dok se ovo ne reši.";
                MessageBox.Show(this, msg, "TableCore — štampač nije dostupan servisu", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                // (see MessageBox above — left in place for the rare service-cannot-see failure;
                // the wizard's HUD label below carries the operator-facing message)
                _saveFeedbackLabel.Text = "✗ Nije moguće završiti podešavanje — servis ne vidi izabrane štampače. Ponovo instalirajte drajvere i restartujte računar.";
                _saveFeedbackLabel.ForeColor = Color.Firebrick;
                _saveButton.Enabled = true;
                _saveButton.Text = previousSaveText;
                return;
            }

            // ── STEP 2 + 3: Physical test + human confirmation, per route ──
            foreach (var readiness in outcome.RouteReadiness)
            {
                if (readiness.PhysicalTestConfirmed) continue; // already confirmed by a previous run — skip
                if (readiness.Readiness == "PENDING_PROBE")
                {
                    // Server hasn't run the visibility probe yet (very
                    // first heartbeat after route configuration). The next
                    // heartbeat (which the running Service performs every
                    // ~25s) will fill this in; for the wizard's purposes
                    // we treat this as "not yet visible" and refuse to
                    // run a test that could mislead the operator.
                    _saveFeedbackLabel.Text =
                        $"Ruta {readiness.Type} još nije proverena. Sačekajte par sekundi i kliknite ponovo.";
                    _saveFeedbackLabel.ForeColor = Color.FromArgb(0xC0, 0x6A, 0x00);
                    _saveButton.Enabled = true;
                    _saveButton.Text = previousSaveText;
                    return;
                }

                // FIZIČKI TEST ŠTAMPE — through the SAME WindowsPrinter.Print
                // path used by real PrintJobs (Ticket.TestPrint per type,
                // identical printer enumeration + page sizing + retry loop).
                _saveButton.Text = $"TEST ŠTAMPE — {readiness.Type}";
                _saveFeedbackLabel.Text = $"Štampam test tiket za {readiness.Type} ({readiness.PrinterName}, {readiness.PaperWidthMm}mm)…";
                _saveFeedbackLabel.ForeColor = SystemColors.GrayText;
                var route = new PrintRoute(readiness.Type, readiness.PrinterName, readiness.PaperWidthMm);
                var ticket = Ticket.TestPrint(Environment.MachineName, readiness.Type, readiness.PrinterName, readiness.PaperWidthMm, AgentVersion.Current);
                var outcome2 = WindowsPrinter.Print(route, ticket, "wizard-" + Guid.NewGuid().ToString("N"));

                if (outcome2.Status != "SUBMITTED_TO_SPOOLER")
                {
                    var msg =
                        $"Test štampa za rutu {readiness.Type} NIJE uspela.\n\n" +
                        $"Štampač: {readiness.PrinterName}\n" +
                        $"Windows poruka: {outcome2.Error ?? "(nema dodatnih detalja)"}\n\n" +
                        $"Proverite da je štampač uključen i da ima papira, pa kliknite \"{previousSaveText}\" ponovo.";
                    MessageBox.Show(this, msg, "TableCore — test štampa neuspešna", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    _saveFeedbackLabel.Text = $"✗ Test štampa za {readiness.Type} neuspešna — {outcome2.Error}";
                    _saveFeedbackLabel.ForeColor = Color.Firebrick;
                    _saveButton.Enabled = true;
                    _saveButton.Text = previousSaveText;
                    return;
                }

                // HUMAN CONFIRMATION — the gate that distinguishes "spooler
                // accepted" from "physical paper came out correctly". Only
                // an explicit YES flips physicalTestConfirmed on the server.
                // TableCore-styled native confirmation dialog (NOT a system
                // MessageBox) — same cream palette + DPI-safe layout as
                // SetupForm. The setup wizard has exactly one human
                // confirmation point per route; this is it. The dialog
                // accepts Enter (YES = default) and Escape (NO).
                using (var dlg = new WizardConfirmationForm(
                    $"Test štampe za {readiness.Type}",
                    $"Test tiket je upravo poslat na štampač.\n\n" +
                    $"Štampač: {readiness.PrinterName}\n" +
                    $"Širina papira: {readiness.PaperWidthMm} mm\n\n" +
                    $"Da li je test tiket fizički izašao iz štampača i da li je čitljiv?"
                ))
                {
                    var ask = dlg.ShowDialog(this);
                    if (ask != DialogResult.Yes)
                    {
                        _saveFeedbackLabel.Text =
                            $"Ruta {readiness.Type} NIJE fizički potvrđena. " +
                            "Proverite štampač, pa kliknite dugme ponovo.";
                        _saveFeedbackLabel.ForeColor = Color.FromArgb(0xC0, 0x6A, 0x00);
                        _saveButton.Enabled = true;
                        _saveButton.Text = previousSaveText;
                        return;
                    }
                }

                var confirmed = await DeliveryClient.ConfirmPhysicalTest(_endpoint.BaseUrl, credential, readiness.Type);
                if (!confirmed)
                {
                    _saveFeedbackLabel.Text = $"Nije moguće zabeležiti fizičku potvrdu za {readiness.Type}. Pokušajte ponovo.";
                    _saveFeedbackLabel.ForeColor = Color.Firebrick;
                    _saveButton.Enabled = true;
                    _saveButton.Text = previousSaveText;
                    return;
                }
            }

            // ── STEP 4: READY ─────────────────────────────────────────────
            _saveButton.Text = "✓ SPREMAN";
            _saveFeedbackLabel.Text =
                $"✓ Sve rute štampe su fizički proverene i potvrđene.\n" +
                $"TableCore Print Agent je spreman za rad.";
            _saveFeedbackLabel.ForeColor = Color.FromArgb(0x1E, 0x7A, 0x3C);
            RefreshStatus(paired: true);
            await Task.Delay(1500);
            Close();
        }
        catch (Exception ex)
        {
            _saveFeedbackLabel.Text = $"Podešavanje nije moglo da se završi: {ex.Message}";
            _saveFeedbackLabel.ForeColor = Color.Firebrick;
            _saveButton.Enabled = true;
            _saveButton.Text = previousSaveText;
        }
    }

    /// <summary>
    /// Printing V2 — purely local, ad hoc diagnostic: print one test ticket
    /// to any Windows printer this machine can see, RIGHT NOW, regardless of
    /// pairing/route state. Never persisted, never touches
    /// agent.config.json/the server's routes — exactly the "local diagnostic
    /// or initial convenience" the spec calls for, decoupled from the
    /// machine's real (server-configured) routing.
    /// </summary>
    private void OnTestPrint()
    {
        if (_testRouteTypeBox.SelectedItem is not string type || _printerBox.SelectedItem is not string printer || _paperWidthBox.SelectedItem is not string widthText || !int.TryParse(widthText, out var width))
        {
            MessageBox.Show(this, "Izaberite vrstu, štampač i širinu papira pre probne štampe.", "TableCore", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        var route = new PrintRoute(type, printer, width);
        var workstationName = Environment.MachineName;
        var ticket = Ticket.TestPrint(workstationName, type, printer, width, AgentVersion.Current);
        var outcome = WindowsPrinter.Print(route, ticket, "test-" + Guid.NewGuid().ToString("N"));
        var icon = outcome.Status == "SUBMITTED_TO_SPOOLER" ? MessageBoxIcon.Information : MessageBoxIcon.Error;
        MessageBox.Show(this, $"{outcome.Status}: {outcome.Guarantee}" + (outcome.Error is null ? "" : $"\n\n{outcome.Error}"), "TableCore — Test Print", MessageBoxButtons.OK, icon);
    }

    /// <summary>
    /// Physical QA follow-up (installed-product-vs-running-agent mismatch
    /// investigation) — "the user currently cannot open the Setup UI" is
    /// indistinguishable, from a WinExe GUI app with no console, from "an
    /// unhandled exception killed the process before/during Application.Run
    /// with nothing visible". Both Application.ThreadException (UI-thread
    /// exceptions after the message loop starts) and
    /// AppDomain.UnhandledException (anything else, including during form
    /// construction) are now wired to a visible MessageBox instead of a
    /// silent crash — this doesn't change what CAN fail, only guarantees
    /// that if it does, the restaurant user (and support) sees why instead
    /// of nothing happening on double-click.
    /// </summary>
    public static void RunInteractive(string[] args, string? prefillPairingCode = null)
    {
        // Ručna inicijalizacija umesto generisanog ApplicationConfiguration.Initialize()
        // — ovaj projekat koristi Microsoft.NET.Sdk.Web (UseWindowsForms dodat ručno
        // radi PrintDocument/DPAPI Windows API-ja), ne standardni WinForms SDK
        // template koji taj generator podrazumevano uključuje.
        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.ThreadException += (_, e) => ShowFatalError(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => ShowFatalError(e.ExceptionObject as Exception ?? new Exception("Nepoznata greška."));
        try
        {
            Application.Run(new SetupForm(args, prefillPairingCode));
        }
        catch (Exception ex)
        {
            ShowFatalError(ex);
        }
    }

    private static void ShowFatalError(Exception ex)
    {
        AgentLog.Warn($"Setup UI fatal error: {ex.GetType().Name}: {ex.Message}");
        MessageBox.Show(
            $"TableCore Print Agent — podešavanje nije moglo da se otvori zbog neočekivane greške:\n\n{ex.Message}\n\n" +
            "Pokušajte ponovo. Ako se greška ponavlja, kontaktirajte podršku.",
            "TableCore Print Agent — greška",
            MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    /// <summary>
    /// PRINTING V2 FINAL — LOGIN_AWARE terminal binding result. A brief,
    /// modal-but-standalone dialog (no SetupForm instance behind it, no
    /// Application.Run message loop needed beyond this single call) — the
    /// bind action never opens the full interactive Setup screen, and
    /// nothing else on this process needs a window.
    /// </summary>
    public static void ShowStandaloneMessage(string message, bool isError)
    {
        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        MessageBox.Show(message, "TableCore Print Agent",
            MessageBoxButtons.OK, isError ? MessageBoxIcon.Error : MessageBoxIcon.Information);
    }

    /// <summary>Restaurant-facing Serbian label for a PrintJobType, used
    /// only by the terminal-bind result dialog above (mirrors ROUTE_LABEL's
    /// wording already established in the Admin panel — Kuhinja/Šank/Račun).</summary>
    public static string PrintRoleLabel(string? printRole) => printRole switch
    {
        "KITCHEN" => "KUHINJA",
        "BAR" => "ŠANK",
        "RECEIPT" => "RAČUN",
        _ => printRole ?? "?",
    };
}
