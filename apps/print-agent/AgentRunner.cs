using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TableCore.PrintAgent;

/// <summary>
/// Faza 2B — glavna petlja: POLL -&gt; primljen tiket -&gt; trajan lokalni
/// prijem -&gt; zahtev za dozvolu početka slanja -&gt; PrintDocument.Print
/// -&gt; prijava ishoda. Svaki korak upisuje trajno lokalno stanje PRE
/// sledećeg nepovratnog koraka (AgentDatabase.cs) — restart u BILO KOM
/// trenutku se pomiruje sa serverom pre nego što se vrati na normalan
/// poll, NIKAD ne štampa ponovo naslepo (vidi ReconcileOnStartup).
/// </summary>
public static class AgentRunner
{
    private const int ActivePollMs = 1000;
    private const int MaxIdlePollMs = 3000;
    private static readonly TimeSpan IdleBackoffAfter = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(25);

    /// <summary>
    /// <paramref name="externalStop"/> — Faza 2C: pod Windows servisom nema
    /// konzole/Ctrl+C, pa SCM stop mora imati NEZAVISAN put do ove petlje
    /// (AgentService.cs prosleđuje BackgroundService.stoppingToken ovde).
    /// Kad se pozove bez ovog parametra (postojeći --run CLI put), ponašanje
    /// je NEPROMENJENO — samo Ctrl+C zaustavlja petlju, kao u Fazi 2B.
    /// </summary>
    public static async Task Run(string baseUrl, string configPath = "agent.local.json", CancellationToken externalStop = default)
    {
        var credential = CredentialStore.Load()
            ?? throw new InvalidOperationException("Nema sačuvanog kredencijala — prvo pokreni: --pair <KOD>");

        AgentDatabase.EnsureInitialized();
        AgentDatabase.PruneAcked(TimeSpan.FromDays(7));

        AgentConfig? config = null;
        try { config = AgentConfig.Parse(File.ReadAllText(configPath)); }
        catch (Exception ex) { LogWarn($"{configPath} nije čitljiv/validan ({ex.Message}) — štampa je onemogućena dok se ne ispravi, poll/heartbeat i dalje rade."); }

        LogInfo($"Pokrećem agenta v{AgentVersion.Current}, stanica={config?.Station ?? "(nepoznato)"}.");
        LogInfo("Pomirenje sa serverom pre nastavka (nerešeni lokalni pokušaji, ako ih ima) ...");
        await ReconcileOnStartup(baseUrl, credential);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(externalStop);
        if (!externalStop.CanBeCanceled)
        {
            // Konzolni CLI put (--run) — nema spoljašnjeg tokena; zadrži
            // Fazu 2B ponašanje (Ctrl+C). Pod servisom (externalStop
            // prosleđen) namerno se NE registruje ovaj handler — nema
            // konzole kojoj bi se prijavio, a spoljašnji token već pokriva
            // zaustavljanje.
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
        }
        LogInfo("Pokrećem poll petlju. Ctrl+C za bezbedan izlazak.");

        var pollIntervalMs = ActivePollMs;
        var lastJobAtUtc = DateTime.UtcNow;
        var lastHeartbeatAtUtc = DateTime.MinValue;

        while (!cts.IsCancellationRequested)
        {
            if (DateTime.UtcNow - lastHeartbeatAtUtc >= HeartbeatInterval)
            {
                await SendHeartbeat(baseUrl, credential, config);
                lastHeartbeatAtUtc = DateTime.UtcNow;
            }

            PolledJob? job = null;
            try { job = await DeliveryClient.Poll(baseUrl, credential); }
            catch (HttpRequestException ex) { LogWarn($"Poll mrežna greška (nastavljam): {ex.Message}"); }

            if (job is not null)
            {
                await HandleJob(baseUrl, credential, config, job);
                pollIntervalMs = ActivePollMs;
                lastJobAtUtc = DateTime.UtcNow;
                continue; // odmah proveri ima li još — bez čekanja
            }

            var idleFor = DateTime.UtcNow - lastJobAtUtc;
            pollIntervalMs = idleFor < IdleBackoffAfter ? ActivePollMs : Math.Min(MaxIdlePollMs, pollIntervalMs + 250);
            try { await Task.Delay(pollIntervalMs, cts.Token); } catch (OperationCanceledException) { break; }
        }
        LogInfo("Zaustavljeno.");
    }

    private static async Task SendHeartbeat(string baseUrl, string credential, AgentConfig? config)
    {
        bool? printerAvailable = config is null ? null : WindowsPrinter.Enumerate().Contains(config.PrinterName, StringComparer.Ordinal);
        if (printerAvailable == false) LogWarn($"Konfigurisan štampač \"{config?.PrinterName}\" trenutno nije dostupan na ovom računaru.");
        DeliveryClient.HeartbeatOutcome outcome;
        try
        {
            outcome = await DeliveryClient.Heartbeat(
                baseUrl, credential,
                agentVersion: AgentVersion.Current,
                osDescription: Environment.OSVersion.VersionString,
                configuredPrinterName: config?.PrinterName,
                paperWidthMm: config?.PaperWidthMm,
                printerAvailable: printerAvailable);
        }
        catch (HttpRequestException ex) { LogWarn($"Heartbeat mrežna greška (nastavljam): {ex.Message}"); return; }

        if (outcome.TestPrintRequested) await HandleTestPrintRequest(baseUrl, credential, config);
    }

    /// <summary>
    /// Faza 2C — Admin "Test Print" dugme. NAMERNO potpuno van
    /// AgentDatabase/PrintJob puta — nema jobId/attemptId, nema
    /// claim/start/reconcile, nikad ne dotiče Order/Payment. Ako je
    /// štampač nepoznat/nedostupan, prijavljujemo FAILED umesto da tiho
    /// preskočimo — Admin panel mora videti STVARAN ishod.
    /// </summary>
    private static async Task HandleTestPrintRequest(string baseUrl, string credential, AgentConfig? config)
    {
        LogInfo("Test Print zatražen preko Admin panela — štampam lokalno.");
        string status;
        string? error;
        if (config is null)
        {
            status = "FAILED";
            error = "Radna stanica nema podešen štampač/stanicu (agent.config.json).";
        }
        else if (!WindowsPrinter.Enumerate().Contains(config.PrinterName, StringComparer.Ordinal))
        {
            status = "FAILED";
            error = $"Konfigurisan štampač \"{config.PrinterName}\" nije dostupan na ovom računaru.";
        }
        else
        {
            var ticket = Ticket.TestPrint(Environment.MachineName, config.Station, config.PrinterName, config.PaperWidthMm, AgentVersion.Current);
            var outcome = WindowsPrinter.Print(config, ticket, "test-" + Guid.NewGuid().ToString("N"));
            status = outcome.Status == "SUBMITTED_TO_SPOOLER" ? "SUCCEEDED" : "FAILED";
            error = outcome.Status == "SUBMITTED_TO_SPOOLER" ? null : (outcome.Error ?? outcome.Guarantee);
        }
        LogInfo($"Test Print ishod: {status}{(error is null ? "" : $" ({error})")}");
        try
        {
            var acked = await DeliveryClient.SubmitTestPrintResult(baseUrl, credential, status, error);
            if (!acked) LogWarn("Server je odbio prijavu ishoda test štampe (biće ponovljeno na sledećem heartbeat-u ako je zahtev i dalje PENDING).");
        }
        catch (HttpRequestException ex) { LogWarn($"Prijava ishoda test štampe nije uspela (mreža): {ex.Message}"); }
    }

    private static async Task HandleJob(string baseUrl, string credential, AgentConfig? config, PolledJob job)
    {
        var payloadHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(job.Content.GetRawText())));
        AgentDatabase.RecordReceived(job.JobId, job.AttemptId, payloadHash);
        // Bezbedno za log: jobId/attemptId/stanica su neprozirni identifikatori,
        // NIKAD sadržaj tiketa (ime gosta/stavke/napomene) — vidi AgentLog.cs.
        LogInfo($"Primljen tiket jobId={job.JobId} attemptId={job.AttemptId} stanica={job.Station}.");
        await ProcessReceivedJob(baseUrl, credential, config, job.JobId, job.AttemptId, job.Station, job.Content);
    }

    /// <summary>
    /// Deljeno između normalnog toka (HandleJob) i pomirenja pri
    /// pokretanju (ReconcileOnStartup, za redove još u stanju Received) —
    /// namerno JEDAN put od "zahtevaj dozvolu" do "prijavi ishod", nikad
    /// dva paralelna.
    /// </summary>
    private static async Task ProcessReceivedJob(string baseUrl, string credential, AgentConfig? config, string jobId, string attemptId, string station, JsonElement content)
    {
        bool started;
        try { started = await DeliveryClient.BeginSubmission(baseUrl, credential, jobId, attemptId); }
        catch (HttpRequestException ex) { LogWarn($"Start mrežna greška za jobId={jobId}: {ex.Message} — pokušaću ponovo na sledećem poll ciklusu/restartu."); return; }
        if (!started)
        {
            LogWarn($"Server je odbio dozvolu za početak slanja za jobId={jobId} (verovatno zastareo/već obrađen pokušaj) — odustajem od ovog pokušaja, NE štampam.");
            AgentDatabase.RecordAcked(jobId); // ništa više lokalno da se prati
            return;
        }
        AgentDatabase.RecordSubmissionStarted(jobId);

        if (config is null)
        {
            await ReportOutcome(baseUrl, credential, jobId, attemptId, "FAILED_BEFORE_SUBMISSION", "agent.local.json nije podešen/čitljiv — štampač nepoznat.");
            return;
        }
        if (station != config.Station)
        {
            await ReportOutcome(baseUrl, credential, jobId, attemptId, "FAILED_BEFORE_SUBMISSION",
                $"Stanica servera ({station}) se ne poklapa sa lokalnom konfiguracijom ({config.Station}) — proveri uparivanje/agent.local.json.");
            return;
        }
        if (!WindowsPrinter.Enumerate().Contains(config.PrinterName, StringComparer.Ordinal))
        {
            // Zahtev specifikacije: NIKAD tiho ne biraj drugi štampač.
            LogWarn($"Konfigurisan štampač \"{config.PrinterName}\" nije dostupan — jobId={jobId} NE šalje se na štampu.");
            await ReportOutcome(baseUrl, credential, jobId, attemptId, "FAILED_BEFORE_SUBMISSION",
                $"Konfigurisan štampač \"{config.PrinterName}\" nije dostupan na ovom računaru.");
            return;
        }

        var (ticket, paperWidthMm, _) = TicketPayload.Parse(content);
        var effectiveConfig = config with { PaperWidthMm = paperWidthMm is 58 or 80 ? paperWidthMm : config.PaperWidthMm };

        // Poslednji upis PRE nepovratnog koraka — ako proces padne TAČNO
        // unutar WindowsPrinter.Print poziva ispod, restart MORA videti da
        // je štampa MOGLA biti pokrenuta i NIKAD sam ne pokušava ponovo
        // (vidi ReconcileOnStartup, stanje PrintInvoked -> SUBMISSION_UNKNOWN).
        AgentDatabase.RecordPrintInvoked(jobId);
        var outcome = WindowsPrinter.Print(effectiveConfig, ticket, jobId);
        var mappedStatus = outcome.Status == "PREFLIGHT_ONLY" ? "SUBMISSION_UNKNOWN" : outcome.Status;
        AgentDatabase.RecordResultKnown(jobId, mappedStatus, outcome.Error);
        LogInfo($"Ishod za jobId={jobId}: {mappedStatus}{(outcome.Error is null ? "" : $" ({outcome.Error})")}");

        await ReportOutcome(baseUrl, credential, jobId, attemptId, mappedStatus, outcome.Error);
    }

    /// <summary>Svaki pozivalac VEĆ ima red u stanju Received ili kasnijem
    /// (HandleJob ga upisuje pre bilo čega drugog; ReconcileOnStartup ga
    /// nasleđuje iz GetUnresolved) — ovde se samo ažurira/prijavljuje.</summary>
    private static async Task ReportOutcome(string baseUrl, string credential, string jobId, string attemptId, string outcome, string? errorMessage)
    {
        AgentDatabase.RecordResultKnown(jobId, outcome, errorMessage);
        try
        {
            var acked = await DeliveryClient.SubmitResult(baseUrl, credential, jobId, attemptId, outcome, errorMessage);
            if (acked) AgentDatabase.RecordAcked(jobId);
            else LogWarn($"Server je odbio ishod za jobId={jobId} (zastareo/sukobljen attempt) — ostaje lokalno kao nerešeno za sledeće pomirenje, NE štampam ponovo.");
        }
        catch (HttpRequestException ex)
        {
            LogWarn($"Prijava ishoda za jobId={jobId} nije uspela (mreža): {ex.Message} — ostaje lokalno, pokušaću ponovo na sledećem pokretanju/pomirenju.");
        }
    }

    /// <summary>
    /// Pokreće se PRE bilo kog poll-a. Za svaki nerešen lokalni red:
    /// - Received (start nikad potvrđen): pokušaj ponovo od start koraka.
    /// - SubmissionStarted ILI PrintInvoked (nepoznato da li je Print()
    ///   uopšte pozvan/završen): NIKAD ponovo ne štampaj — prijavi
    ///   SUBMISSION_UNKNOWN, iskreno "ne znamo", isto kao serverov
    ///   sopstveni 90s timeout za ISTU situaciju.
    /// - ResultKnown (ishod poznat lokalno, ACK nije potvrđen): pošalji
    ///   ISTI poznat ishod ponovo (idempotentno na server strani).
    /// </summary>
    private static async Task ReconcileOnStartup(string baseUrl, string credential)
    {
        var unresolved = AgentDatabase.GetUnresolved();
        if (unresolved.Count == 0) { LogInfo("Nema nerešenih lokalnih pokušaja."); return; }

        LogInfo($"Pomirenje: {unresolved.Count} nerešen(ih) lokalnih pokušaja pri pokretanju.");
        foreach (var attempt in unresolved)
        {
            LogInfo($"Pomirujem jobId={attempt.JobId} (stanje {attempt.State}) ...");
            switch (attempt.State)
            {
                case AttemptState.Received:
                    var started = await DeliveryClient.BeginSubmission(baseUrl, credential, attempt.JobId, attempt.AttemptId);
                    if (!started)
                    {
                        LogInfo($"  jobId={attempt.JobId}: server ne dozvoljava nastavak (zastareo pokušaj) — napušteno, NE štampam.");
                        AgentDatabase.RecordAcked(attempt.JobId);
                        break;
                    }
                    AgentDatabase.RecordSubmissionStarted(attempt.JobId);
                    // Bez lokalno sačuvanog sadržaja tiketa u ovoj tabeli
                    // (namerno — vidi AgentDatabase.cs) ne možemo bezbedno
                    // nastaviti do štampe odavde; sledeći redovan poll
                    // ciklus neće ponovo ponuditi OVAJ red (server ga sada
                    // vidi kao PRINTING/started), pa ga eksplicitno
                    // prijavljujemo kao SUBMISSION_UNKNOWN — isto pravilo
                    // kao ambiguozan restart posle starta.
                    await ReportOutcome(baseUrl, credential, attempt.JobId, attempt.AttemptId, "SUBMISSION_UNKNOWN",
                        "Agent je restartovan neposredno posle claim-a, pre nego što je sadržaj tiketa lokalno sačuvan.");
                    break;

                case AttemptState.SubmissionStarted:
                case AttemptState.PrintInvoked:
                    await ReportOutcome(baseUrl, credential, attempt.JobId, attempt.AttemptId, "SUBMISSION_UNKNOWN",
                        "Agent je restartovan posle dozvole za slanje, pre nego što je lokalni ishod poznat — fizička štampa nije ponovo pokušana.");
                    break;

                case AttemptState.ResultKnown:
                    var acked = await DeliveryClient.SubmitResult(baseUrl, credential, attempt.JobId, attempt.AttemptId, attempt.Result!, attempt.ErrorMessage);
                    if (acked) AgentDatabase.RecordAcked(attempt.JobId);
                    else LogInfo($"  jobId={attempt.JobId}: server i dalje odbija ACK (zastareo/sukobljen) — ostaje za sledeće pomirenje.");
                    break;

                case AttemptState.Acked:
                    break; // GetUnresolved već isključuje ovo — odbrambeno
            }
        }
    }

    // Faza 2C, sekcija 3/12 — SVAKA log poruka u ovom fajlu prolazi kroz
    // OVO dvoje mesto: i na konzolu (--run CLI/dev put, nepromenjeno od
    // Faze 2B) i u trajan agent.log preko AgentLog.cs (servis nema konzolu
    // koju bi iko gledao). NIKAD ne prosleđivati sirov kredencijal/kod za
    // uparivanje ovamo — pozivaoci iznad namerno prosleđuju SAMO jobId/
    // attemptId/stanicu/status/bezopasne poruke o grešci, nikad sadržaj
    // tiketa ili kredencijal (vidi AgentLog.cs za punu listu zabrana).
    private static void LogInfo(string message)
    {
        Console.WriteLine(message);
        AgentLog.Info(message);
    }

    private static void LogWarn(string message)
    {
        Console.Error.WriteLine(message);
        AgentLog.Warn(message);
    }
}

/// <summary>
/// Faza 2C, sekcija 7 — jasno, korisnički-vidljivo verzionisanje proizvoda
/// (ne interna faza-po-faza oznaka kao ranije "2.0.0-phase2b"). Agent
/// prijavljuje ovu vrednost preko heartbeat-a (DeliveryClient.Heartbeat);
/// Admin je prikazuje uz radnu stanicu. MORA se poklapati sa
/// MyAppVersion u installer/TableCorePrintAgent.iss pri svakom objavljivanju.
/// </summary>
public static class AgentVersion
{
    public const string Current = "1.0.0-pilot.1";
}
