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

public sealed record AgentEndpoint(AgentRuntimeMode Mode, string BaseUrl, string? BypassHeader = null)
{
    public const string ProductionBaseUrl = "https://tablecore.net";
    private const string ProductionHost = "tablecore.net";

    // Vercel Preview deployments (NIKAD Production custom domen — vidi
    // ProductionBaseUrl iznad, koji nema ovu zaštitu) mogu imati "Vercel
    // Authentication" (Deployment Protection) uključen na nivou projekta,
    // što na Vercel edge-u (PRE nego što ijedan naš kod/middleware uopšte
    // izvrši) blokira SVAKI zahtev bez browser SSO kolačića — uključujući
    // legitimne agent-ove pozive (uparivanje/heartbeat/poll), sa 401 koji
    // se NIKAD ne pojavljuje u runtime logovima aplikacije (blokiran je pre
    // te tačke). Rešenje je Vercel-ovo dokumentovano "Protection Bypass for
    // Automation" — projektni tajni token koji se šalje kao ovo zaglavlje.
    // Ovo NIKAD ne otključava ništa unutar same aplikacije (uparivanje i
    // dalje zahteva ispravan jednokratan kod, heartbeat i dalje zahteva
    // Bearer kredencijal) — samo propušta zahtev kroz Vercel-ov EDGE zid.
    public const string BypassHeaderName = "x-vercel-protection-bypass";

    public static AgentEndpoint Resolve(string[] args)
    {
        var mode = ParseMode(ArgValue(args, "--mode"));
        var serverArg = ArgValue(args, "--server");
        // NAMERNO čitano OVDE (ne unutar ResolveProduction) — Production
        // grana ispod NIKAD ne prosleđuje ovu vrednost dalje, tako da čak i
        // greškom prosleđen --bypass-header uz produkcioni (podrazumevani)
        // režim ostaje potpuno bez efekta, isto pravilo kao ostatak fajla:
        // nijedan argument ne sme tiho promeniti ponašanje produkcije.
        var bypassArg = ArgValue(args, "--bypass-header");
        return mode == AgentRuntimeMode.Test ? ResolveTest(serverArg, bypassArg) : ResolveProduction(serverArg);
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

    private static AgentEndpoint ResolveTest(string? serverArg, string? bypassArg)
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
        var bypass = string.IsNullOrWhiteSpace(bypassArg) ? null : bypassArg.Trim();
        return new AgentEndpoint(AgentRuntimeMode.Test, uri.GetLeftPart(UriPartial.Authority), bypass);
    }

    /// <summary>
    /// Postavlja se TAČNO JEDNOM po procesu, PRE prvog HTTP zahteva (vidi
    /// pozivaoce: Program.cs, AgentService.cs, SetupForm.cs — svako od njih
    /// rešava AgentEndpoint tačno jednom na početku svog puta). Kad
    /// BypassHeader nije postavljen (uvek slučaj u Production režimu), ovo
    /// je no-op — HttpClient nikad ne dobija ovo zaglavlje.
    /// </summary>
    public void ConfigureHttpClientDefaults(HttpClient client)
    {
        if (string.IsNullOrEmpty(BypassHeader)) return;
        client.DefaultRequestHeaders.Remove(BypassHeaderName);
        client.DefaultRequestHeaders.Add(BypassHeaderName, BypassHeader);
    }

    /// <summary>
    /// Professional audit finding (physical QA: pairing succeeded, the
    /// immediate post-Save heartbeat did not) — PairingClient and
    /// DeliveryClient each own a SEPARATE static HttpClient, so configuring
    /// the bypass header requires TWO calls. Program.cs and AgentService.cs
    /// both already called both; SetupForm.cs's constructor called only
    /// PairingClient's, which is exactly why pairing (PairingClient) worked
    /// physically while the immediate Save-time heartbeat (DeliveryClient)
    /// did not — the request left with no bypass header, Vercel's edge
    /// rejected it, and Setup reported a false "proverite internet
    /// konekciju". This is now the ONE authoritative entry point every
    /// caller uses instead of remembering to call both separately — the
    /// exact class of bug (two independent configuration points for one
    /// concept) cannot recur once every call site goes through here.
    /// </summary>
    public static void ConfigureAgentHttpClients(AgentEndpoint endpoint)
    {
        PairingClient.ConfigureBypassHeader(endpoint);
        DeliveryClient.ConfigureBypassHeader(endpoint);
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
