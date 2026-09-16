using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using TableCore.PrintAgent;

// Faza 2C follow-up — OutputType je sada WinExe (GUI subsistem, vidi .csproj)
// da Windows NIKAD ne otvori crni CMD prozor iza WinForms Setup ekrana ili
// pri pokretanju servisa. Namerno BEZ AttachConsole(ATTACH_PARENT_PROCESS)
// ovde — eksperimentalno dokazano da ono aktivno KVARI Console.WriteLine
// kad je stdout već ispravno preusmeren/nasleđen (pipe/redirekcija, npr.
// `dotnet run -- --self-test > log.txt` ili kroz test/CI alat) — .NET
// Console.Out ostaje vezan za taj nasleđen handle i BEZ ijednog dodatnog
// poziva, potpuno nezavisno od WinExe/Exe subsistema; AttachConsole samo
// unosi rizik da ga pomeri na pogrešno mesto. Jedini scenario koji WinExe
// stvarno menja je dvoklik iz Explorer-a (nema roditeljske konzole ni
// pre ni posle) — upravo scenario koji ne sme imati crni prozor.

// Faza 2C — MORA biti prva provera. Kad Service Control Manager pokrene ovaj
// EXE (posle instalacije preko installer-a), IsWindowsService() vraća true
// PRE bilo kakvog parsiranja args-a ispod (SCM tipično prosleđuje 0 dodatnih
// argumenata, pa bi bez ove eksplicitne provere proces pao kroz sve --flag
// grane do stare Kestrel/agent.local.json putanje i odmah otkazao sa
// nedostajućim TABLECORE_AGENT_TOKEN environment promenljivom — upravo ono
// što instalacija bez PowerShell/env-var koraka mora da izbegne).
if (WindowsServiceHelpers.IsWindowsService())
{
    var serviceHost = Host.CreateDefaultBuilder(args)
        .UseWindowsService(options => { options.ServiceName = AgentService.ServiceName; })
        .ConfigureServices(services =>
        {
            services.AddHostedService(_ => new AgentService(args));
        })
        .ConfigureLogging(logging => { logging.ClearProviders(); })
        .Build();
    await serviceHost.RunAsync();
    return;
}

if (args.Contains("--self-test")) { SelfTests.Run(); return; }
if (args.Contains("--list-printers"))
{
    Console.WriteLine(JsonSerializer.Serialize(WindowsPrinter.Enumerate()));
    return;
}
// Faza 2A — minimalan autentifikovan transport skelet SAMO da dokaže
// identitet kraj-do-kraja (uparivanje -> DPAPI-zaštićen trajan kredencijal
// -> autentifikovan heartbeat). Namerno bez agent.local.json zahteva (kao
// --self-test/--list-printers iznad) — ovo je pre-config korak. NE dodaje
// PrintJob polling/dispatch (Faza 2B).
//
// Faza 2C — SVE tri grane ispod (--pair/--heartbeat/--run) prvo rešavaju
// server preko AgentEndpoint.Resolve, i AKO ta rezolucija baci
// AgentEndpointConfigurationException, ispisujemo grešku i ODMAH stajemo
// (exit 1) — NIKAD ne hvatamo tu grešku da bismo tiho nastavili sa
// produkcijom. Vidi AgentEndpoint.cs za pun razlog (stvaran incident).
if (args.Contains("--pair") || args.Contains("--heartbeat") || args.Contains("--run"))
{
    AgentEndpoint endpoint;
    try
    {
        endpoint = AgentEndpoint.Resolve(args);
    }
    catch (AgentEndpointConfigurationException ex)
    {
        Console.Error.WriteLine($"Podesavanje servera nije validno, zaustavljam se (bez tihog pada na produkciju): {ex.Message}");
        Environment.ExitCode = 1;
        return;
    }
    Console.WriteLine($"Aktivan server: {endpoint.DescribeForLog()}");
    AgentEndpoint.ConfigureAgentHttpClients(endpoint);

    if (args.Contains("--pair"))
    {
        var codeIndex = Array.IndexOf(args, "--pair");
        var code = codeIndex >= 0 && codeIndex + 1 < args.Length ? args[codeIndex + 1] : null;
        if (string.IsNullOrWhiteSpace(code))
        {
            Console.Error.WriteLine("Upotreba: --pair <KOD> [--mode test --server <baseUrl>]");
            Environment.ExitCode = 1;
            return;
        }
        await PairingClient.Pair(endpoint.BaseUrl, code);
        return;
    }
    if (args.Contains("--heartbeat"))
    {
        await PairingClient.Heartbeat(endpoint.BaseUrl);
        return;
    }
    // --run: Faza 2B — stvaran isporučni put: autentifikovan poll/claim/
    // start/rezultat preko AgentRunner.cs, umesto Kestrel HTTP servera ispod
    // (koji ostaje NEPROMENJEN, sad iza eksplicitnog --serve, za
    // --probe-printer/lokalno testiranje).
    //
    // Faza 2C — configPath MORA se poklapati sa AgentService.cs (isti
    // AgentPaths.ConfigFilePath u ProgramData, sa CWD agent.local.json SAMO
    // kao dev-only fallback) — inače --run (dokumentovan CLI put, i dalje
    // podržan van servisa, npr. za dijagnostiku na instaliranoj mašini) tiho
    // ne bi video konfiguraciju koju je Setup ekran sačuvao, i ponašao bi se
    // drugačije od stvarnog servisa nad ISTOM instalacijom.
    var runConfigPath = AgentPaths.ConfigFilePath;
    if (!File.Exists(runConfigPath))
    {
        var devFallback = Path.GetFullPath("agent.local.json");
        if (File.Exists(devFallback)) runConfigPath = devFallback;
    }
    await AgentRunner.Run(endpoint.BaseUrl, runConfigPath);
    return;
}

// Faza 2C — interaktivan Setup ekran. Instalacija (installer/) postavlja
// prečicu na Start meniju bez ikakvih argumenata — dvoklik restoranskog
// menadžera na "TableCore Print Agent Setup" mora da otvori uparivanje/
// podešavanje, NIKAD da padne na staru Kestrel/env-var granu ispod (ta
// grana je sada iza eksplicitnog --serve, dostupna samo razvojnim/internim
// pozivima, nikad ciljnom korisniku iz zahteva Faze 2C).
//
// --mode/--server/--bypass-header se PROPUŠTAJU u ovu granu (ne samo
// args.Length == 0) da bi prihvatno testiranje moglo interaktivno da
// upari/testira preko pravog UI-ja protiv test servera bez ijednog drugog
// prepoznatog --flag-a — svaka DRUGA nepoznata opcija i dalje pada u
// grešku ispod, ne ovde. --bypass-header MORA biti ovde na istoj listi kao
// --mode/--server (isti obrazac kao AgentEndpoint.Resolve, koji ga takođe
// tretira kao deo iste grupe endpoint argumenata) — inače PREPROD
// instaler/prečica koja prosleđuje "--mode test --server <url>
// --bypass-header <secret>" pada u granu "Nepoznata opcija" ispod i
// interaktivni Setup ekran se NIKAD ne otvara (stvaran regresivni bug,
// dokazan praznim izlazom exit code 1 bez ijednog prozora — PairingClient/
// AgentEndpoint.Resolve se u tom slučaju nikad ni ne pozivaju).
// Eksplicitna indeks-po-indeks provera (ne Array.IndexOf po vrednosti) da
// vrednost argumenta (npr. "--mode" kao string vrednost --server-a, teorijski)
// nikad ne bude pogrešno protumačena kao sam flag.
// Printing V2 — professional Admin -> Agent pairing handoff. Admin's
// "Otvori TableCore Print Agent" button navigates the browser to
// tablecore-print://pair?code=XXXX-XXXX-XXXX (registered by the installer,
// see [Registry] in TableCorePrintAgent.iss); Windows launches THIS exe
// with that URI as an argument. Recognized as interactive Setup args
// exactly like --mode/--server/--bypass-header above, and the code is
// extracted ONLY to pre-fill the pairing textbox — the user still clicks
// "Poveži" explicitly (never auto-submitted), and an already-paired
// machine never has its existing pairing touched by this (the code box
// stays disabled/unfilled once paired — see SetupForm.Initialize).
if (SetupArgumentDispatch.IsInteractiveSetupArgs(args))
{
    var prefillPairingCode = SetupArgumentDispatch.ExtractPairingCode(args);
    SetupForm.RunInteractive(args, prefillPairingCode);
    return;
}

if (!args.Contains("--serve") && !args.Contains("--probe-printer"))
{
    // SetupArgumentDispatch.Redact — ako je --bypass-header prisutan ali je
    // grana ipak pala ovde (npr. neka DRUGA nepoznata opcija je uz njega),
    // vrednost NIKAD ne sme završiti u ovoj poruci/logu.
    Console.Error.WriteLine($"Nepoznata opcija: {SetupArgumentDispatch.Redact(args)}. Dostupno: --self-test, --list-printers, --pair <KOD>, --heartbeat, --run, --probe-printer, --serve.");
    Environment.ExitCode = 1;
    return;
}

var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);
var configPath = Path.GetFullPath("agent.local.json");
var config = AgentConfig.Parse(File.ReadAllText(configPath));
// Faza 1 nasleđe/dev-only alat — namerno NIKAD multi-route svestan (samo
// --serve/--probe-printer, nikad produkcioni servis put); prva podešena
// ruta je "ta" štampač/širina za ovaj POC dijagnostički server.
var route = config.Routes.FirstOrDefault() ?? throw new ArgumentException("agent.local.json nema nijednu podešenu rutu (routes[]).");
if (args.Contains("--probe-printer"))
{
    var result = WindowsPrinter.Print(route, Ticket.Example(route.Type), "preflight", dryRun: true);
    Console.WriteLine(JsonSerializer.Serialize(result, jsonOptions));
    Environment.ExitCode = result.Status == "PREFLIGHT_ONLY" ? 0 : 1;
    return;
}
// Faza 1 nasleđe — samo eksplicitan --serve (interni/razvojni loopback HTTP
// listener), NIKAD podrazumevano ponašanje bez argumenata (vidi granu
// args.Length == 0 iznad — Faza 2C zahteva WinForms Setup tamo, ne ovo).
var token = Environment.GetEnvironmentVariable("TABLECORE_AGENT_TOKEN") ?? "";
if (token.Length < 32) throw new ArgumentException("Set TABLECORE_AGENT_TOKEN to a random token of at least 32 characters.");

// No appsettings/environment/CLI URL overrides. Kestrel listens on this explicit socket only.
var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [] });
builder.Configuration.Sources.Clear();
builder.WebHost.ConfigureKestrel(options => {
    options.Configure(new ConfigurationBuilder().Build());
    options.Listen(IPAddress.Loopback, 17831);
    options.Limits.MaxRequestBodySize = 32 * 1024;
    options.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10);
});
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(options => { options.SingleLine = true; options.TimestampFormat = "yyyy-MM-ddTHH:mm:ss "; });
var app = builder.Build();
var gate = new SemaphoreSlim(1, 1);
var records = new ConcurrentDictionary<string, JobRecord>();

app.Use(async (context, next) => {
    if (!RequestProtection.Allowed(context, token)) { context.Response.StatusCode = 403; return; }
    context.Response.Headers.CacheControl = "no-store";
    await next(context);
});
app.MapGet("/health", () => Results.Ok(new { status = "ready", station = route.Type, paperWidthMm = route.PaperWidthMm,
    printerName = route.PrinterName, mode = "SILENT", durable = false, spoolerChecked = false }));
app.MapGet("/printers", () => Results.Ok(new { printers = WindowsPrinter.Enumerate(), selectedPrinter = route.PrinterName }));
app.MapGet("/jobs/{id}", (string id) => Guid.TryParseExact(id, "D", out var key) && records.TryGetValue(key.ToString("D"), out var job) ? Results.Ok(job) : Results.NotFound());

async Task<IResult> Submit(HttpContext context, bool test)
{
    if (!context.Request.HasJsonContentType()) return Results.StatusCode(415);
    string id;
    Ticket? ticket;
    try
    {
        var request = await context.Request.ReadFromJsonAsync<PrintRequest>() ?? throw new ArgumentException("Missing request.");
        var headerId = context.Request.Headers["X-Request-Id"].ToString();
        if (!Guid.TryParseExact(request.JobId ?? headerId, "D", out var parsedId))
            return Results.BadRequest(new { error = "Provide jobId as a UUID (D format). X-Request-Id is also accepted." });
        if (headerId.Length > 0 && (!Guid.TryParseExact(headerId, "D", out var parsedHeader) || parsedHeader != parsedId))
            return Results.BadRequest(new { error = "jobId and X-Request-Id must agree." });
        id = parsedId.ToString("D");
        ticket = test ? Ticket.Example(route.Type) : new Ticket(request.Lines!);
        ticket.Validate();
    }
    catch (Exception ex) when (ex is JsonException or ArgumentException or BadHttpRequestException)
    { return Results.BadRequest(new { error = "Invalid ticket JSON or line limits." }); }
    // Test requests have a stable identity even when a repeat arrives in a later minute.
    var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        test ? "test-ticket-v2:" + route.Type : JsonSerializer.Serialize(ticket))));
    if (!await gate.WaitAsync(0)) return Results.StatusCode(429);
    try
    {
        if (records.TryGetValue(id, out var existing))
            return existing.Fingerprint == fingerprint ? Results.Ok(existing) : Results.Conflict(new { error = "Request ID reused with different content." });
        // Fail closed when full: never evict a duplicate-prevention record during this process lifetime.
        if (records.Count >= 1000) return Results.Problem("POC request ledger full. Reconcile output before restarting.", statusCode: 503);
        records[id] = new(id, fingerprint, new("ACCEPTED", "Validated in memory only; not submitted yet."));
        app.Logger.LogInformation("Request {RequestId} ACCEPTED for {Station}", id, route.Type);
        // Serial submission; client disconnect must not cancel or trigger another submission.
        var outcome = await Task.Run(() => WindowsPrinter.Print(route, ticket, id));
        var result = new JobRecord(id, fingerprint, outcome);
        records[id] = result;
        app.Logger.LogInformation("Request {RequestId} {Status}: {Error}", id, outcome.Status, outcome.Error);
        return Results.Json(result, statusCode: outcome.Status == "SUBMITTED_TO_SPOOLER" ? 200 : 502);
    }
    finally { gate.Release(); }
}
app.MapPost("/test-print", (Func<HttpContext, Task<IResult>>)(context => Submit(context, true)));
app.MapPost("/print", (Func<HttpContext, Task<IResult>>)(context => Submit(context, false)));
app.Logger.LogInformation("TableCore POC: {Station}, {Printer}, {Width} mm; loopback port 17831", route.Type, route.PrinterName, route.PaperWidthMm);
await app.RunAsync();

public sealed record PrintRequest(string? JobId, TicketLine[]? Lines);
public sealed record JobRecord(string JobId, string Fingerprint, PrintOutcome Outcome);

public static class RequestProtection
{
    public static bool Allowed(HttpContext context, string token)
    {
        // Reject all browser origins for this CLI-only POC. No CORS opt-in.
        if (context.Request.Headers.ContainsKey("Origin") || context.Request.Headers.ContainsKey("Sec-Fetch-Site")) return false;
        if (context.Request.Host.Host != "127.0.0.1" || context.Request.Host.Port != 17831) return false;
        if (context.Connection.RemoteIpAddress is null || !IPAddress.IsLoopback(context.Connection.RemoteIpAddress)) return false;
        var supplied = Encoding.UTF8.GetBytes(context.Request.Headers.Authorization.ToString());
        var expected = Encoding.UTF8.GetBytes("Bearer " + token);
        return CryptographicOperations.FixedTimeEquals(supplied, expected);
    }
}

/// <summary>
/// Izdvojeno iz top-level statements iznad ISKLJUČIVO radi self-testova
/// (SelfTests.cs) — ponašanje MORA ostati identično onome što je zamenilo.
/// Isti skup "endpoint argumenata" koji AgentEndpoint.Resolve prepoznaje
/// (--mode/--server/--bypass-header): SAMO ako args sadrži isključivo ove
/// flagove (i njihove vrednosti), interaktivni Setup ekran (SetupForm) se
/// otvara bez ijednog drugog --flag-a. Bilo koja DRUGA nepoznata opcija i
/// dalje mora pasti u granu ispod (fail closed) — ovo NE dodaje toleranciju
/// za proizvoljne flagove, samo proširuje POSTOJEĆU grupu na tačno jedan
/// novi, već-postojeći endpoint parametar.
/// </summary>
public static class SetupArgumentDispatch
{
    // Printing V2 — custom URI protocol registered by the installer
    // ([Registry] section) so Admin's "Otvori TableCore Print Agent" button
    // can hand off a freshly generated pairing code directly to the
    // installed Agent, same pattern as vscode:// / slack:// / zoom://.
    public const string PairingUriScheme = "tablecore-print://";

    private static bool IsEndpointFlag(string arg) => arg is "--mode" or "--server" or "--bypass-header";
    private static bool IsPairingUri(string arg) => arg.StartsWith(PairingUriScheme, StringComparison.OrdinalIgnoreCase);

    public static bool IsInteractiveSetupArgs(string[] args)
    {
        var onlyRecognized = true;
        for (var i = 0; i < args.Length && onlyRecognized; i++)
        {
            var isFlag = IsEndpointFlag(args[i]);
            var isValueOfPrecedingFlag = i > 0 && IsEndpointFlag(args[i - 1]);
            var isUri = IsPairingUri(args[i]);
            if (!isFlag && !isValueOfPrecedingFlag && !isUri) onlyRecognized = false;
        }
        return onlyRecognized;
    }

    /// <summary>
    /// Extracts the `code` query parameter from a
    /// tablecore-print://pair?code=XXXX-XXXX-XXXX argument, if present.
    /// Deliberately tolerant — a malformed/foreign/missing code returns
    /// null and Setup simply opens with an empty pairing box, exactly like
    /// a plain double-click. Manual string parsing (no System.Uri query
    /// parsing, no extra package) since a custom, unregistered-with-.NET
    /// scheme doesn't need more than "find '?', split on '&', split on
    /// '='" — the pairing code alphabet (Crockford Base32 + hyphens) never
    /// needs percent-decoding, but Uri.UnescapeDataString is applied
    /// defensively anyway in case a browser encodes the hyphens.
    /// </summary>
    public static string? ExtractPairingCode(string[] args)
    {
        foreach (var arg in args)
        {
            if (!IsPairingUri(arg)) continue;
            var queryStart = arg.IndexOf('?');
            if (queryStart < 0) return null;
            foreach (var pair in arg[(queryStart + 1)..].Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var kv = pair.Split('=', 2);
                if (kv.Length == 2 && string.Equals(kv[0], "code", StringComparison.OrdinalIgnoreCase))
                {
                    try { return Uri.UnescapeDataString(kv[1]); } catch (FormatException) { return null; }
                }
            }
            return null;
        }
        return null;
    }

    /// <summary>
    /// Bezbedno za log/konzolu — zamenjuje vrednost koja sledi
    /// "--bypass-header" sa "***" PRE spajanja u jedan red, tako da čak i
    /// neočekivana kombinacija (npr. --bypass-header UZ neku DRUGU
    /// nepoznatu opciju) ne može da isprinta tajni token u "Nepoznata
    /// opcija" poruku. Isto tako, jednokratan kod za uparivanje unutar
    /// tablecore-print:// URI-ja se NIKAD ne ispisuje u punom obliku, čak ni
    /// u odbrambenoj "Nepoznata opcija" grani.
    /// </summary>
    public static string Redact(string[] args)
    {
        var redacted = new string[args.Length];
        for (var i = 0; i < args.Length; i++)
        {
            if (i > 0 && args[i - 1] == "--bypass-header") { redacted[i] = "***"; continue; }
            redacted[i] = IsPairingUri(args[i]) ? RedactPairingUri(args[i]) : args[i];
        }
        return string.Join(' ', redacted);
    }

    private static string RedactPairingUri(string uri)
    {
        var queryStart = uri.IndexOf('?');
        return queryStart < 0 ? uri : uri[..queryStart] + "?code=***";
    }
}
