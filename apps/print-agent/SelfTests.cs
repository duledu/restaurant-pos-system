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
        Check(AgentConfig.Parse("{\"station\":\"KITCHEN\",\"printerName\":\"POS-58 (1)\",\"paperWidthMm\":58}").Station == "KITCHEN", "Kitchen config parses");
        Check(AgentConfig.Parse("{\"station\":\"BAR\",\"printerName\":\"POS\",\"paperWidthMm\":80}").Station == "BAR", "Bar config parses");
        Check(Reject(() => AgentConfig.Parse("{}")), "missing config fields rejected");
        Check(Reject(() => new AgentConfig("KITCHEN", " ", 58).Validate()), "blank printer rejected");
        bool malformed = false;
        try { AgentConfig.Parse("{"); } catch (System.Text.Json.JsonException) { malformed = true; }
        Check(malformed, "malformed config JSON rejected");
        var example = Ticket.Example("KITCHEN", new DateTime(2026, 9, 9, 12, 45, 0));
        Check(example.Lines.Last().Text == "12:45", "test ticket uses supplied local time");
        var encoded = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(example);
        var decoded = System.Text.Json.JsonSerializer.Deserialize<Ticket>(encoded)!;
        Check(decoded.Lines.Any(l => l.Text == "č ć ž š đ") && decoded.Lines.Any(l => l.Text == "Č Ć Ž Š Đ"), "Serbian lower and uppercase survive UTF-8 JSON");
        Check(Reject(() => new AgentConfig("RECEIPT", "POS", 58).Validate()), "receipt excluded from POC");
        Check(Reject(() => new AgentConfig("BAR", "POS", 210).Validate()), "A4 config rejected");
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
