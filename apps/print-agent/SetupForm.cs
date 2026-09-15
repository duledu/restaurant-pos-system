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
    private readonly ComboBox _stationBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    private readonly ComboBox _printerBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    private readonly ComboBox _paperWidthBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    private readonly Label _autoPrintLabel = new() { AutoSize = true, Text = "Automatska štampa: (nepoznato)" };
    // AutoSize + Padding umesto podrazumevane FIKSNE WinForms veličine
    // dugmeta (75x23 px na 96 DPI) — taj fiksni raster ne ostavlja dovoljno
    // vertikalnog prostora za tekst na 125%/150% Windows skaliranju (upravo
    // prijavljen bug: "Test"/"Sačuvaj" tekst vertikalno isečen). AutoSize
    // meri STVARNU visinu teksta pri TRENUTNOM DPI/font skaliranju i uvek
    // ostavlja Padding oko nje — ispravno na 100/125/150% bez potrebe da se
    // cela forma uveličava.
    private readonly Button _testPrintButton = new() { Text = "Test štampa", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(10, 6, 10, 6) };
    private readonly Button _saveButton = new() { Text = "Sačuvaj podešavanja", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(10, 6, 10, 6) };
    private readonly Label _versionLabel = new() { AutoSize = true, Text = $"TableCore Print Agent v{AgentVersion.Current}" };
    private readonly Label _endpointLabel = new() { AutoSize = true };

    private readonly AgentEndpoint _endpoint = null!;
    private readonly string? _endpointError;

    public SetupForm() : this([]) { }

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
    /// </summary>
    public SetupForm(string[] args)
    {
        try
        {
            _endpoint = AgentEndpoint.Resolve(args);
            PairingClient.ConfigureBypassHeader(_endpoint);
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

        layout.Controls.Add(new Label { Text = "Stanica:", AutoSize = true, Margin = new Padding(0, 16, 0, 2) });
        layout.Controls.Add(_stationBox);
        layout.Controls.Add(new Label { Text = "Štampač:", AutoSize = true, Margin = new Padding(0, 8, 0, 2) });
        layout.Controls.Add(_printerBox);
        layout.Controls.Add(new Label { Text = "Širina papira:", AutoSize = true, Margin = new Padding(0, 8, 0, 2) });
        layout.Controls.Add(_paperWidthBox);
        _autoPrintLabel.Margin = new Padding(0, 12, 0, 0);
        layout.Controls.Add(_autoPrintLabel);

        var actionRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 16, 0, 0) };
        actionRow.Controls.Add(_testPrintButton);
        actionRow.Controls.Add(_saveButton);
        layout.Controls.Add(actionRow);

        _versionLabel.Margin = new Padding(0, 24, 0, 0);
        layout.Controls.Add(_versionLabel);
        _endpointLabel.Margin = new Padding(0, 2, 0, 0);
        _endpointLabel.ForeColor = _endpointError is null ? SystemColors.GrayText : Color.Firebrick;
        _endpointLabel.Text = _endpointError is null
            ? $"Server: {_endpoint.DescribeForLog()}"
            : $"Nevalidno podešavanje servera: {_endpointError}";
        layout.Controls.Add(_endpointLabel);

        Controls.Add(layout);

        _stationBox.Items.AddRange(["KITCHEN", "BAR"]);
        _paperWidthBox.Items.AddRange(["58", "80"]);
        _printerBox.Items.AddRange(WindowsPrinter.Enumerate());

        _pairButton.Click += async (_, _) => await OnPair();
        _saveButton.Click += (_, _) => OnSave();
        _testPrintButton.Click += (_, _) => OnTestPrint();

        Load += (_, _) => Initialize();
    }

    private string? _connectedName;
    private string? _connectedStation;

    private void Initialize()
    {
        AgentPaths.EnsureProgramDataDirectory();
        var paired = CredentialStore.HasStoredCredential();
        LoadExistingConfigIfPresent();
        RefreshStatus(paired);
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

    private void LoadExistingConfigIfPresent()
    {
        if (!File.Exists(AgentPaths.ConfigFilePath)) return;
        try
        {
            var config = AgentConfig.Parse(File.ReadAllText(AgentPaths.ConfigFilePath));
            _stationBox.SelectedItem = config.Station;
            _paperWidthBox.SelectedItem = config.PaperWidthMm.ToString();
            if (_printerBox.Items.Contains(config.PrinterName)) _printerBox.SelectedItem = config.PrinterName;
        }
        catch
        {
            // Nepotpuna/oštećena konfiguracija — korisnik je jednostavno
            // popunjava iznova ispod, ne blokiramo Setup ekran zbog toga.
        }
    }

    private void RefreshStatus(bool paired)
    {
        if (paired)
        {
            var label = _connectedName is null ? "Povezano sa TableCore." : $"Povezano sa TableCore: {_connectedName}" + (_connectedStation is null ? "" : $" ({_connectedStation})");
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
            _connectedStation = result.Station;
            if (result.Station is "KITCHEN" or "BAR") _stationBox.SelectedItem = result.Station;
            _pairingCodeBox.Clear();
            RefreshStatus(paired: true);
            var who = _connectedName is null ? "" : $" — {_connectedName}" + (_connectedStation is null ? "" : $" ({_connectedStation})");
            ShowPairFeedback($"✓ Upareno{who}. Izaberite štampač i sačuvajte podešavanja ispod.", isError: false);
        }
        finally
        {
            SetPairButtonEnabled(true);
            _pairingCodeBox.Enabled = !CredentialStore.HasStoredCredential();
        }
    }

    private void OnSave()
    {
        if (_stationBox.SelectedItem is not string station || _printerBox.SelectedItem is not string printer || _paperWidthBox.SelectedItem is not string widthText || !int.TryParse(widthText, out var width))
        {
            MessageBox.Show(this, "Izaberite stanicu, štampač i širinu papira pre čuvanja.", "TableCore", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        var json = JsonSerializer.Serialize(new { station, printerName = printer, paperWidthMm = width },
            new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true });
        AgentPaths.EnsureProgramDataDirectory();
        var tempPath = AgentPaths.ConfigFilePath + ".tmp";
        File.WriteAllText(tempPath, json);
        File.Move(tempPath, AgentPaths.ConfigFilePath, overwrite: true);
        MessageBox.Show(this, "Sačuvano. Servis će koristiti nova podešavanja u sledećem poll ciklusu (ili posle ponovnog pokretanja).", "TableCore", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private void OnTestPrint()
    {
        if (_stationBox.SelectedItem is not string station || _printerBox.SelectedItem is not string printer || _paperWidthBox.SelectedItem is not string widthText || !int.TryParse(widthText, out var width))
        {
            MessageBox.Show(this, "Izaberite stanicu, štampač i širinu papira pre testne štampe.", "TableCore", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        var config = new AgentConfig(station, printer, width);
        var workstationName = Environment.MachineName;
        var ticket = Ticket.TestPrint(workstationName, station, printer, width, AgentVersion.Current);
        var outcome = WindowsPrinter.Print(config, ticket, "test-" + Guid.NewGuid().ToString("N"));
        var icon = outcome.Status == "SUBMITTED_TO_SPOOLER" ? MessageBoxIcon.Information : MessageBoxIcon.Error;
        MessageBox.Show(this, $"{outcome.Status}: {outcome.Guarantee}" + (outcome.Error is null ? "" : $"\n\n{outcome.Error}"), "TableCore — Test Print", MessageBoxButtons.OK, icon);
    }

    public static void RunInteractive(string[] args)
    {
        // Ručna inicijalizacija umesto generisanog ApplicationConfiguration.Initialize()
        // — ovaj projekat koristi Microsoft.NET.Sdk.Web (UseWindowsForms dodat ručno
        // radi PrintDocument/DPAPI Windows API-ja), ne standardni WinForms SDK
        // template koji taj generator podrazumevano uključuje.
        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(args));
    }
}
