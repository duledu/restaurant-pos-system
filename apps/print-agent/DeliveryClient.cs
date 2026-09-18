using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TableCore.PrintAgent;

public sealed record PolledJob(string JobId, string AttemptId, string Station, JsonElement Content);

/// <summary>
/// Printing V2 — a route as the SERVER currently sees it (only fully
/// configured routes: real printer name + paper width — see
/// workstation-service.ts getAgentRoutes, which never reports a route with
/// no printer chosen yet). This is the payload AgentRunner persists locally
/// (agent.config.json) so the agent survives offline restarts with its
/// last-known-good routes.
/// </summary>
public sealed record AgentRouteInfo(string Type, string PrinterName, int PaperWidthMm);

/// <summary>Per-route local printer availability, reported UP to the server
/// on heartbeat — a single boolean is no longer enough once one agent can
/// have several different printers.
///
/// PRINTING P0 — adds the pre-attempt visibility probe (`VisibleToService`):
/// whether the running Service identity (NT SERVICE\TableCorePrintAgent)
/// can enumerate this route's printerName RIGHT NOW, distinct from the
/// post-attempt `printerAvailable` (which only updates after the last
/// real print attempt). The Setup wizard reads VisibleToService via the
/// heartbeat response BEFORE the operator ever runs the wizard's own
/// local "Test Print", so it can surface a clear human-friendly error
/// instead of letting the operator discover a per-user-vs-per-machine
/// driver install on their first real order.</summary>
public sealed record RoutePrinterAvailability(string Type, bool PrinterAvailable, bool? VisibleToService);

/// <summary>
/// `TestPrintRequested`/`TestPrintRoute` are carried alongside `job` on
/// /api/agent/poll (server: apps/web/app/api/agent/poll/route.ts) so Admin
/// "Test Print" uses the SAME fast (1-3s) cycle as real tickets instead of
/// waiting up to 25s for a heartbeat — see AgentRunner.cs. `Routes` is the
/// server-authoritative route list for THIS workstation; empty means no
/// routes are configured (or all have been disabled/cleared) — persisted
/// locally exactly as reported, never invented/kept stale by the agent.
/// </summary>
public sealed record PollOutcome(PolledJob? Job, bool TestPrintRequested, string? TestPrintRoute, IReadOnlyList<AgentRouteInfo> Routes);

/// <summary>PRINTING P0 — per-route readiness view returned alongside
/// `routes` on heartbeat. The Setup wizard reads this to decide whether
/// to declare READY in a single round-trip (see workstation-service.ts
/// getRouteReadinessForAgent for the aggregation rules). Backwards-
/// compatible: older servers that don't return `routeReadiness` produce
/// an empty list, and the wizard falls back to its in-process probe
/// before declaring READY.</summary>
public sealed record AgentRouteReadiness(
    string Type,
    string PrinterName,
    int PaperWidthMm,
    bool? VisibleToService,
    bool PhysicalTestConfirmed,
    string Readiness // "READY" | "AGENT_CANNOT_SEE" | "PENDING_PROBE" | "NEEDS_CONFIRM"
);

/// <summary>
/// Faza 2B — HTTP klijent za autentifikovanu isporuku (poll/start/result) i
/// heartbeat. Agent ISKLJUČIVO inicira odlazeće HTTPS zahteve — server
/// nikad ne zove agenta, nema ulaznih portova na restoranskoj mreži, nema
/// oslanjanja na browser/QZ/localhost most.
/// </summary>
public static class DeliveryClient
{
    private static readonly HttpClient Http = new();

    /// <summary>
    /// Pozvano TAČNO JEDNOM, odmah posle AgentEndpoint.Resolve — vidi
    /// AgentEndpoint.ConfigureHttpClientDefaults i PairingClient.ConfigureBypassHeader
    /// za pun razlog. No-op u Production režimu.
    /// </summary>
    public static void ConfigureBypassHeader(AgentEndpoint endpoint) => endpoint.ConfigureHttpClientDefaults(Http);

    // Izostavlja null polja iz JSON tela (a ne "polje": null) — zod šeme na
    // serveru (packages/shared/workstation-schemas.ts) koriste `.optional()`
    // (odsutan ključ), ne `.nullable()` (eksplicitna null vrednost) — slanje
    // eksplicitnog null-a bi ta polja odbilo kao pogrešan tip.
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static HttpRequestMessage AuthedRequest(HttpMethod method, string baseUrl, string path, string credential)
    {
        var request = new HttpRequestMessage(method, $"{baseUrl}{path}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        return request;
    }

    private static IReadOnlyList<AgentRouteInfo> ParseRoutes(JsonElement root)
    {
        if (!root.TryGetProperty("routes", out var routesEl) || routesEl.ValueKind != JsonValueKind.Array) return [];
        var list = new List<AgentRouteInfo>();
        foreach (var r in routesEl.EnumerateArray())
        {
            if (r.ValueKind != JsonValueKind.Object) continue;
            if (!r.TryGetProperty("type", out var t) || !r.TryGetProperty("printerName", out var p) || !r.TryGetProperty("paperWidthMm", out var w)) continue;
            if (t.ValueKind != JsonValueKind.String || p.ValueKind != JsonValueKind.String || w.ValueKind != JsonValueKind.Number) continue;
            list.Add(new AgentRouteInfo(t.GetString()!, p.GetString()!, w.GetInt32()));
        }
        return list;
    }

    private static IReadOnlyList<AgentRouteReadiness> ParseRouteReadiness(JsonElement root)
    {
        // PRINTING P0 — optional field; older servers (pre-P0) won't
        // return it. Empty list is the safe fallback: the Setup wizard
        // falls back to its own in-process probe (and refuses to declare
        // READY without confirmation) when the server is silent.
        if (!root.TryGetProperty("routeReadiness", out var el) || el.ValueKind != JsonValueKind.Array) return [];
        var list = new List<AgentRouteReadiness>();
        foreach (var r in el.EnumerateArray())
        {
            if (r.ValueKind != JsonValueKind.Object) continue;
            if (!r.TryGetProperty("type", out var t) || !r.TryGetProperty("printerName", out var p) ||
                !r.TryGetProperty("paperWidthMm", out var w) || !r.TryGetProperty("readiness", out var rd)) continue;
            if (t.ValueKind != JsonValueKind.String || p.ValueKind != JsonValueKind.String ||
                w.ValueKind != JsonValueKind.Number || rd.ValueKind != JsonValueKind.String) continue;
            bool? visible = null;
            if (r.TryGetProperty("visibleToService", out var v))
            {
                if (v.ValueKind == JsonValueKind.True) visible = true;
                else if (v.ValueKind == JsonValueKind.False) visible = false;
            }
            bool physicalTestConfirmed = r.TryGetProperty("physicalTestConfirmed", out var pc) && pc.ValueKind == JsonValueKind.True;
            list.Add(new AgentRouteReadiness(
                Type: t.GetString()!,
                PrinterName: p.GetString()!,
                PaperWidthMm: w.GetInt32(),
                VisibleToService: visible,
                PhysicalTestConfirmed: physicalTestConfirmed,
                Readiness: rd.GetString()!));
        }
        return list;
    }

    private static string? ParseTestPrintRoute(JsonElement root) =>
        root.TryGetProperty("testPrintRoute", out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;

    public static async Task<PollOutcome> Poll(string baseUrl, string credential)
    {
        using var request = AuthedRequest(HttpMethod.Post, baseUrl, "/api/agent/poll", credential);
        request.Content = JsonContent.Create(new { }, options: JsonOptions);
        using var response = await Http.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStreamAsync());
        var root = doc.RootElement;
        var testPrintRequested = root.TryGetProperty("testPrintRequested", out var tp) && tp.ValueKind == JsonValueKind.True;
        var testPrintRoute = ParseTestPrintRoute(root);
        var routes = ParseRoutes(root);
        var jobEl = root.GetProperty("job");
        if (jobEl.ValueKind != JsonValueKind.Object) return new PollOutcome(null, testPrintRequested, testPrintRoute, routes);
        var job = new PolledJob(
            JobId: jobEl.GetProperty("jobId").GetString()!,
            AttemptId: jobEl.GetProperty("attemptId").GetString()!,
            Station: jobEl.GetProperty("station").GetString()!,
            Content: jobEl.GetProperty("content").Clone()
        );
        return new PollOutcome(job, testPrintRequested, testPrintRoute, routes);
    }

    /// <summary>"Upravo počinjem fizičku pošiljku" — MORA se pozvati (i
    /// uspeti) PRE WindowsPrinter.Print poziva, nikad posle.</summary>
    public static async Task<bool> BeginSubmission(string baseUrl, string credential, string jobId, string attemptId)
    {
        using var request = AuthedRequest(HttpMethod.Post, baseUrl, $"/api/agent/jobs/{jobId}/start", credential);
        request.Content = JsonContent.Create(new { attemptId }, options: JsonOptions);
        using var response = await Http.SendAsync(request);
        return response.IsSuccessStatusCode;
    }

    /// <summary>Idempotentno za IDENTIČAN ponovljen ishod istog attemptId-a
    /// (server strana, confirmPrintResult) — bezbedno pozvati ponovo posle
    /// restarta/mrežnog gubitka bez straha od duplog efekta.</summary>
    public static async Task<bool> SubmitResult(string baseUrl, string credential, string jobId, string attemptId, string outcome, string? errorMessage)
    {
        using var request = AuthedRequest(HttpMethod.Post, baseUrl, $"/api/agent/jobs/{jobId}/result", credential);
        request.Content = JsonContent.Create(new { attemptId, outcome, errorMessage }, options: JsonOptions);
        using var response = await Http.SendAsync(request);
        return response.IsSuccessStatusCode;
    }

    public sealed record HeartbeatOutcome(bool Success, bool TestPrintRequested, string? TestPrintRoute, IReadOnlyList<AgentRouteInfo> Routes, IReadOnlyList<AgentRouteReadiness> RouteReadiness);

    /// <summary>
    /// Printing V2 — capability report widened from "one configured printer
    /// name/width/availability" to (a) the FULL enumerated printer list
    /// (`availablePrinters`, so Admin can pick from a real dropdown) and (b)
    /// per-route printer availability (`routes`, since one agent can now
    /// have several different printers, one boolean no longer suffices).
    ///
    /// PRINTING P0 — each `routes` entry now also carries the
    /// pre-attempt visibility probe (`visible`) so the server can detect
    /// the per-user-vs-per-machine driver install failure mode before
    /// any real print attempt. The probe runs ON THE AGENT THREAD (it
    /// is just an in-process enum check against the existing Windows
    /// printer list cached from WindowsPrinter.Enumerate on Service
    /// startup), so it is essentially free.
    /// </summary>
    public static async Task<HeartbeatOutcome> Heartbeat(
        string baseUrl, string credential, string? agentVersion, string? osDescription,
        IReadOnlyList<string>? availablePrinters, IReadOnlyList<RoutePrinterAvailability>? routes)
    {
        using var request = AuthedRequest(HttpMethod.Post, baseUrl, "/api/agent/heartbeat", credential);
        request.Content = JsonContent.Create(
            new
            {
                agentVersion,
                osDescription,
                availablePrinters,
                routes = routes?.Select(r => new
                {
                    type = r.Type,
                    printerAvailable = r.PrinterAvailable,
                    // Null when the probe cannot run for this route
                    // (e.g. printerName not configured yet, so there is
                    // nothing to enumerate against) — preserved verbatim
                    // by the server's zod .nullable().optional().
                    visible = r.VisibleToService,
                }),
            },
            options: JsonOptions);
        using var response = await Http.SendAsync(request);
        if (!response.IsSuccessStatusCode) return new HeartbeatOutcome(false, false, null, [], []);
        try
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStreamAsync());
            var root = doc.RootElement;
            var testPrintRequested = root.TryGetProperty("testPrintRequested", out var el) && el.ValueKind == JsonValueKind.True;
            return new HeartbeatOutcome(
                true,
                testPrintRequested,
                ParseTestPrintRoute(root),
                ParseRoutes(root),
                ParseRouteReadiness(root));
        }
        catch (JsonException)
        {
            // Odgovor bez validnog JSON tela i dalje znači "heartbeat je stigao"
            // (server je vratio uspešan status kod) — samo bez test-print/rute
            // ovog puta; ne tretiramo kao mrežnu grešku, i NIKAD ne brišemo
            // lokalno keširane rute zbog ovoga (vidi AgentRunner.ApplyServerRoutes
            // — primenjuje se samo kad je poziv STVARNO uspeo sa čitljivim telom).
            return new HeartbeatOutcome(true, false, null, [], []);
        }
    }

    /// <summary>PRINTING P0 — Setup wizard's HUMAN CONFIRMATION step. The
    /// operator pressed "Da, test tiket je uspešno odštampan" on the
    /// route inside the wizard; the Agent forwards that one signal up
    /// to the server so the route flips to physicalTestConfirmed=true.
    /// Idempotent: server returns the existing record on repeat calls.</summary>
    public static async Task<bool> ConfirmPhysicalTest(string baseUrl, string credential, string routeType)
    {
        using var request = AuthedRequest(HttpMethod.Post, baseUrl, $"/api/agent/routes/{routeType}/confirm-physical", credential);
        request.Content = JsonContent.Create(new { type = routeType }, options: JsonOptions);
        using var response = await Http.SendAsync(request);
        return response.IsSuccessStatusCode;
    }

    /// <summary>PRINTING P0 — Setup wizard's "IZABERI NAMENU" step.
    /// Persists the operator's choice of which Windows printer + paper
    /// width serves each route (KUHINJA / ŠANK / RAČUN) for THIS
    /// workstation. The server treats this as authoritative — Admin
    /// panels and the Agent's heartbeat route list read from the same
    /// rows. The Agent can ONLY write to its own workstation's routes
    /// (server-side scope check). Idempotent on the (workstation, type)
    /// unique constraint.</summary>
    public static async Task<bool> UpsertRouteAssignment(
        string baseUrl, string credential, string routeType,
        string? printerName, int? paperWidthMm, bool? isEnabled, bool? isPrimary)
    {
        using var request = AuthedRequest(HttpMethod.Put, baseUrl, $"/api/agent/routes/{routeType}/upsert", credential);
        request.Content = JsonContent.Create(new
        {
            type = routeType,
            printerName,
            paperWidthMm,
            isEnabled,
            isPrimary,
        }, options: JsonOptions);
        using var response = await Http.SendAsync(request);
        return response.IsSuccessStatusCode;
    }

    /// <summary>PRINTING P0 — Setup wizard's "no printer for this route"
    /// path. Removes the route entirely so the server stops emitting
    /// it in heartbeat route lists and Admin panels. Operator must
    /// explicitly choose this — there is no implicit removal.</summary>
    public static async Task<bool> DeleteRouteAssignment(string baseUrl, string credential, string routeType)
    {
        using var request = AuthedRequest(HttpMethod.Delete, baseUrl, $"/api/agent/routes/{routeType}/upsert", credential);
        using var response = await Http.SendAsync(request);
        return response.IsSuccessStatusCode;
    }

    /// <summary>Faza 2C — prijava ishoda lokalno izvedene testne štampe
    /// (Admin "Test Print" dugme). Namerno bez jobId/attemptId — vidi
    /// workstation-service.ts requestTestPrint napomenu.</summary>
    public static async Task<bool> SubmitTestPrintResult(string baseUrl, string credential, string status, string? errorMessage)
    {
        using var request = AuthedRequest(HttpMethod.Post, baseUrl, "/api/agent/test-print/result", credential);
        request.Content = JsonContent.Create(new { status, errorMessage }, options: JsonOptions);
        using var response = await Http.SendAsync(request);
        return response.IsSuccessStatusCode;
    }
}
