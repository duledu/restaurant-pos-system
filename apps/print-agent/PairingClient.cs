using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace TableCore.PrintAgent;

/// <summary>
/// Faza 2A — minimalan autentifikovan transport skelet SAMO da dokaže
/// identitet radne stanice kraj-do-kraja: uparivanje preko kratkotrajnog
/// koda -> trajan kredencijal (DPAPI preko CredentialStore) -> autentifikovan
/// heartbeat preko Authorization: Bearer. NAMERNO ne implementira
/// preuzimanje/polling PrintJob-ova niti fizičku dostavu tiketa — to je
/// Faza 2B. Agent ISKLJUČIVO inicira odlazeću HTTPS komunikaciju (nema
/// ulaznih portova na restoranskoj mreži, nema zavisnosti od
/// browser->localhost puta za ovu komunikaciju).
/// </summary>
public static class PairingClient
{
    private static readonly HttpClient Http = new();

    /// <summary>
    /// Faza 2C — SADA deleguje na AgentEndpoint.Resolve (vidi AgentEndpoint.cs
    /// za PUN razlog: stvaran incident gde je tih pad-na-produkciju skoro
    /// prošao neopaženo). NIKAD ovde ne hvatati AgentEndpointConfigurationException
    /// i tiho vratiti produkciju — pozivalac (Program.cs/AgentService.cs) MORA
    /// eksplicitno obraditi grešku.</summary>
    public static string ServerBaseUrl(string[] args) => AgentEndpoint.Resolve(args).BaseUrl;

    public static async Task Pair(string baseUrl, string code)
    {
        HttpResponseMessage response;
        string body;
        try
        {
            response = await Http.PostAsJsonAsync($"{baseUrl}/api/agent/register", new { code });
            body = await response.Content.ReadAsStringAsync();
        }
        catch (HttpRequestException ex)
        {
            Console.Error.WriteLine($"Uparivanje nije uspelo — mrežna greška: {ex.Message}");
            Environment.ExitCode = 1;
            return;
        }

        if (!response.IsSuccessStatusCode)
        {
            Console.Error.WriteLine($"Uparivanje nije uspelo ({(int)response.StatusCode}): {body}");
            Environment.ExitCode = 1;
            return;
        }

        using var json = JsonDocument.Parse(body);
        var root = json.RootElement;
        var credential = root.GetProperty("credential").GetString();
        if (string.IsNullOrWhiteSpace(credential))
        {
            Console.Error.WriteLine("Server nije vratio kredencijal.");
            Environment.ExitCode = 1;
            return;
        }

        // Sirov kredencijal se čuva ISKLJUČIVO preko CredentialStore-a
        // (DPAPI) — nikad ispisan na konzolu/log posle ovog trenutka.
        CredentialStore.Save(credential);

        var name = root.TryGetProperty("name", out var n) ? n.GetString() : null;
        var station = root.TryGetProperty("station", out var s) ? s.GetString() : null;
        Console.WriteLine($"Upareno: {name} ({station}). Kredencijal bezbedno sačuvan preko DPAPI-ja.");
    }

    public sealed record PairResult(bool Success, string? Name, string? Station, string? ErrorMessage);

    /// <summary>
    /// Faza 2C — ista logika kao Pair(string,string) iznad, ali za
    /// SetupForm.cs (WinForms): vraća strukturisan rezultat umesto pisanja
    /// na konzolu/Environment.ExitCode (servis/GUI proces nema konzolu koju
    /// bi neko gledao). Kredencijal se i dalje čuva ISKLJUČIVO preko
    /// CredentialStore-a (DPAPI) — SetupForm ga NIKAD ne vidi u čistom
    /// tekstu niti ga prikazuje korisniku.
    /// </summary>
    public static async Task<PairResult> PairForSetup(string baseUrl, string code)
    {
        HttpResponseMessage response;
        string body;
        try
        {
            response = await Http.PostAsJsonAsync($"{baseUrl}/api/agent/register", new { code });
            body = await response.Content.ReadAsStringAsync();
        }
        catch (HttpRequestException ex)
        {
            return new PairResult(false, null, null, $"Mrežna greška: {ex.Message}");
        }

        if (!response.IsSuccessStatusCode)
            return new PairResult(false, null, null, $"Server je odbio kod uparivanja ({(int)response.StatusCode}).");

        using var json = JsonDocument.Parse(body);
        var root = json.RootElement;
        var credential = root.GetProperty("credential").GetString();
        if (string.IsNullOrWhiteSpace(credential))
            return new PairResult(false, null, null, "Server nije vratio kredencijal.");

        CredentialStore.Save(credential);
        var name = root.TryGetProperty("name", out var n) ? n.GetString() : null;
        var station = root.TryGetProperty("station", out var s) ? s.GetString() : null;
        return new PairResult(true, name, station, null);
    }

    public static async Task Heartbeat(string baseUrl)
    {
        var credential = CredentialStore.Load();
        if (credential is null)
        {
            Console.Error.WriteLine("Nema sačuvanog kredencijala — prvo pokreni: --pair <KOD>");
            Environment.ExitCode = 1;
            return;
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/api/agent/heartbeat");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        request.Content = JsonContent.Create(new { });

        HttpResponseMessage response;
        string body;
        try
        {
            response = await Http.SendAsync(request);
            body = await response.Content.ReadAsStringAsync();
        }
        catch (HttpRequestException ex)
        {
            Console.Error.WriteLine($"Heartbeat nije uspeo — mrežna greška: {ex.Message}");
            Environment.ExitCode = 1;
            return;
        }

        Console.WriteLine($"Heartbeat {(int)response.StatusCode}: {body}");
        Environment.ExitCode = response.IsSuccessStatusCode ? 0 : 1;
    }
}
