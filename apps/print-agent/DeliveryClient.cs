using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TableCore.PrintAgent;

public sealed record PolledJob(string JobId, string AttemptId, string Station, JsonElement Content);

/// <summary>
/// `TestPrintRequested` je dodato uz `job` na /api/agent/poll (server:
/// apps/web/app/api/agent/poll/route.ts) da bi Admin "Test Print" koristio
/// ISTI brz (1-3s) ciklus kao stvarni tiketi, umesto da čeka do 25s
/// heartbeat-a — vidi AgentRunner.cs.
/// </summary>
public sealed record PollOutcome(PolledJob? Job, bool TestPrintRequested);

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

    public static async Task<PollOutcome> Poll(string baseUrl, string credential)
    {
        using var request = AuthedRequest(HttpMethod.Post, baseUrl, "/api/agent/poll", credential);
        request.Content = JsonContent.Create(new { }, options: JsonOptions);
        using var response = await Http.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStreamAsync());
        var root = doc.RootElement;
        var testPrintRequested = root.TryGetProperty("testPrintRequested", out var tp) && tp.ValueKind == JsonValueKind.True;
        var jobEl = root.GetProperty("job");
        if (jobEl.ValueKind != JsonValueKind.Object) return new PollOutcome(null, testPrintRequested);
        var job = new PolledJob(
            JobId: jobEl.GetProperty("jobId").GetString()!,
            AttemptId: jobEl.GetProperty("attemptId").GetString()!,
            Station: jobEl.GetProperty("station").GetString()!,
            Content: jobEl.GetProperty("content").Clone()
        );
        return new PollOutcome(job, testPrintRequested);
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

    public sealed record HeartbeatOutcome(bool Success, bool TestPrintRequested);

    public static async Task<HeartbeatOutcome> Heartbeat(
        string baseUrl, string credential, string? agentVersion, string? osDescription,
        string? configuredPrinterName, int? paperWidthMm, bool? printerAvailable)
    {
        using var request = AuthedRequest(HttpMethod.Post, baseUrl, "/api/agent/heartbeat", credential);
        request.Content = JsonContent.Create(
            new { agentVersion, osDescription, configuredPrinterName, paperWidthMm, printerAvailable },
            options: JsonOptions);
        using var response = await Http.SendAsync(request);
        if (!response.IsSuccessStatusCode) return new HeartbeatOutcome(false, false);
        try
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStreamAsync());
            var testPrintRequested = doc.RootElement.TryGetProperty("testPrintRequested", out var el) && el.ValueKind == JsonValueKind.True;
            return new HeartbeatOutcome(true, testPrintRequested);
        }
        catch (JsonException)
        {
            // Odgovor bez validnog JSON tela i dalje znači "heartbeat je stigao"
            // (server je vratio uspešan status kod) — samo bez test-print
            // zastavice ovog puta; ne tretiramo kao mrežnu grešku.
            return new HeartbeatOutcome(true, false);
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
