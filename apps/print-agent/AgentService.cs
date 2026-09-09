using Microsoft.Extensions.Hosting;

namespace TableCore.PrintAgent;

/// <summary>
/// Faza 2C — hostuje AgentRunner.Run kao Windows servis. Program.cs bira
/// OVAJ put SAMO kada WindowsServiceHelpers.IsWindowsService() vrati true
/// (proces je pokrenut od strane Service Control Managera; provereno preko
/// roditeljskog procesa "services.exe" — pouzdanije od proveravanja
/// argumenata). Van servisnog konteksta (dev `dotnet run --run`, ili
/// direktno dvoklik EXE-a) i dalje se koristi isti AgentRunner.Run kroz
/// stari CLI put — ovaj wrapper NE duplira logiku petlje, samo je
/// integriše sa SCM start/stop/recovery ugovorom (OnStarted/OnStopping
/// preko BackgroundService, exit kod -> Windows servisni recovery akcije
/// konfigurisane u installer-u, vidi izveštaj Faze 2C sekcija G).
/// </summary>
public sealed class AgentService : BackgroundService
{
    /// <summary>
    /// Faza 2C, sekcije 9/10 — konačna odluka o identitetu servisa, EMPIRIJSKI
    /// dokazana na stvarnoj Windows 10 radnoj stanici (ne pretpostavka):
    ///
    /// Ovaj Windows servis MORA se instalirati sa obj= "NT SERVICE\TableCorePrintAgent"
    /// (moderni "per-service virtual account", NE ugrađen NetworkService/LocalService
    /// nalog). Testirano direktno preko sc.exe create/start:
    ///   - LocalMachine ima politiku "Log on as a service" (SeServiceLogonRight)
    ///     koja EKSPLICITNO NE uključuje NT AUTHORITY\NetworkService niti
    ///     NT AUTHORITY\LocalService (samo *S-1-5-80-0 — grupa koja pokriva
    ///     PER-SERVICE virtuelne naloge) — potvrđeno preko `secedit /export
    ///     /areas USER_RIGHTS` i Windows Event Log-a (Service Control Manager:
    ///     "failed to start ... Access is denied" za oba ugrađena naloga).
    ///   - Per-service virtuelni nalog (NT SERVICE\&lt;ime servisa&gt;) JESTE
    ///     pokriven tom politikom i radi.
    ///   - ODVOJENO od gornjeg: binarni fajl MORA biti u sistemskoj lokaciji
    ///     (Program Files) — pokretanje ISTOG exe-a iz korisničkog profila
    ///     (C:\Users\...) vraćalo je "Access is denied" ČAK I za virtuelni
    ///     nalog, dok je LocalSystem (koji ima implicitan pristup skoro svemu)
    ///     radio iz oba mesta. Instaler (installer/) MORA instalirati u
    ///     Program Files, ne u korisnički direktorijum.
    ///   - Enumeracija štampača (WindowsPrinter.Enumerate(), preko agent.log)
    ///     dala je IDENTIČNIH 14 štampača — uključujući stvaran "POS-58 (1)" —
    ///     pod LocalSystem, NetworkService I per-service virtuelnim nalogom,
    ///     kad je binarni fajl u Program Files: lokalni USB štampač je
    ///     vidljiv nezavisno od identiteta poziva jednom kad servis uopšte
    ///     uspe da se pokrene. Vidljivost štampača NIJE bila stvarno
    ///     ograničavajući faktor — pristup binarnom fajlu I "Log on as a
    ///     service" politika JESU bili.
    ///
    /// Per-service virtuelni nalog je STROŽE ograničen od NetworkService (SID
    /// jedinstven za OVU uslugu, ne deljen sa bilo kojom drugom NetworkService
    /// uslugom na mašini) — najmanje-privilegovan izbor koji stvarno radi na
    /// ovoj klasi Windows konfiguracije, ne LocalSystem "jer je najlakše".
    /// </summary>
    public const string ServiceName = "TableCorePrintAgent";

    /// <summary>obj= vrednost koju installer prosleđuje sc.exe/CreateService
    /// pri instalaciji — MORA se poklapati sa ServiceName iznad (ime servisa
    /// je deo same SID formule za ovaj tip naloga).</summary>
    public const string ServiceAccount = @"NT SERVICE\TableCorePrintAgent";

    private readonly string[] _args;

    public AgentService(string[] args)
    {
        _args = args;
    }

    private static readonly TimeSpan UnpairedRetryDelay = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        AgentPaths.EnsureProgramDataDirectory();
        AgentLog.Info($"Servis pokrenut. Verzija={AgentVersion.Current}, OS={Environment.OSVersion.VersionString}, Nalog={Environment.UserName}.");
        LogPrinterEnumeration();

        // Faza 2C — bezbedno rešavanje servera (vidi AgentEndpoint.cs za pun
        // razlog: stvaran incident gde je neuspešna `sc config` izmena binPath-a
        // tiho ostavila instaliran servis da koristi podrazumevanu produkciju).
        // Instaliran servis (installer/) NE dodaje --mode/--server u binPath,
        // pa je OVDE podrazumevano ponašanje uvek Production/tablecore.net —
        // TAČNO ono što treba za stvarnu restoransku instalaciju. Ako NEKO
        // (razvoj/prihvatno testiranje preko sc config) doda nevalidnu/
        // nepotpunu kombinaciju, GRESKA SE NE GUTA — servis se gasi umesto da
        // tiho nastavi ka produkciji, i SCM recovery politika (installer/,
        // ograničen broj pokušaja) preuzima, dajući administratoru vidljiv,
        // ponavljan neuspeh umesto tihog pogrešnog ponašanja.
        AgentEndpoint endpoint;
        try
        {
            endpoint = AgentEndpoint.Resolve(_args);
        }
        catch (AgentEndpointConfigurationException ex)
        {
            AgentLog.Error($"Nevalidno podesavanje servera, servis se gasi (NEMA tihog pada na produkciju): {ex.Message}");
            throw;
        }
        AgentLog.Info($"Aktivan server: {endpoint.DescribeForLog()}");

        var baseUrl = endpoint.BaseUrl;
        var configPath = AgentPaths.ConfigFilePath;
        if (!File.Exists(configPath))
        {
            // Dev-only fallback — ISKLJUČIVO kada se pokreće iz izvornog
            // checkout-a preko `dotnet run` sa lokalnim agent.local.json u
            // CWD (vidi AgentPaths.cs); u instaliranoj produkciji ConfigFilePath
            // uvek postoji jer ga Setup ekran piše pri uparivanju/podešavanju.
            var devFallback = Path.GetFullPath("agent.local.json");
            if (File.Exists(devFallback)) configPath = devFallback;
        }

        // Faza 2C, sekcija 13 — SVAKA sveža instalacija pokreće servis PRE
        // uparivanja (Setup ekran se otvara odvojeno, korisnik možda ne
        // upari odmah). Ovo NIJE greška — NE sme izazvati crash-restart
        // petlju kroz SCM recovery (zabranjeno: "do not create infinite
        // tight restart loops"). Umesto toga, servis ČEKA uparivanje ovde,
        // u istom, već pokrenutom procesu, i tiho nastavlja čim
        // CredentialStore.HasStoredCredential() postane true.
        var loggedWaitingForPairing = false;
        while (!stoppingToken.IsCancellationRequested && !CredentialStore.HasStoredCredential())
        {
            if (!loggedWaitingForPairing)
            {
                AgentLog.Info("Nije upareno — čekam uparivanje preko Setup ekrana. Servis ostaje pokrenut, ne pokušava ponovo u petlji.");
                loggedWaitingForPairing = true;
            }
            try { await Task.Delay(UnpairedRetryDelay, stoppingToken); } catch (OperationCanceledException) { return; }
        }
        if (stoppingToken.IsCancellationRequested) return;

        try
        {
            // stoppingToken se direktno prosleđuje AgentRunner.Run (linked sa
            // njegovim internim cts) — SCM stop STVARNO prekida petlju, ne
            // samo napušta ovaj Task (vidi ispravku u AgentRunner.cs: pre ove
            // izmene spoljašnji stop nije imao nikakav put do unutrašnje
            // petlje pod servisom, jer je ona reagovala samo na konzolni
            // Ctrl+C koji servis nikad ne prima).
            await AgentRunner.Run(baseUrl, configPath, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            AgentLog.Info("Servis zaustavljen (SCM stop).");
        }
        catch (Exception ex)
        {
            // Neočekivana greška van AgentRunner.Run sopstvenog try/catch po
            // koraku (npr. nečitljiv kredencijal/oštećen fajl) — logujemo i
            // pustimo proces da se završi; Windows servisni recovery
            // (konfigurisan u installer-u, ograničen broj pokušaja sa
            // razmakom) preuzima ponovno pokretanje, umesto tihe petlje ovde.
            AgentLog.Error($"Neočekivana greška, servis se gasi (SCM recovery će pokušati restart): {ex.Message}");
            throw;
        }
    }

    /// <summary>
    /// Faza 2C, sekcija 10 — DOKAZ, ne pretpostavka, da izabran servisni
    /// identitet vidi lokalno instalirane štampače. Upisuje se u agent.log
    /// pri SVAKOM startu servisa (jeftino, korisno i za tekuću dijagnostiku
    /// "štampač nestao posle Windows update-a" van same akceptacije).
    /// </summary>
    private static void LogPrinterEnumeration()
    {
        try
        {
            var printers = WindowsPrinter.Enumerate();
            AgentLog.Info($"Enumerisano {printers.Length} štampač(a) pod nalogom \"{Environment.UserName}\": {string.Join(" | ", printers)}");
        }
        catch (Exception ex)
        {
            AgentLog.Error($"Enumeracija štampača nije uspela: {ex.Message}");
        }
    }
}
