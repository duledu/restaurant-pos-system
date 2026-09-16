using System.Net;
using Microsoft.AspNetCore.Http;

namespace TableCore.PrintAgent;

internal static class SelfTests
{
    public static void Run()
    {
        int count = 0;
        void Check(bool condition, string name) { if (!condition) throw new Exception("FAIL: " + name); Console.WriteLine("PASS: " + name); count++; }
        bool Reject(Action action) { try { action(); return false; } catch (ArgumentException) { return true; } }
        Check(AgentConfig.Parse("{\"routes\":[{\"type\":\"KITCHEN\",\"printerName\":\"POS-58 (1)\",\"paperWidthMm\":58}]}").Routes[0].Type == "KITCHEN", "Kitchen route config parses");
        Check(AgentConfig.Parse("{\"routes\":[{\"type\":\"BAR\",\"printerName\":\"POS\",\"paperWidthMm\":80}]}").Routes[0].Type == "BAR", "Bar route config parses");
        Check(AgentConfig.Parse("""{"routes":[{"type":"KITCHEN","printerName":"POS-58","paperWidthMm":58},{"type":"BAR","printerName":"POS-58","paperWidthMm":58},{"type":"RECEIPT","printerName":"POS-58","paperWidthMm":58}]}""").Routes.Length == 3,
            "one agent can have three routes (KITCHEN+BAR+RECEIPT) sharing the same physical printer");
        Check(Reject(() => AgentConfig.Parse("{}")), "missing config fields rejected");
        Check(Reject(() => new AgentConfig([]).Validate()), "empty routes list rejected");
        Check(Reject(() => new PrintRoute("KITCHEN", " ", 58).Validate()), "blank printer rejected");
        Check(Reject(() => new AgentConfig([new PrintRoute("KITCHEN", "POS-58", 58), new PrintRoute("KITCHEN", "POS-80", 80)]).Validate()),
            "duplicate route type (two KITCHEN routes on one agent) rejected — ambiguous which printer would win");
        bool malformed = false;
        try { AgentConfig.Parse("{"); } catch (System.Text.Json.JsonException) { malformed = true; }
        Check(malformed, "malformed config JSON rejected");

        // Printing V2 upgrade path — a machine paired before this version
        // wrote the OLD flat {station,printerName,paperWidthMm} shape, which
        // no longer parses as {routes:[...]}. ParseWithLegacyFallback must
        // convert it in memory (AgentRunner then persists it back in the
        // new shape) so the real physical Kuhinja_new_test machine upgrades
        // with NO re-pairing, no reset, no reinstall.
        {
            var (migrated, wasLegacy) = AgentConfig.ParseWithLegacyFallback("{\"station\":\"KITCHEN\",\"printerName\":\"POS-58\",\"paperWidthMm\":58}");
            Check(wasLegacy && migrated.Routes.Length == 1 && migrated.Routes[0].Type == "KITCHEN" && migrated.Routes[0].PrinterName == "POS-58" && migrated.Routes[0].PaperWidthMm == 58,
                "old flat station/printerName/paperWidthMm config upgrades in-memory to a one-route AgentConfig");
            var (current, wasLegacyForNewShape) = AgentConfig.ParseWithLegacyFallback("{\"routes\":[{\"type\":\"BAR\",\"printerName\":\"POS\",\"paperWidthMm\":80}]}");
            Check(!wasLegacyForNewShape && current.Routes[0].Type == "BAR", "an already-new-shape config is not (mis)treated as legacy");
            Check(Reject(() => { AgentConfig.ParseWithLegacyFallback("{\"station\":\"KITCHEN\"}"); }),
                "a legacy-shaped object missing printerName/paperWidthMm still fails (no silent partial migration)");
        }

        // Professional installer audit (state-aware Setup launch), updated
        // for Printing V2 — the installer's NeedsSetupAfterInstall
        // (TableCorePrintAgent.iss, Pascal Script has no JSON parser)
        // decides "is this installation already fully configured" by
        // text-searching agent.config.json for the EXACT substrings a real
        // config write would produce. Routes are no longer written by
        // SetupForm.OnSave directly (AgentRunner.ApplyServerRoutes/
        // PersistConfig now own every write, via AgentConfig.ToJson()) —
        // this test is the contract that keeps the installer's mirror
        // honest against THAT shape: if it ever changes (property renamed,
        // casing changed, an unexpected space inserted), THIS test fails
        // here — loudly, in the same codebase — instead of the installer
        // silently misjudging "configured" on a real machine with no test
        // coverage at all on that side. A route only ever appears in this
        // file with a real (non-empty) printerName (AgentConfig.Validate()
        // enforces this before any write), so the installer's check can be
        // as simple as "does a printerName field appear at all".
        {
            var configJson = new AgentConfig([new PrintRoute("KITCHEN", "POS-58", 58)]).ToJson();
            // WriteIndented=true inserts a SPACE after each colon — this
            // test caught the installer's original Pascal-side patterns
            // assuming no space, which would have made NeedsSetupAfterInstall
            // ALWAYS return True (Setup reopening on every upgrade, even
            // fully configured ones) because the real file never matches a
            // colon-with-no-space pattern. Both sides now agree on "colon,
            // one space, value".
            Check(configJson.Contains("\"routes\"", StringComparison.Ordinal),
                "AgentConfig.ToJson() still matches the installer's NeedsSetupAfterInstall routes-array check");
            Check(configJson.Contains("\"type\": \"KITCHEN\"", StringComparison.Ordinal),
                "AgentConfig.ToJson() still matches the installer's NeedsSetupAfterInstall route-type check");
            Check(configJson.Contains("\"printerName\": \"POS-58\"", StringComparison.Ordinal) && !configJson.Contains("\"printerName\": \"\"", StringComparison.Ordinal),
                "AgentConfig.ToJson() still matches the installer's NeedsSetupAfterInstall printer check");
            Check(configJson.Contains("\"paperWidthMm\": 58", StringComparison.Ordinal),
                "AgentConfig.ToJson() still matches the installer's NeedsSetupAfterInstall paper-width check");
            var emptyRoutesJson = System.Text.Json.JsonSerializer.Serialize(new { routes = Array.Empty<object>() },
                new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web) { WriteIndented = true });
            Check(!emptyRoutesJson.Contains("\"printerName\": \"", StringComparison.Ordinal),
                "an empty routes array (no routes configured yet) never contains a printerName field — installer correctly still requires Setup");
        }
        var example = Ticket.Example("KITCHEN", new DateTime(2026, 9, 9, 12, 45, 0));
        Check(example.Lines.Last().Text == "12:45", "test ticket uses supplied local time");
        var encoded = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(example);
        var decoded = System.Text.Json.JsonSerializer.Deserialize<Ticket>(encoded)!;
        Check(decoded.Lines.Any(l => l.Text == "č ć ž š đ") && decoded.Lines.Any(l => l.Text == "Č Ć Ž Š Đ"), "Serbian lower and uppercase survive UTF-8 JSON");
        // Printing V2 — RECEIPT is now a first-class supported route type
        // (inverted from the earlier "receipt excluded from POC" behavior).
        Check(!Reject(() => new PrintRoute("RECEIPT", "POS", 58).Validate()), "RECEIPT is now a fully supported route type");
        Check(Reject(() => new PrintRoute("FISCAL", "POS", 58).Validate()), "an unknown route type is still rejected");
        Check(Reject(() => new PrintRoute("BAR", "POS", 210).Validate()), "A4 paper width rejected");
        Check(Reject(() => new Ticket([new("bad\nline")]).Validate()), "control characters rejected");
        Check(Reject(() => new Ticket([new("text", float.NaN)]).Validate()), "nonfinite font rejected");
        using var small = new TicketRaster(Ticket.Example("KITCHEN"), 58);
        using var wide = new TicketRaster(Ticket.Example("BAR"), 80);
        Check(small.WidthUnits == 228 && wide.WidthUnits == 315, "58/80 mm page width");
        Check(small.HeightUnits < 500, "compact sample below 127 mm");
        Check(small.HeightUnits == (int)Math.Ceiling(small.Image.Height / TicketRaster.Dpi * 100 + 4 / 25.4 * 100), "page height includes measured raster and 4 mm feed");
        using var wrapped = new TicketRaster(new Ticket([new(new string('W', 180))]), 58);
        using var shortLine = new TicketRaster(new Ticket([new("W")]), 58);
        Check(wrapped.HeightUnits > shortLine.HeightUnits, "long words wrap and increase height");
        Directory.CreateDirectory("artifacts");
        small.Image.Save("artifacts/test-ticket-58.png");
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        context.Request.Host = new HostString("127.0.0.1", 17831);
        context.Request.Headers.Authorization = "Bearer " + new string('a', 32);
        Check(RequestProtection.Allowed(context, new string('a', 32)), "authenticated loopback allowed");
        Check(!RequestProtection.Allowed(context, new string('b', 32)), "wrong token rejected");
        context.Request.Headers.Origin = "https://untrusted.example";
        Check(!RequestProtection.Allowed(context, new string('a', 32)), "browser origin rejected");
        context.Request.Headers.Remove("Origin");
        context.Request.Host = new HostString("evil.example", 17831);
        Check(!RequestProtection.Allowed(context, new string('a', 32)), "DNS rebinding host rejected");
        var failure = WindowsPrinter.Print(new("KITCHEN", "TableCore-Nonexistent-" + Guid.NewGuid(), 58), Ticket.Example("KITCHEN"), "self-test");
        Check(failure.Status == "FAILED_BEFORE_SUBMISSION", "missing printer fails before submission");

        // Faza 2C follow-up — PREPROD fizički test dokazao "Driver printable
        // area is too small for this ticket." za stvarnu (dužu) porudžbinu na
        // POS-58, dok je kratak Test Print prolazio. Uzrok: fiksnih ~4mm
        // bafera (staro HeightUnits) nije bilo dovoljno za STVARNU marginu tog
        // drajvera. ComputeFinalHeightUnits je čista aritmetika (bez Windows
        // API-ja) izdvojena baš da bi se ovo moglo dokazati sa sintetičkim
        // marginama, bez potrebe za baš tim tačnim drajverom.
        Check(WindowsPrinter.ComputeFinalHeightUnits(contentHeightUnits: 1000, probeBoundsHeight: 1000, probePrintableAreaHeight: 1000) == 1000,
            "zero-margin driver: final height equals content height exactly");
        Check(WindowsPrinter.ComputeFinalHeightUnits(contentHeightUnits: 1000, probeBoundsHeight: 1000, probePrintableAreaHeight: 984) == 1016,
            "~4mm-margin driver: final height adds the real 16-unit margin (same as the old fixed guess, here proven measured not assumed)");
        Check(WindowsPrinter.ComputeFinalHeightUnits(contentHeightUnits: 1000, probeBoundsHeight: 1000, probePrintableAreaHeight: 961) == 1039,
            "large-margin driver (~10mm, exceeds the old fixed ~4mm guess): final height adapts instead of using a hardcoded buffer — proves the PREPROD failure mode is now handled");
        Check(WindowsPrinter.ComputeFinalHeightUnits(contentHeightUnits: 1000, probeBoundsHeight: 1000, probePrintableAreaHeight: 1005) == 1000,
            "driver reporting printable area LARGER than bounds (unusual but possible rounding) never subtracts — content height is never shrunk below itself, i.e. never truncated");
        for (var contentHeight = 100; contentHeight <= 5000; contentHeight += 733)
        {
            var final = WindowsPrinter.ComputeFinalHeightUnits(contentHeight, probeBoundsHeight: 1000, probePrintableAreaHeight: 950);
            Check(final >= contentHeight, $"final height ({final}) never smaller than content height ({contentHeight}) — no truncation, for any ticket length");
        }

        // Real end-to-end dry-run against the ACTUAL installed driver(s) on
        // this build machine — no physical printing (dryRun: true), same
        // PREFLIGHT_ONLY path used by --probe-printer. Skipped gracefully
        // when a given printer isn't installed, so this suite stays portable
        // to machines without it.
        var installedPrinters = WindowsPrinter.Enumerate();
        foreach (var printerName in new[] { "POS-58" })
        {
            if (!installedPrinters.Contains(printerName, StringComparer.Ordinal))
            {
                Console.WriteLine($"SKIP: real-driver dry-run tests for \"{printerName}\" — not installed on this machine.");
                continue;
            }
            var shortTicket = Ticket.Example("KITCHEN");
            var shortResult = WindowsPrinter.Print(new("KITCHEN", printerName, 58), shortTicket, "self-test-short", dryRun: true);
            Check(shortResult.Status == "PREFLIGHT_ONLY", $"[{printerName}] short Test-Print-shaped ticket fits real driver printable area");

            // Realistic multi-item kitchen ticket — same shape/length class as
            // the PREPROD order that failed ("Driver printable area is too
            // small for this ticket."). Proves the two-pass, driver-measured
            // sizing (not the old fixed ~4mm buffer) now fits a REAL longer
            // ticket on THIS same driver.
            var longLines = new List<TicketLine> { new("TABLECORE", 16, true), new("KUHINJA", 14, true), new("STO 12", 18, true) };
            for (var i = 1; i <= 18; i++) longLines.Add(new($"{i}x Stavka jelovnika broj {i} sa dodacima", 12));
            longLines.Add(new("Napomena:", 10));
            longLines.Add(new("BEZ LUKA, EXTRA LJUTO, PAZI NA ALERGIJU", 13, true));
            var longTicket = new Ticket([.. longLines]);
            var longResult = WindowsPrinter.Print(new("KITCHEN", printerName, 58), longTicket, "self-test-long", dryRun: true);
            Check(longResult.Status == "PREFLIGHT_ONLY",
                $"[{printerName}] REGRESSION PROOF: realistic 21-line kitchen ticket (same class as the PREPROD failure) now fits — {longResult.Guarantee}");

            // 80mm width still supported by TicketRaster's width math (the fix
            // only touches height/margin sizing, never width) — verified even
            // though this specific driver is a 58mm roll printer and will
            // reject the 80mm request for its own (unrelated, expected)
            // reasons; we only assert that no WIDTH-related exception occurs
            // before the driver's own width rejection would.
            using var raster80 = new TicketRaster(Ticket.Example("BAR"), 80);
            Check(raster80.WidthUnits == 315, $"[{printerName}] 80mm width math unaffected by the height/margin fix");
        }

        // Faza 2B Korak 0 — DPAPI CredentialStore round-trip. Sačuvaj/vrati
        // BILO KOJI stvaran (već upareni) kredencijal pre/posle testa — ovaj
        // self-test se sme pokrenuti i na već uparenoj mašini i ne sme ga
        // izbrisati.
        var preexisting = CredentialStore.Load();
        try
        {
            var testValue = "tcpa1_selftest_" + Guid.NewGuid().ToString("N");
            CredentialStore.Save(testValue);
            Check(CredentialStore.HasStoredCredential(), "credential store reports saved after Save");
            Check(CredentialStore.Load() == testValue, "DPAPI round-trip returns exact saved value");
            CredentialStore.Clear();
            Check(!CredentialStore.HasStoredCredential(), "credential store reports absent after Clear");
            Check(CredentialStore.Load() is null, "Load returns null (never throws) when nothing is stored");
        }
        finally
        {
            if (preexisting is not null) CredentialStore.Save(preexisting);
            else CredentialStore.Clear();
        }

        // Faza 2B — AgentDatabase (SQLite trajno stanje) prelazi stanja i
        // GetUnresolved/Delete. Sopstveni jasno-testni jobId, obavezno
        // obrisan na kraju — ne dira stvarne redove.
        AgentDatabase.EnsureInitialized();
        var testJobId = "self-test-job-" + Guid.NewGuid();
        var testAttemptId = Guid.NewGuid().ToString();
        try
        {
            AgentDatabase.RecordReceived(testJobId, testAttemptId, "hash123");
            var afterReceived = AgentDatabase.GetUnresolved().Single(a => a.JobId == testJobId);
            Check(afterReceived.State == AttemptState.Received && afterReceived.AttemptId == testAttemptId, "AgentDatabase records Received state");

            AgentDatabase.RecordSubmissionStarted(testJobId);
            var afterStarted = AgentDatabase.GetUnresolved().Single(a => a.JobId == testJobId);
            Check(afterStarted.State == AttemptState.SubmissionStarted && afterStarted.SubmissionStartedAtUtc is not null, "AgentDatabase records SubmissionStarted with timestamp");

            AgentDatabase.RecordPrintInvoked(testJobId);
            Check(AgentDatabase.GetUnresolved().Single(a => a.JobId == testJobId).State == AttemptState.PrintInvoked, "AgentDatabase records PrintInvoked BEFORE the physical call site");

            AgentDatabase.RecordResultKnown(testJobId, "SUBMITTED_TO_SPOOLER", null);
            var afterResult = AgentDatabase.GetUnresolved().Single(a => a.JobId == testJobId);
            Check(afterResult.State == AttemptState.ResultKnown && afterResult.Result == "SUBMITTED_TO_SPOOLER", "AgentDatabase records known result");

            AgentDatabase.RecordAcked(testJobId);
            Check(AgentDatabase.GetUnresolved().All(a => a.JobId != testJobId), "GetUnresolved excludes Acked rows (restart reconciliation stops tracking confirmed attempts)");
        }
        finally
        {
            AgentDatabase.Delete(testJobId);
        }

        // Faza 2B — TicketPayload.Parse pretvara zamrznut server JSON u
        // Ticket bez gubljenja ćirilice/latinice ili stavki/dodataka.
        var payloadJson = System.Text.Json.JsonDocument.Parse("""
            {"kind":"KITCHEN","stationLabel":"KUHINJA","tableLabel":"5","waiterName":"Marko","orderNumber":"ABC123",
             "submittedAt":"2026-09-09T10:00:00.000Z","isAdditional":false,"paperWidthMm":58,
             "items":[{"quantity":2,"name":"Pljeskavica č ć ž š đ","note":"bez luka","modifiers":["+ Kačkavalj"]}]}
            """).RootElement;
        var (parsedTicket, parsedWidth, parsedStation) = TicketPayload.Parse(payloadJson);
        Check(parsedWidth == 58, "TicketPayload reads paperWidthMm from the frozen payload, never hardcoded");
        Check(parsedStation == "KITCHEN", "TicketPayload derives station from payload kind");
        Check(parsedTicket.Lines.Any(l => l.Text.Contains("Pljeskavica č ć ž š đ")), "TicketPayload preserves Serbian characters in item name");
        Check(parsedTicket.Lines.Any(l => l.Text.Contains("Kačkavalj")), "TicketPayload includes modifiers");
        Check(parsedTicket.Lines.Any(l => l.Text.Contains("bez luka")), "TicketPayload includes item note");
        parsedTicket.Validate(); // baca ako ijedna linija krši postojeća Faza 1 pravila (dužina/kontrolni znakovi)
        Check(true, "TicketPayload output passes existing Ticket.Validate() unchanged");

        // Faza 2C — bezbedno rešavanje servera (AgentEndpoint). Napravljeno
        // POSLE stvarnog incidenta (vidi AgentEndpoint.cs) gde je tih pad na
        // produkciju skoro prošao neopaženo — ovi testovi dokazuju da je to
        // sada STRUKTURNO nemoguće, ne samo "obično ne treba da se desi".
        bool RejectsEndpoint(string[] endpointArgs)
        {
            try { AgentEndpoint.Resolve(endpointArgs); return false; }
            catch (AgentEndpointConfigurationException) { return true; }
        }
        var prod = AgentEndpoint.Resolve([]);
        Check(prod.Mode == AgentRuntimeMode.Production && prod.BaseUrl == AgentEndpoint.ProductionBaseUrl,
            "no args -> Production mode, production URL");
        Check(RejectsEndpoint(["--mode", "test"]), "test mode without --server fails closed (no silent default)");
        Check(RejectsEndpoint(["--mode", "test", "--server", "not-a-url"]), "malformed --server in test mode fails closed");
        Check(RejectsEndpoint(["--mode", "test", "--server", ""]), "empty --server in test mode fails closed");
        Check(RejectsEndpoint(["--mode", "test", "--server", "https://tablecore.net"]), "test mode cannot silently use tablecore.net");
        Check(RejectsEndpoint(["--server", "http://127.0.0.1:3101"]), "production mode (default) does not accidentally consume a non-production --server");
        Check(RejectsEndpoint(["--mode", "production", "--server", "http://localhost:9999"]), "explicit production mode rejects localhost override");
        Check(RejectsEndpoint(["--mode", "bogus"]), "unknown --mode value fails closed");
        var test = AgentEndpoint.Resolve(["--mode", "test", "--server", "http://127.0.0.1:3101"]);
        Check(test.Mode == AgentRuntimeMode.Test && test.BaseUrl == "http://127.0.0.1:3101", "valid explicit test mode + non-production server resolves correctly");
        var prodExplicitSameHost = AgentEndpoint.Resolve(["--server", "https://tablecore.net"]);
        Check(prodExplicitSameHost.Mode == AgentRuntimeMode.Production, "production mode accepts --server that matches the production host itself");
        // Bezbedno za log: SAMO mode+scheme+host, struktura sama isključuje
        // kredencijal (AgentEndpoint nikad ne prima/ne nosi kredencijal).
        Check(System.Text.RegularExpressions.Regex.IsMatch(test.DescribeForLog(), @"^mode=(Production|Test), endpoint=https?://[^\s]+$"),
            "DescribeForLog format is endpoint-only (mode+scheme+host), structurally cannot carry a credential");
        Check(!test.DescribeForLog().Contains("tcpa1_", StringComparison.Ordinal) && !test.DescribeForLog().Contains("Bearer", StringComparison.Ordinal),
            "DescribeForLog never resembles a credential/bearer token");

        // Faza 2C follow-up — Vercel Deployment Protection na PREPROD Preview
        // URL-ovima blokira agentove sopstvene pozive PRE naše aplikacije
        // (401 sa vercel_auth_enabled u telu, dokazano direktnim curl
        // reprodukcijama protiv stvarnog PREPROD deployment-a). Rešenje je
        // opciono --bypass-header, ali SAMO u test režimu — ovi testovi
        // dokazuju da produkcija nikad ne može nositi ovo zaglavlje čak i
        // ako je --bypass-header greškom prosleđen uz nju.
        var testWithBypass = AgentEndpoint.Resolve(["--mode", "test", "--server", "http://127.0.0.1:3101", "--bypass-header", "secret123"]);
        Check(testWithBypass.BypassHeader == "secret123", "test mode captures --bypass-header value");
        var testWithoutBypass = AgentEndpoint.Resolve(["--mode", "test", "--server", "http://127.0.0.1:3101"]);
        Check(testWithoutBypass.BypassHeader is null, "test mode without --bypass-header leaves it null (no forced dependency)");
        var prodWithBypassArg = AgentEndpoint.Resolve(["--bypass-header", "secret123"]);
        Check(prodWithBypassArg.BypassHeader is null, "production mode NEVER carries --bypass-header even if the arg is present (fail closed)");
        using (var bypassClient = new HttpClient())
        {
            testWithBypass.ConfigureHttpClientDefaults(bypassClient);
            Check(bypassClient.DefaultRequestHeaders.TryGetValues(AgentEndpoint.BypassHeaderName, out var values) && values.Single() == "secret123",
                "ConfigureHttpClientDefaults adds the bypass header for a test-mode endpoint that has one");
        }
        using (var prodClient = new HttpClient())
        {
            prodWithBypassArg.ConfigureHttpClientDefaults(prodClient);
            Check(!prodClient.DefaultRequestHeaders.Contains(AgentEndpoint.BypassHeaderName),
                "ConfigureHttpClientDefaults is a no-op for a production endpoint — never adds the bypass header");
        }

        // Print Agent professional audit finding (physical QA: pairing
        // succeeded through the bypass, the immediate post-Save heartbeat
        // did not) — PairingClient and DeliveryClient each own a SEPARATE
        // static HttpClient; SetupForm.cs's constructor called ONLY
        // PairingClient.ConfigureBypassHeader, so DeliveryClient.Heartbeat
        // (used by Setup's post-Save verification) went out with no bypass
        // header at all. Fixed by routing every caller through ONE
        // authoritative AgentEndpoint.ConfigureAgentHttpClients. This test
        // proves BOTH real static clients actually receive the header from
        // that single call — reflection is used deliberately: the bug was
        // exactly "two independent private static HttpClient instances",
        // so the test must observe both real instances, not a substitute.
        {
            var pairingHttp = (HttpClient)typeof(PairingClient)
                .GetField("Http", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!
                .GetValue(null)!;
            var deliveryHttp = (HttpClient)typeof(DeliveryClient)
                .GetField("Http", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!
                .GetValue(null)!;
            AgentEndpoint.ConfigureAgentHttpClients(testWithBypass);
            Check(pairingHttp.DefaultRequestHeaders.TryGetValues(AgentEndpoint.BypassHeaderName, out var pv) && pv.Single() == "secret123",
                "ConfigureAgentHttpClients configures PairingClient's real static HttpClient");
            Check(deliveryHttp.DefaultRequestHeaders.TryGetValues(AgentEndpoint.BypassHeaderName, out var dv) && dv.Single() == "secret123",
                "ConfigureAgentHttpClients configures DeliveryClient's real static HttpClient (the one SetupForm previously missed)");
            // Cleanup — self-tests must not leave global static HttpClient
            // state mutated for whatever runs next in this process.
            pairingHttp.DefaultRequestHeaders.Remove(AgentEndpoint.BypassHeaderName);
            deliveryHttp.DefaultRequestHeaders.Remove(AgentEndpoint.BypassHeaderName);
        }

        // Professional error-UX audit — a restaurant manager must never see
        // "Vercel"/deployment-protection terminology; the platform-level
        // rejection (edge, before the TableCore application) must read as a
        // generic "server unavailable, contact administrator", distinct
        // from a genuinely wrong pairing code.
        {
            var describeFailure = typeof(PairingClient).GetMethod("DescribeFailure", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
            var vercelBlockedBody = "{\"error\":{\"code\":\"401\",\"message\":\"Protected deployment\"},\"protection\":{\"vercel_auth_enabled\":true}}";
            var vercelMessage = (string)describeFailure.Invoke(null, [401, vercelBlockedBody])!;
            Check(!vercelMessage.Contains("Vercel", StringComparison.OrdinalIgnoreCase) && !vercelMessage.Contains("bypass", StringComparison.OrdinalIgnoreCase),
                "a platform-level (Vercel edge) pairing rejection never exposes Vercel/bypass terminology to the restaurant user");
            var wrongCodeMessage = (string)describeFailure.Invoke(null, [401, "{\"error\":\"Kod za uparivanje nije prihvacen\"}"])!;
            Check(wrongCodeMessage != vercelMessage, "a genuinely wrong pairing code still reads as a distinct message from the platform-level rejection");
        }

        // Regresija (dokazana empirijski praznim exit code 1, bez ijednog
        // prozora, dana pre ovog fixa) — SetupArgumentDispatch.IsInteractiveSetupArgs
        // je izdvojena kopija Program.cs top-level provere koja odlučuje da
        // li se SetupForm uopšte otvara. --bypass-header MORA biti u istoj
        // grupi kao --mode/--server, inače PREPROD instaler/prečica
        // ("--mode test --server <url> --bypass-header <secret>") pada u
        // granu "Nepoznata opcija" i Setup ekran se nikad ne prikaže.
        Check(SetupArgumentDispatch.IsInteractiveSetupArgs(
                ["--mode", "test", "--server", "http://127.0.0.1:3101", "--bypass-header", "secret123"]),
            "Setup args (--mode test --server <non-prod-url> --bypass-header <value>) are accepted — the exact PREPROD shortcut/service argument shape");
        Check(SetupArgumentDispatch.IsInteractiveSetupArgs([]), "no args (plain double-click) still opens Setup — unchanged");
        Check(SetupArgumentDispatch.IsInteractiveSetupArgs(["--mode", "test", "--server", "http://127.0.0.1:3101"]),
            "Setup args without --bypass-header still work — unchanged prior behavior");
        Check(!SetupArgumentDispatch.IsInteractiveSetupArgs(["--mode", "test", "--server", "http://127.0.0.1:3101", "--bypass-header", "secret123", "--unknown"]),
            "an actually unknown flag alongside --bypass-header still fails closed (no validation weakened)");
        Check(!SetupArgumentDispatch.IsInteractiveSetupArgs(["--run"]), "an unrelated known CLI flag (--run) is still NOT treated as an interactive Setup arg");
        // Dispatch samo odlučuje DA LI se Setup ekran otvara (isto ponašanje
        // kao već postojeće "--mode" ili "--server" samostalno, PRE ovog
        // fixa) — stvaran fail-closed zahtev (vrednost mora postojati i biti
        // ispravna) je ISKLJUČIVO odgovornost AgentEndpoint.Resolve ispod,
        // koji SetupForm poziva i čiji izuzetak prikazuje kao _endpointError
        // (dugme za uparivanje ostaje onemogućeno). Dispatch-nivo provera
        // namerno ne duplira tu proveru.
        Check(SetupArgumentDispatch.IsInteractiveSetupArgs(["--bypass-header"]),
            "a bare --bypass-header with no value still opens Setup (dispatch-level, same as bare --mode/--server before this fix) — AgentEndpoint.Resolve is the actual fail-closed gate");
        // "Production mode does NOT accept/use/forward bypass header" — proveno
        // već iznad preko AgentEndpoint (prodWithBypassArg.BypassHeader is null);
        // ovo ovde dokazuje da čak i kad DISPATCH prepozna --bypass-header kao
        // deo "endpoint argumenata" grupe (dozvoljava da se Setup otvori),
        // stvarna rezolucija servera i dalje potpuno ignoriše tu vrednost čim
        // --mode nije "test" — isti fail-closed rezultat kao gore, sada uz
        // potvrdu da dispatch-nivo promena ovo ni na koji način ne slabi.
        var prodDispatchArgs = new[] { "--server", "https://tablecore.net", "--bypass-header", "secret123" };
        Check(SetupArgumentDispatch.IsInteractiveSetupArgs(prodDispatchArgs), "production-mode endpoint args + --bypass-header still open Setup (dispatch only decides whether to show the screen)");
        var prodDispatchEndpoint = AgentEndpoint.Resolve(prodDispatchArgs);
        Check(prodDispatchEndpoint.Mode == AgentRuntimeMode.Production && prodDispatchEndpoint.BypassHeader is null,
            "...but resolves to Production with BypassHeader still null — existing fail-closed Production behavior is unchanged by the dispatch fix");
        // "no secret is printed to logs/errors/test output" — Redact() menja
        // SAMO vrednost koja sledi "--bypass-header" u "***" pre spajanja u
        // jedan red, nikad ne otkriva stvaran sadržaj.
        var redacted = SetupArgumentDispatch.Redact(["--mode", "test", "--bypass-header", "secret123", "--unknown"]);
        Check(!redacted.Contains("secret123", StringComparison.Ordinal) && redacted.Contains("***", StringComparison.Ordinal),
            "Redact() never lets a --bypass-header value reach an error/log line, even in the fail-closed 'Nepoznata opcija' branch");

        // Printing V2 — professional Admin -> Agent pairing handoff via a
        // custom tablecore-print:// URI (installer-registered, see
        // TableCorePrintAgent.iss [Registry]). A lone URI argument must be
        // recognized as interactive Setup args (opens the ordinary Setup
        // screen, never the "Nepoznata opcija" error path), the pairing
        // code must be extracted for pre-fill ONLY (never auto-submitted —
        // that's SetupForm's job, not this dispatch layer), and the code
        // must never leak into a log/redaction line.
        Check(SetupArgumentDispatch.IsInteractiveSetupArgs(["tablecore-print://pair?code=ABCD-EFGH-JKMN"]),
            "a lone tablecore-print:// pairing URI is recognized as interactive Setup args");
        Check(SetupArgumentDispatch.IsInteractiveSetupArgs(
                ["tablecore-print://pair?code=ABCD-EFGH-JKMN", "--mode", "test", "--server", "http://127.0.0.1:3101"]),
            "a pairing URI alongside PREPROD endpoint args (baked into the registered protocol command) is still recognized");
        Check(!SetupArgumentDispatch.IsInteractiveSetupArgs(["tablecore-print://pair?code=ABCD-EFGH-JKMN", "--unknown"]),
            "a pairing URI alongside a genuinely unknown flag still fails closed (no validation weakened)");
        Check(SetupArgumentDispatch.ExtractPairingCode(["tablecore-print://pair?code=ABCD-EFGH-JKMN"]) == "ABCD-EFGH-JKMN",
            "ExtractPairingCode reads the code query parameter from a pairing URI");
        Check(SetupArgumentDispatch.ExtractPairingCode(["tablecore-print://pair?other=1&code=WXYZ-2345-6789"]) == "WXYZ-2345-6789",
            "ExtractPairingCode finds code even when it isn't the first query parameter");
        Check(SetupArgumentDispatch.ExtractPairingCode([]) is null, "ExtractPairingCode returns null with no args (plain double-click, unchanged behavior)");
        Check(SetupArgumentDispatch.ExtractPairingCode(["--mode", "test"]) is null, "ExtractPairingCode returns null when no pairing URI is present");
        Check(SetupArgumentDispatch.ExtractPairingCode(["tablecore-print://pair?nocode=1"]) is null, "ExtractPairingCode returns null (never throws) for a URI missing the code parameter");
        Check(SetupArgumentDispatch.ExtractPairingCode(["not-a-uri-at-all"]) is null, "ExtractPairingCode returns null (never throws) for a foreign/malformed argument");
        var uriRedacted = SetupArgumentDispatch.Redact(["tablecore-print://pair?code=ABCD-EFGH-JKMN", "--unknown"]);
        Check(!uriRedacted.Contains("ABCD-EFGH-JKMN", StringComparison.Ordinal) && uriRedacted.Contains("code=***", StringComparison.Ordinal),
            "Redact() never lets a pairing code from a tablecore-print:// URI reach an error/log line either");

        // Physical QA follow-up — broken re-pair UX. A fresh pairing was
        // generated in Admin and "Otvori TableCore Print Agent" launched
        // the Agent to consume it, but the incoming code was silently
        // ignored because a credential already existed: the field stayed
        // disabled, the only action was a "Ponovo upari" button that (per
        // the OLD code) tried to pair with an empty box. PairingFlow.Resolve
        // is the fix's single source of truth (see PairingFlow.cs) — these
        // are the exact regression scenarios from the physical report.
        {
            // 1: normal Start Menu open + already paired -> must not alter
            // pairing (disabled field, nothing pre-filled, no warning).
            var normalPaired = PairingFlow.Resolve(alreadyPaired: true, incomingPairingCode: null);
            Check(normalPaired.Mode == PairingUiMode.NormalSettings && !normalPaired.PairingCodeBoxEnabled && normalPaired.PairingCodeBoxText.Length == 0 && !normalPaired.ShowRepairWarning,
                "CASE A: plain open while already paired never alters the existing pairing (field stays disabled/empty, no warning)");

            // 2: URI open + unpaired -> code prefilled, ready for an
            // explicit "Poveži" (never auto-submitted — Resolve only
            // decides what to DISPLAY, SetupForm.OnPair is a separate,
            // explicit user action either way).
            var prefillUnpaired = PairingFlow.Resolve(alreadyPaired: false, incomingPairingCode: "ABCD-EFGH-JKMN");
            Check(prefillUnpaired.Mode == PairingUiMode.PrefillUnpaired && prefillUnpaired.PairingCodeBoxText == "ABCD-EFGH-JKMN" && prefillUnpaired.PairingCodeBoxEnabled && !prefillUnpaired.ShowRepairWarning,
                "CASE B (unpaired): incoming pairing code is pre-filled and the field is enabled for an explicit Poveži");

            // 3 + 4: URI open + ALREADY paired -> THIS is the exact reported
            // bug. The incoming code must NOT be ignored, and an explicit
            // re-pair confirmation (warning shown, code visible) must
            // result — never a silent credential swap.
            var confirmRepair = PairingFlow.Resolve(alreadyPaired: true, incomingPairingCode: "WXYZ-2345-6789");
            Check(confirmRepair.Mode == PairingUiMode.ConfirmRepair,
                "CASE B (already paired): an incoming pairing code is NOT ignored — explicit re-pair confirmation is offered instead of the old silent-drop behavior");
            Check(confirmRepair.PairingCodeBoxText == "WXYZ-2345-6789" && confirmRepair.PairingCodeBoxEnabled,
                "CASE B (already paired): the actual incoming code is shown, not a blank/disabled field");
            Check(confirmRepair.ShowRepairWarning,
                "CASE B (already paired): the explicit 're-pairing will replace the existing pairing' warning is shown — never a silent swap");

            // Not paired, no incoming code — ordinary first-time pairing
            // screen (field enabled, empty, no warning) — unchanged baseline.
            var freshUnpaired = PairingFlow.Resolve(alreadyPaired: false, incomingPairingCode: null);
            Check(freshUnpaired.Mode == PairingUiMode.NormalSettings && freshUnpaired.PairingCodeBoxEnabled && freshUnpaired.PairingCodeBoxText.Length == 0,
                "unpaired machine with no incoming code still gets the ordinary empty first-pairing screen (unchanged baseline)");

            // Whitespace-only/empty incoming code is treated as "no code",
            // not a malformed non-null value — defensive, matches
            // SetupArgumentDispatch.ExtractPairingCode's own "null on
            // anything not cleanly parseable" contract.
            var blankCode = PairingFlow.Resolve(alreadyPaired: true, incomingPairingCode: "   ");
            Check(blankCode.Mode == PairingUiMode.NormalSettings, "a whitespace-only incoming code is treated as no code at all (defensive)");
        }

        // Faza 2C — Ticket.TestPrint (Admin "Test Print" dugme, autentifikovan
        // put preko AgentRunner.HandleTestPrintRequest). Mora biti jasno
        // obeleženo i uključiti sva tražena polja, i mora proći postojeću
        // Ticket.Validate() bez izmena tih pravila.
        var testTicket = Ticket.TestPrint("KUHINJA-01", "KITCHEN", "POS-58 (1)", 58, AgentVersion.Current, new DateTime(2026, 9, 9, 12, 0, 0));
        Check(testTicket.Lines.Any(l => l.Text == "TABLECORE TEST PRINT"), "Test Print ticket is explicitly marked TABLECORE TEST PRINT");
        Check(testTicket.Lines.Any(l => l.Text.Contains("KUHINJA-01")), "Test Print ticket includes workstation name");
        Check(testTicket.Lines.Any(l => l.Text.Contains("KITCHEN")), "Test Print ticket includes station");
        Check(testTicket.Lines.Any(l => l.Text.Contains("POS-58 (1)")), "Test Print ticket includes printer name");
        Check(testTicket.Lines.Any(l => l.Text.Contains("58 mm")), "Test Print ticket includes paper width");
        Check(testTicket.Lines.Any(l => l.Text.Contains(AgentVersion.Current)), "Test Print ticket includes agent version");
        Check(testTicket.Lines.Any(l => l.Text.Contains("2026-09-09")), "Test Print ticket includes a timestamp");
        testTicket.Validate();
        Check(true, "Test Print ticket passes existing Ticket.Validate() unchanged");

        // Faza 2C — putanje ostaju centralizovane pod ProgramData (ne
        // LocalAppData, ne izvorni checkout) — regresija bi tiho vratila
        // Fazu 2A/2B ponašanje koje servis ne bi mogao da čita.
        Check(AgentPaths.ConfigFilePath.StartsWith(AgentPaths.ProgramDataDirectory, StringComparison.Ordinal), "config path lives under ProgramData");
        Check(AgentPaths.CredentialFilePath.StartsWith(AgentPaths.ProgramDataDirectory, StringComparison.Ordinal), "credential path lives under ProgramData");
        Check(AgentPaths.DatabaseFilePath.StartsWith(AgentPaths.ProgramDataDirectory, StringComparison.Ordinal), "SQLite state path lives under ProgramData");
        Check(AgentPaths.LogsDirectory.StartsWith(AgentPaths.ProgramDataDirectory, StringComparison.Ordinal), "logs directory lives under ProgramData");
        Check(!AgentPaths.ProgramDataDirectory.Contains(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), StringComparison.OrdinalIgnoreCase),
            "ProgramData path is NOT under per-user LocalAppData (service-readable, not tied to one Windows account)");

        Console.WriteLine($"{count} tests passed; no physical printing attempted.");
    }
}
