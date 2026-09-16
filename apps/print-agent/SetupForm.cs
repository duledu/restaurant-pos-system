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
    private readonly Label _pairFeedbackLabel = new() { AutoSize = false, Size = new Size(420, 32), TextAlign = ContentAlignment.TopLeft };
    // Printing V2 — rute štampe (Kuhinja/Šank/Račun -> štampač) se BIRAJU u
    // Admin panelu POSLE uparivanja, nikad ovde — ovi kontroli su SADA čisto
    // lokalna dijagnostika ("probaj bilo koji instaliran štampač odmah"),
    // potpuno odvojeni od stvarnog rutiranja. Vidi OnTestPrint/OnSave ispod.
    private readonly ComboBox _testRouteTypeBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    private readonly ComboBox _printerBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    private readonly ComboBox _paperWidthBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    private readonly Label _autoPrintLabel = new() { AutoSize = true, Text = "Rute štampe: podešavaju se u Admin panelu (Podešavanja → Štampači) posle uparivanja." };
    // AutoSize + Padding umesto podrazumevane FIKSNE WinForms veličine
    // dugmeta (75x23 px na 96 DPI) — taj fiksni raster ne ostavlja dovoljno
    // vertikalnog prostora za tekst na 125%/150% Windows skaliranju (upravo
    // prijavljen bug: "Test"/"Sačuvaj" tekst vertikalno isečen). AutoSize
    // meri STVARNU visinu teksta pri TRENUTNOM DPI/font skaliranju i uvek
    // ostavlja Padding oko nje — ispravno na 100/125/150% bez potrebe da se
    // cela forma uveličava.
    private readonly Button _testPrintButton = new() { Text = "Test štampa", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(10, 6, 10, 6) };
    private readonly Button _saveButton = new() { Text = "Sačuvaj podešavanja", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(10, 6, 10, 6) };
    // PREPROD physical QA follow-up (Part A1) — isti "rezervisan prostor,
    // fiksna visina" obrazac kao _pairFeedbackLabel iznad (namerno
    // ODVOJENO od njega: ovo je povratna informacija za Sačuvaj, ne za
    // Poveži, i pojavljuje se tek posle Testa štampe/dugmadi ispod, ne pre
    // njih — mešanje ta dva bi zbunilo korisnika o TOME koja radnja je
    // upravo uspela/pala).
    private readonly Label _saveFeedbackLabel = new() { AutoSize = false, Size = new Size(420, 40), TextAlign = ContentAlignment.TopLeft };
    private readonly Label _versionLabel = new() { AutoSize = true, Text = $"TableCore Print Agent v{AgentVersion.Current}" };
    private readonly Label _endpointLabel = new() { AutoSize = true };

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
        MinimumSize = new Size(480, 0);

        _pairButton.FlatAppearance.BorderSize = 0;
        _pairButton.FlatAppearance.MouseOverBackColor = BrandGraphiteHover;
        _pairButton.FlatAppearance.MouseDownBackColor = BrandGraphiteHover;

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
        layout.Controls.Add(_statusLabel);
        layout.Controls.Add(new Label { Text = "Kod za uparivanje:", AutoSize = true, Margin = new Padding(0, 16, 0, 2) });
        var pairRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
        _pairingCodeBox.Margin = new Padding(0, 6, 0, 0);
        pairRow.Controls.Add(_pairingCodeBox);
        pairRow.Controls.Add(_pairButton);
        layout.Controls.Add(pairRow);
        _pairFeedbackLabel.Margin = new Padding(0, 4, 0, 0);
        layout.Controls.Add(_pairFeedbackLabel);

        layout.Controls.Add(new Label { Text = "Probna štampa — vrsta (oznaka na tiketu):", AutoSize = true, Margin = new Padding(0, 16, 0, 2) });
        layout.Controls.Add(_testRouteTypeBox);
        layout.Controls.Add(new Label { Text = "Probna štampa — štampač:", AutoSize = true, Margin = new Padding(0, 8, 0, 2) });
        layout.Controls.Add(_printerBox);
        layout.Controls.Add(new Label { Text = "Probna štampa — širina papira:", AutoSize = true, Margin = new Padding(0, 8, 0, 2) });
        layout.Controls.Add(_paperWidthBox);
        _autoPrintLabel.Margin = new Padding(0, 12, 0, 0);
        layout.Controls.Add(_autoPrintLabel);

        var actionRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 16, 0, 0) };
        actionRow.Controls.Add(_testPrintButton);
        actionRow.Controls.Add(_saveButton);
        layout.Controls.Add(actionRow);
        _saveFeedbackLabel.Margin = new Padding(0, 4, 0, 0);
        layout.Controls.Add(_saveFeedbackLabel);

        _versionLabel.Margin = new Padding(0, 24, 0, 0);
        layout.Controls.Add(_versionLabel);
        _endpointLabel.Margin = new Padding(0, 2, 0, 0);
        _endpointLabel.ForeColor = _endpointError is null ? SystemColors.GrayText : Color.Firebrick;
        _endpointLabel.Text = _endpointError is null
            ? $"Server: {_endpoint.DescribeForLog()}"
            : $"Nevalidno podešavanje servera: {_endpointError}";
        layout.Controls.Add(_endpointLabel);

        Controls.Add(layout);

        _testRouteTypeBox.Items.AddRange(["KITCHEN", "BAR", "RECEIPT"]);
        _testRouteTypeBox.SelectedIndex = 0;
        _paperWidthBox.Items.AddRange(["58", "80"]);
        _printerBox.Items.AddRange(WindowsPrinter.Enumerate());

        _pairButton.Click += async (_, _) => await OnPair();
        _saveButton.Click += async (_, _) => await OnSave();
        _testPrintButton.Click += (_, _) => OnTestPrint();

        Load += (_, _) => Initialize();
    }

    private string? _connectedName;
    private int _configuredRouteCount;

    private void Initialize()
    {
        AgentPaths.EnsureProgramDataDirectory();
        var paired = CredentialStore.HasStoredCredential();
        LoadExistingConfigIfPresent();
        RefreshStatus(paired);
        // Printing V2 — pre-fill from a tablecore-print:// URI activation,
        // but ONLY when not already paired. An already-paired machine keeps
        // its pairing box disabled (see RefreshStatus) regardless of this —
        // opening the Agent from Admin must never risk touching an existing
        // pairing, so we don't even populate a stray code into that state.
        if (!paired && !string.IsNullOrWhiteSpace(_prefillPairingCode))
        {
            _pairingCodeBox.Text = _prefillPairingCode.Trim();
            ShowPairFeedback("Kod je automatski popunjen sa Admin panela — proveri i klikni „Poveži“.", isError: false);
        }
        if (_endpointError is not null)
        {
            SetPairButtonEnabled(false);
            _pairingCodeBox.Enabled = false;
            ShowPairFeedback($"Server nije ispravno podešen, uparivanje je onemogućeno: {_endpointError}", isError: true);
        }
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
            var first = config.Routes.FirstOrDefault();
            if (first is null) return;
            _testRouteTypeBox.SelectedItem = first.Type;
            _paperWidthBox.SelectedItem = first.PaperWidthMm.ToString();
            if (_printerBox.Items.Contains(first.PrinterName)) _printerBox.SelectedItem = first.PrinterName;
        }
        catch
        {
            // Nepotpuna/oštećena konfiguracija — korisnik i dalje može
            // upariti/testirati ispod, ne blokiramo Setup ekran zbog toga.
        }
    }

    private void RefreshStatus(bool paired)
    {
        if (paired)
        {
            var routesText = _configuredRouteCount > 0
                ? $"{_configuredRouteCount} {(_configuredRouteCount == 1 ? "ruta štampe podešena" : "rute štampe podešene")}."
                : "Rute štampe još nisu podešene — podesi ih u Admin panelu (Podešavanja → Štampači).";
            var label = (_connectedName is null ? "Povezano sa TableCore." : $"Povezano sa TableCore: {_connectedName}.") + " " + routesText;
            _statusLabel.Text = label;
            _pairingCodeBox.Enabled = false;
            _pairButton.Text = "Ponovo upari (novi kod)";
        }
        else
        {
            _statusLabel.Text = "Nije upareno. Unesite kod za uparivanje iz Admin panela (Podešavanja → Štampači).";
            _pairingCodeBox.Enabled = true;
            _pairButton.Text = "Poveži";
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
            RefreshStatus(paired: true);
            var who = _connectedName is null ? "" : $" — {_connectedName}";
            ShowPairFeedback($"✓ Upareno{who}. Klikni dugme ispod da preuzmeš rute štampe sa servera.", isError: false);
        }
        finally
        {
            SetPairButtonEnabled(true);
            _pairingCodeBox.Enabled = !CredentialStore.HasStoredCredential();
        }
    }

    /// <summary>
    /// Printing V2 — routes are server-authoritative and no longer chosen in
    /// Setup at all (see WorkstationsPanel.tsx "Rute štampe"). This button's
    /// job shrinks to: confirm pairing actually works end-to-end by doing a
    /// REAL heartbeat (reporting this machine's full printer list) and
    /// pulling down whatever routes the server currently has for this
    /// workstation, persisting them locally exactly like the running
    /// service would (AgentRunner.ApplyServerRoutes) — so Setup can show a
    /// real, proven "N rute učitane" confirmation instead of just "file
    /// written to disk". Zero routes configured yet is NOT an error (Admin
    /// may not have set any up); Setup still closes, and the background
    /// service will pick up routes automatically the moment Admin adds one
    /// — see PREPROD physical QA follow-up (Part A1) note below for why
    /// this only closes on a CONFIRMED server round-trip, never a bare local
    /// write.
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
        _saveButton.Text = "Povezivanje…";
        _saveFeedbackLabel.Text = "Preuzimanje ruta štampe sa servera…";
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
                // PREPROD physical QA follow-up (Part A1) — "Do NOT close on
                // failure": server nije potvrdio povezivanje, prozor ostaje
                // otvoren. Professional error UX audit — poruka ostaje
                // kategorična bez nagađanja uzroka (stvaran slučaj koji je
                // ovo otkrio bio je nedostajuće propusno zaglavlje, ne mreža).
                _saveFeedbackLabel.Text = "Server trenutno nije potvrdio povezivanje. Pokušajte ponovo za par trenutaka pre zatvaranja.";
                _saveFeedbackLabel.ForeColor = Color.Firebrick;
                _saveButton.Enabled = true;
                _saveButton.Text = previousSaveText;
                return;
            }

            if (outcome.Routes.Count > 0)
            {
                var config = new AgentConfig([.. outcome.Routes.Select(r => new PrintRoute(r.Type, r.PrinterName, r.PaperWidthMm))]);
                var tempPath = AgentPaths.ConfigFilePath + ".tmp";
                File.WriteAllText(tempPath, config.ToJson());
                File.Move(tempPath, AgentPaths.ConfigFilePath, overwrite: true);
                _configuredRouteCount = outcome.Routes.Count;
                _saveFeedbackLabel.Text = $"✓ Povezano — {outcome.Routes.Count} {(outcome.Routes.Count == 1 ? "ruta štampe učitana" : "rute štampe učitane")}.";
            }
            else
            {
                _configuredRouteCount = 0;
                _saveFeedbackLabel.Text = "✓ Povezano. Rute štampe još nisu podešene — podesi ih u Admin panelu, servis će ih automatski preuzeti.";
            }
            _saveFeedbackLabel.ForeColor = Color.FromArgb(0x1E, 0x7A, 0x3C);
            RefreshStatus(paired: true);
            // Kratka, čitljiva potvrda pre automatskog zatvaranja — ne
            // trenutni nestanak prozora (korisnik mora videti da je uspelo).
            // NAMERNO ne re-enable-ovati dugme ovde niti u finally ispod —
            // prozor se zatvara, dodirivanje kontrola posle Close() je
            // nepotrebno i izbegava se u potpunosti.
            await Task.Delay(1200);
            Close();
        }
        catch (Exception ex)
        {
            _saveFeedbackLabel.Text = $"Povezivanje nije uspelo: {ex.Message}";
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
}
