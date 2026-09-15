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
/// have several different printers.</summary>
public sealed record RoutePrinterAvailability(string Type, bool PrinterAvailable);

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

    public sealed record HeartbeatOutcome(bool Success, bool TestPrintRequested, string? TestPrintRoute, IReadOnlyList<AgentRouteInfo> Routes);

    /// <summary>
    /// Printing V2 — capability report widened from "one configured printer
    /// name/width/availability" to (a) the FULL enumerated printer list
    /// (`availablePrinters`, so Admin can pick from a real dropdown) and (b)
    /// per-route printer availability (`routes`, since one agent can now
    /// have several different printers, one boolean no longer suffices).
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
                routes = routes?.Select(r => new { type = r.Type, printerAvailable = r.PrinterAvailable }),
            },
            options: JsonOptions);
        using var response = await Http.SendAsync(request);
        if (!response.IsSuccessStatusCode) return new HeartbeatOutcome(false, false, null, []);
        try
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStreamAsync());
            var root = doc.RootElement;
            var testPrintRequested = root.TryGetProperty("testPrintRequested", out var el) && el.ValueKind == JsonValueKind.True;
            return new HeartbeatOutcome(true, testPrintRequested, ParseTestPrintRoute(root), ParseRoutes(root));
        }
        catch (JsonException)
        {
            // Odgovor bez validnog JSON tela i dalje znači "heartbeat je stigao"
            // (server je vratio uspešan status kod) — samo bez test-print/rute
            // ovog puta; ne tretiramo kao mrežnu grešku, i NIKAD ne brišemo
            // lokalno keširane rute zbog ovoga (vidi AgentRunner.ApplyServerRoutes
            // — primenjuje se samo kad je poziv STVARNO uspeo sa čitljivim telom).
            return new HeartbeatOutcome(true, false, null, []);
        }
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
