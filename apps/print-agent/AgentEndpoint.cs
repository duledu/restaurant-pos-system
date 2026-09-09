namespace TableCore.PrintAgent;

/// <summary>
/// Faza 2C — bezbedno rešavanje servera. Napravljeno POSLE stvarnog
/// incidenta u prihvatnom testiranju: pokušaj da se INSTALIRAN servis
/// preusmeri na lokalni test server (preko `sc config ... binPath=`)
/// tiho nije uspeo, i servis je nastavio da koristi svoj PODRAZUMEVANI
/// URL — koji je BIO produkcija (https://tablecore.net). Kredencijal je
/// postojao samo u jednoj-krat test bazi, pa je produkcija samo odbila
/// zahteve (401/nepoznat kredencijal) — nijedan produkcioni podatak nije
/// pročitan niti upisan — ali je ipak stvarna mreža PIPmljena ka produkciji
/// bez EKSPLICITNE namere u tom trenutku. Ovaj fajl to čini nemogućim:
/// UMESTO "URL string sa podrazumevanom vrednošću = produkcija", server se
/// SADA bira preko EKSPLICITNOG, snažno-tipiziranog režima
/// (AgentRuntimeMode), i SVAKA nevalidna/nepotpuna/pogrešna kombinacija
/// baca izuzetak — NIKAD se tiho ne vraća na produkciju.
///
/// Pravila (namerno mala, lako proverljiva površina):
/// 1. Bez --mode (podrazumevano) = Production, uvek https://tablecore.net.
///    Ako se UZ to doda --server koji NIJE tablecore.net host, to je
///    GREŠKA (baca se), ne tiho zanemarivanje --server-a niti tiha zamena.
/// 2. --mode test ZAHTEVA --server &lt;url&gt; koji NIJE prazan, NIJE
///    tablecore.net i JESTE ispravan apsolutan http(s) URL. Bilo koje od
///    ovoga da nedostaje/je pogrešno -> baca se, NIKAD tiho ne pada nazad
///    na produkciju.
/// 3. Nema globalnog "ako ništa ne uspe, koristi produkciju" puta bilo gde
///    u ovom fajlu — pozivalac (Program.cs/AgentService.cs) MORA
///    eksplicitno da obradi izuzetak (ispiše grešku i stane), a NIKAD ga
///    ne sme uhvatiti i tiho nastaviti sa ProductionBaseUrl.
/// </summary>
public enum AgentRuntimeMode
{
    Production,
    Test,
}

public sealed class AgentEndpointConfigurationException : Exception
{
    public AgentEndpointConfigurationException(string message) : base(message) { }
}

public sealed record AgentEndpoint(AgentRuntimeMode Mode, string BaseUrl)
{
    public const string ProductionBaseUrl = "https://tablecore.net";
    private const string ProductionHost = "tablecore.net";

    public static AgentEndpoint Resolve(string[] args)
    {
        var mode = ParseMode(ArgValue(args, "--mode"));
        var serverArg = ArgValue(args, "--server");
        return mode == AgentRuntimeMode.Test ? ResolveTest(serverArg) : ResolveProduction(serverArg);
    }

    private static AgentRuntimeMode ParseMode(string? modeArg)
    {
        if (modeArg is null) return AgentRuntimeMode.Production;
        return modeArg.Trim().ToLowerInvariant() switch
        {
            "production" or "prod" => AgentRuntimeMode.Production,
            "test" or "dev" or "development" => AgentRuntimeMode.Test,
            _ => throw new AgentEndpointConfigurationException(
                $"Nepoznat --mode '{modeArg}'. Dozvoljeno: production, test."),
        };
    }

    private static AgentEndpoint ResolveProduction(string? serverArg)
    {
        // Nema --server: jedini podrazumevani put u celom fajlu, i vodi
        // SAMO ka konstanti ispod — nijedan drugi kod ne sme sam po sebi
        // vratiti ProductionBaseUrl van ove grane.
        if (string.IsNullOrWhiteSpace(serverArg))
            return new AgentEndpoint(AgentRuntimeMode.Production, ProductionBaseUrl);

        var uri = ParseAbsoluteHttpUri(serverArg);
        if (!string.Equals(uri.Host, ProductionHost, StringComparison.OrdinalIgnoreCase))
        {
            // Sekcija 6 bezbednosnog zahteva: produkcioni režim ODBIJA
            // lokalne/test hostove — "eksplicitna podrška" za drugačiji
            // server znači --mode test, ne tih override ovde.
            throw new AgentEndpointConfigurationException(
                $"Produkcioni režim (podrazumevan, --mode nije naveden) odbija ne-produkcioni server '{serverArg}'. " +
                "Za test/razvojni server MORA se eksplicitno navesti --mode test.");
        }
        return new AgentEndpoint(AgentRuntimeMode.Production, uri.GetLeftPart(UriPartial.Authority));
    }

    private static AgentEndpoint ResolveTest(string? serverArg)
    {
        if (string.IsNullOrWhiteSpace(serverArg))
            throw new AgentEndpointConfigurationException(
                "--mode test zahteva eksplicitan --server <url> koji NIJE produkcija. " +
                "Nema tihog podrazumevanog servera u test režimu (fail-closed).");

        var uri = ParseAbsoluteHttpUri(serverArg);
        if (string.Equals(uri.Host, ProductionHost, StringComparison.OrdinalIgnoreCase))
        {
            throw new AgentEndpointConfigurationException(
                $"--mode test ne sme pokazivati na produkcioni server ({ProductionHost}). Navedi stvaran test/razvojni server.");
        }
        return new AgentEndpoint(AgentRuntimeMode.Test, uri.GetLeftPart(UriPartial.Authority));
    }

    private static Uri ParseAbsoluteHttpUri(string value)
    {
        var trimmed = value.Trim();
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
            throw new AgentEndpointConfigurationException($"--server '{value}' nije ispravan apsolutan http(s) URL.");
        return uri;
    }

    private static string? ArgValue(string[] args, string flag)
    {
        var index = Array.IndexOf(args, flag);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    /// <summary>
    /// Bezbedno za log/UI prikaz — SAMO režim + host + šema, NIKAD
    /// kredencijal/token/kod za uparivanje. Pozivaoci (AgentService.cs,
    /// SetupForm.cs) koriste OVO, nikad ne sastavljaju sopstveni log red
    /// koji bi mogao slučajno da uključi kredencijal iz istog konteksta.
    /// </summary>
    public string DescribeForLog()
    {
        var uri = new Uri(BaseUrl);
        return $"mode={Mode}, endpoint={uri.Scheme}://{uri.Host}" + (uri.IsDefaultPort ? "" : $":{uri.Port}");
    }
}
