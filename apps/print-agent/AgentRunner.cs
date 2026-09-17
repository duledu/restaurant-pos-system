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
        // Physical QA follow-up (broken re-pair UX investigation) — the
        // credential was previously read ONCE here at startup, never again,
        // so re-pairing this machine via Setup (SetupForm.OnPair/CredentialStore.Save)
        // while THIS service process was already running had no effect
        // until a manual service restart or reboot: the running loop kept
        // heartbeating with the OLD (possibly just-revoked) credential
        // indefinitely, even though a valid new one already existed on
        // disk. Same hot-reload convention as agent.config.json below
        // (cheap last-write-time poll on the existing 1-3s cycle, no new
        // package/FileSystemWatcher) — "reconnect, heartbeat, Admin sees
        // the newly paired computer" now happens within one poll interval
        // of clicking "Poveži ponovo", no restart required.
        var credentialLastWriteUtc = File.Exists(AgentPaths.CredentialFilePath)
            ? File.GetLastWriteTimeUtc(AgentPaths.CredentialFilePath)
            : DateTime.MinValue;

        AgentDatabase.EnsureInitialized();
        AgentDatabase.PruneAcked(TimeSpan.FromDays(7));

        AgentConfig? config = null;
        var configLastWriteUtc = DateTime.MinValue;
        try
        {
            var raw = File.ReadAllText(configPath);
            var (parsed, migratedFromLegacy) = AgentConfig.ParseWithLegacyFallback(raw);
            config = parsed;
            configLastWriteUtc = File.GetLastWriteTimeUtc(configPath);
            if (migratedFromLegacy)
            {
                // Printing V2 upgrade path — the previous build wrote one flat
                // {station,printerName,paperWidthMm}; converted in-memory to a
                // one-route list and persisted back in the new shape so this
                // machine keeps printing with NO re-pairing/reinstall. The
                // next successful poll/heartbeat still reconciles against
                // whatever Admin has actually configured server-side.
                LogInfo("Stara konfiguracija (jedna stanica/štampač) automatski pretvorena u novi format ruta.");
                PersistConfig(configPath, config);
                configLastWriteUtc = File.GetLastWriteTimeUtc(configPath);
            }
        }
        catch (Exception ex) { LogWarn($"{configPath} nije čitljiv/validan ({ex.Message}) — štampa je onemogućena dok se ne ispravi, poll/heartbeat i dalje rade."); }

        LogInfo($"Pokrećem agenta v{AgentVersion.Current}, rute={(config is null ? "(nepoznato)" : string.Join(", ", config.Routes.Select(r => r.Type)))}.");
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
            // PREPROD physical QA follow-up (Print Agent Setup UX, Part A1)
            // — config je RANIJE učitan TAČNO JEDNOM ovde pri pokretanju;
            // Setup ekran (SetupForm.cs OnSave) upisuje agent.local.json u
            // svakom trenutku dok je servis već pokrenut, pa je "Sačuvano.
            // Servis će koristiti nova podešavanja u sledećem poll ciklusu"
            // poruka ranije bila NETAČNA (servis ga stvarno nikad nije
            // ponovo pročitao bez restarta). Jeftina provera vremena
            // poslednje izmene (bez novog paketa/FileSystemWatcher-a) na
            // POSTOJEĆOJ 1-3s poll petlji — poll/claim/print tok ispod je
            // NEPROMENJEN, menja se SAMO odakle `config` promenljiva dobija
            // vrednost.
            // Safety-net manual-edit reload — normally routes come from the
            // server (below), but if support/an admin manually edits
            // agent.config.json on the box, pick it up without a restart.
            if (File.Exists(configPath))
            {
                try
                {
                    var writeUtc = File.GetLastWriteTimeUtc(configPath);
                    if (writeUtc != configLastWriteUtc)
                    {
                        config = AgentConfig.Parse(File.ReadAllText(configPath));
                        configLastWriteUtc = writeUtc;
                        LogInfo($"Nova konfiguracija učitana sa diska (rute={string.Join(", ", config.Routes.Select(r => r.Type))}).");
                    }
                }
                catch (Exception ex) { LogWarn($"{configPath} nije čitljiv/validan posle izmene ({ex.Message}) — zadržavam prethodnu konfiguraciju."); }
            }

            // Credential hot-reload — see comment at Run()'s top for why
            // this exists. A missing/unreadable file here (mid-write race,
            // or CredentialStore.Clear() during an uninstall running
            // concurrently) is handled the same defensive way as config:
            // keep using the last known-good in-memory value rather than
            // crashing the loop.
            if (File.Exists(AgentPaths.CredentialFilePath))
            {
                try
                {
                    var credWriteUtc = File.GetLastWriteTimeUtc(AgentPaths.CredentialFilePath);
                    if (credWriteUtc != credentialLastWriteUtc)
                    {
                        var reloaded = CredentialStore.Load();
                        credentialLastWriteUtc = credWriteUtc;
                        if (reloaded is not null && reloaded != credential)
                        {
                            credential = reloaded;
                            LogInfo("Novi kredencijal učitan (radna stanica je ponovo uparena) — agent se odmah povezuje sa novim identitetom.");
                        }
                    }
                }
                catch (Exception ex) { LogWarn($"Kredencijal nije čitljiv posle izmene ({ex.Message}) — zadržavam prethodni."); }
            }

            if (DateTime.UtcNow - lastHeartbeatAtUtc >= HeartbeatInterval)
            {
                var heartbeatOutcome = await SendHeartbeat(baseUrl, credential, config);
                if (heartbeatOutcome is { Success: true })
                {
                    config = ApplyServerRoutes(configPath, config, heartbeatOutcome.Routes, ref configLastWriteUtc);
                    if (heartbeatOutcome.TestPrintRequested) await HandleTestPrintRequest(baseUrl, credential, config, heartbeatOutcome.TestPrintRoute);
                }
                lastHeartbeatAtUtc = DateTime.UtcNow;
            }

            PollOutcome? poll = null;
            try { poll = await DeliveryClient.Poll(baseUrl, credential); }
            catch (HttpRequestException ex) { LogWarn($"Poll mrežna greška (nastavljam): {ex.Message}"); }

            if (poll is not null)
            {
                // Printing V2 — routes are server-authoritative; sync down on
                // EVERY successful poll (1-3s), not just the slower 25s
                // heartbeat, so an Admin route change (new printer, disabled
                // route) takes effect almost immediately, same latency class
                // as the existing Test Print fast-path below.
                config = ApplyServerRoutes(configPath, config, poll.Routes, ref configLastWriteUtc);

                // Faza 2C follow-up — Test Print se SADA otkriva i preko OVOG
                // brzog (1-3s) poll ciklusa, ne samo preko 25s heartbeat-a ispod
                // (SendHeartbeat i dalje nezavisno nosi isti signal — namerno
                // NEPROMENJENO, ovo je dodatan brži put, ne zamena). Dokazan
                // uzrok ~19s kašnjenja u PREPROD fizičkom testu: Test Print je
                // ranije čekao ISKLJUČIVO sledeći heartbeat. HandleTestPrintRequest
                // ostaje idempotentno na isti način kao pre (server prebacuje
                // testPrintStatus sa PENDING čim se prvi pokušaj prijavi, pa
                // sledeći poll/heartbeat u ISTOM ciklusu više ne vidi PENDING).
                if (poll.TestPrintRequested) await HandleTestPrintRequest(baseUrl, credential, config, poll.TestPrintRoute);

                if (poll.Job is not null)
                {
                    await HandleJob(baseUrl, credential, config, poll.Job);
                    pollIntervalMs = ActivePollMs;
                    lastJobAtUtc = DateTime.UtcNow;
                    continue; // odmah proveri ima li još — bez čekanja
                }
            }

            var idleFor = DateTime.UtcNow - lastJobAtUtc;
            pollIntervalMs = idleFor < IdleBackoffAfter ? ActivePollMs : Math.Min(MaxIdlePollMs, pollIntervalMs + 250);
            try { await Task.Delay(pollIntervalMs, cts.Token); } catch (OperationCanceledException) { break; }
        }
        LogInfo("Zaustavljeno.");
    }

    /// <summary>
    /// Printing V2 — routes come DOWN from the server on every successful
    /// poll/heartbeat (see workstation-service.ts getAgentRoutes); this is
    /// the ONLY place the agent ever writes agent.config.json going
    /// forward (Setup no longer authors routes). No-ops if the reported set
    /// is identical to what's already on disk, so a normal 1-3s poll cycle
    /// does not thrash the file/log when nothing changed.
    /// </summary>
    private static AgentConfig? ApplyServerRoutes(string configPath, AgentConfig? current, IReadOnlyList<AgentRouteInfo> serverRoutes, ref DateTime configLastWriteUtc)
    {
        if (RoutesMatch(current?.Routes, serverRoutes)) return current;
        var routes = serverRoutes.Select(r => new PrintRoute(r.Type, r.PrinterName, r.PaperWidthMm)).ToArray();
        if (routes.Length == 0)
        {
            LogInfo("Server ne izveštava nijednu podešenu rutu štampe za ovaj računar — štampa je onemogućena dok se rute ne podese u Admin panelu.");
            try { if (File.Exists(configPath)) File.Delete(configPath); } catch (Exception ex) { LogWarn($"Brisanje {configPath} nije uspelo: {ex.Message}"); }
            configLastWriteUtc = DateTime.MinValue;
            return null;
        }
        var next = new AgentConfig(routes);
        LogInfo($"Rute štampe ažurirane sa servera: {string.Join(", ", routes.Select(r => $"{r.Type}->{r.PrinterName}({r.PaperWidthMm}mm)"))}.");
        PersistConfig(configPath, next);
        configLastWriteUtc = File.GetLastWriteTimeUtc(configPath);
        return next;
    }

    private static bool RoutesMatch(PrintRoute[]? local, IReadOnlyList<AgentRouteInfo> server)
    {
        var localArr = local ?? [];
        if (localArr.Length != server.Count) return false;
        var localSorted = localArr.OrderBy(r => r.Type, StringComparer.Ordinal).ToArray();
        var serverSorted = server.OrderBy(r => r.Type, StringComparer.Ordinal).ToArray();
        for (var i = 0; i < localSorted.Length; i++)
        {
            if (localSorted[i].Type != serverSorted[i].Type
                || localSorted[i].PrinterName != serverSorted[i].PrinterName
                || localSorted[i].PaperWidthMm != serverSorted[i].PaperWidthMm)
                return false;
        }
        return true;
    }

    /// <summary>Same atomic temp-file-then-move pattern the old SetupForm.OnSave
    /// used — write beside the target, then move over it, so a reader never
    /// observes a half-written file.</summary>
    private static void PersistConfig(string configPath, AgentConfig config)
    {
        var tempPath = configPath + ".tmp";
        File.WriteAllText(tempPath, config.ToJson());
        File.Move(tempPath, configPath, overwrite: true);
    }

    private static async Task<DeliveryClient.HeartbeatOutcome?> SendHeartbeat(string baseUrl, string credential, AgentConfig? config)
    {
        var installedPrinters = WindowsPrinter.Enumerate();
        // PRINTING P0 — `visible` is the pre-attempt Service-side
        // visibility probe (currently identical to `printerAvailable`
        // because both are computed by the same WindowsPrinter.Enumerate()
        // check, but the two columns travel separately so future Agent
        // builds can keep them distinct — e.g. a future agent could probe
        // before Print() using a stricter access check than Print() itself
        // uses). The `null` case below is "printerName not configured
        // yet, nothing to probe against" — server keeps the previous
        // value rather than overwriting with `false`.
        var routeAvailability = (config?.Routes ?? [])
            .Select(r =>
            {
                bool installed = installedPrinters.Contains(r.PrinterName, StringComparer.Ordinal);
                return new RoutePrinterAvailability(
                    Type: r.Type,
                    PrinterAvailable: installed,
                    VisibleToService: string.IsNullOrEmpty(r.PrinterName) ? (bool?)null : installed
                );
            })
            .ToArray();
        foreach (var r in routeAvailability.Where(r => !r.PrinterAvailable))
            LogWarn($"Konfigurisan štampač za rutu {r.Type} trenutno nije dostupan na ovom računaru.");
        try
        {
            return await DeliveryClient.Heartbeat(
                baseUrl, credential,
                agentVersion: AgentVersion.Current,
                osDescription: Environment.OSVersion.VersionString,
                availablePrinters: installedPrinters,
                routes: routeAvailability);
        }
        catch (HttpRequestException ex) { LogWarn($"Heartbeat mrežna greška (nastavljam): {ex.Message}"); return null; }
    }

    /// <summary>
    /// Faza 2C — Admin "Test Print" dugme. NAMERNO potpuno van
    /// AgentDatabase/PrintJob puta — nema jobId/attemptId, nema
    /// claim/start/reconcile, nikad ne dotiče Order/Payment. Ako je
    /// štampač nepoznat/nedostupan, prijavljujemo FAILED umesto da tiho
    /// preskočimo — Admin panel mora videti STVARAN ishod.
    ///
    /// Printing V2 — <paramref name="routeType"/> bira KOJU rutu (i time koji
    /// lokalno konfigurisan štampač/širinu) testirati, jer jedan agent sad
    /// može imati više različitih štampača.
    /// </summary>
    private static async Task HandleTestPrintRequest(string baseUrl, string credential, AgentConfig? config, string? routeType)
    {
        LogInfo($"Test Print zatražen preko Admin panela (ruta={routeType ?? "?"}) — štampam lokalno.");
        string status;
        string? error;
        var route = routeType is null ? null : config?.RouteFor(routeType);
        if (routeType is null)
        {
            status = "FAILED";
            error = "Server nije naveo koju rutu treba testirati.";
        }
        else if (route is null)
        {
            status = "FAILED";
            error = $"Ruta {routeType} nije lokalno podešena na ovom računaru (agent.config.json).";
        }
        else if (!WindowsPrinter.Enumerate().Contains(route.PrinterName, StringComparer.Ordinal))
        {
            status = "FAILED";
            error = $"Konfigurisan štampač \"{route.PrinterName}\" nije dostupan na ovom računaru.";
        }
        else
        {
            // RECEIPT RENDERING POLISH — a RECEIPT-route Test Print must
            // validate the REAL receipt renderer (TicketPayload.ParseReceipt's
            // shared body), not the generic diagnostic ticket used for
            // KITCHEN/BAR — see TicketPayload.BuildReceiptTestPrintTicket.
            // KITCHEN/BAR Test Print is intentionally unchanged.
            var ticket = route.Type == "RECEIPT"
                ? TicketPayload.BuildReceiptTestPrintTicket(Environment.MachineName, route.PrinterName, route.PaperWidthMm, AgentVersion.Current)
                : Ticket.TestPrint(Environment.MachineName, route.Type, route.PrinterName, route.PaperWidthMm, AgentVersion.Current);
            var outcome = WindowsPrinter.Print(route, ticket, "test-" + Guid.NewGuid().ToString("N"));
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
    ///
    /// Printing V2 — `station` iz servera je zapravo PrintJob.type (KITCHEN/
    /// BAR/RECEIPT — RECEIPT je sad podržan), i bira se odgovarajuća lokalna
    /// PrintRoute iz config.Routes po tipu umesto poređenja sa jednom
    /// globalnom stanicom. Server već ograničava koje tipove ovaj agent uopšte
    /// vidi (samo tipovi njegovih omogućenih ruta — agent-print-service.ts
    /// pollAndClaim), ali agent NIKAD ne veruje slepo serveru za stvaran
    /// fizički efekat — ista odbrana u dubinu kao pre.
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
            await ReportOutcome(baseUrl, credential, jobId, attemptId, "FAILED_BEFORE_SUBMISSION", "agent.config.json nije podešen/čitljiv — nijedna ruta štampe nije konfigurisana.");
            return;
        }
        var route = config.RouteFor(station);
        if (route is null)
        {
            await ReportOutcome(baseUrl, credential, jobId, attemptId, "FAILED_BEFORE_SUBMISSION",
                $"Ruta servera ({station}) nije lokalno podešena na ovom računaru — proveri Admin panel/agent.config.json.");
            return;
        }
        if (!WindowsPrinter.Enumerate().Contains(route.PrinterName, StringComparer.Ordinal))
        {
            // Zahtev specifikacije: NIKAD tiho ne biraj drugi štampač.
            LogWarn($"Konfigurisan štampač \"{route.PrinterName}\" nije dostupan — jobId={jobId} NE šalje se na štampu.");
            await ReportOutcome(baseUrl, credential, jobId, attemptId, "FAILED_BEFORE_SUBMISSION",
                $"Konfigurisan štampač \"{route.PrinterName}\" nije dostupan na ovom računaru.");
            return;
        }

        // PREPROD physical root cause (real receipt #425, POS-58 — "Driver
        // printable area is too small for this ticket.") — this USED to
        // build an `effectiveRoute` that let the server-embedded ticket
        // content's own `paperWidthMm` silently REPLACE this Agent's own
        // locally-configured, Admin-verified, printer-matching
        // route.PaperWidthMm whenever the server's value was merely a valid
        // NUMBER (58 or 80) — never checking whether it actually matched
        // what THIS printer/paper roll is physically loaded with. A
        // server-side bug (since fixed — see print-service.ts
        // dispatchReceiptPrintJob) once froze a RECEIPT ticket's content at
        // 80mm for a restaurant whose real RECEIPT route is 58mm; this
        // override then discarded the Agent's correct local 58mm and tried
        // to print an 80mm-wide page on a driver bound to a 58mm roll —
        // exactly reproduced in SelfTests.cs against a real installed
        // driver. `route.PaperWidthMm` (this computer's own Admin-configured
        // value, validated at pairing/route-save time to match an actual
        // printer) is the ONLY width ever used now — "agent NIKAD ne veruje
        // slepo serveru za stvaran fizički efekat" already applies to
        // printer NAME above; it now applies to paper width too. The parsed
        // `_` (server's own paperWidthMm hint) is intentionally unused —
        // TicketRaster measures/wraps the ticket's lines for WHATEVER width
        // is actually passed to WindowsPrinter.Print below, so this is fully
        // self-consistent regardless of what the server happened to embed.
        var (ticket, _, _) = TicketPayload.Parse(content);

        // Poslednji upis PRE nepovratnog koraka — ako proces padne TAČNO
        // unutar WindowsPrinter.Print poziva ispod, restart MORA videti da
        // je štampa MOGLA biti pokrenuta i NIKAD sam ne pokušava ponovo
        // (vidi ReconcileOnStartup, stanje PrintInvoked -> SUBMISSION_UNKNOWN).
        AgentDatabase.RecordPrintInvoked(jobId);
        var outcome = WindowsPrinter.Print(route, ticket, jobId);
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
    public const string Current = "1.0.0-pilot.9";
}
