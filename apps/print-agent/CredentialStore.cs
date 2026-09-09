using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace TableCore.PrintAgent;

/// <summary>
/// Faza 2A/2C — bezbedno lokalno čuvanje trajnog kredencijala radne
/// stanice. Server ga vraća TAČNO JEDNOM, u odgovoru na uspešno uparivanje
/// (vidi packages/domain/workstations/workstation-service.ts
/// registerAgentFromPairing) i posle toga ga više nikad ne vraća u čistom
/// tekstu. Ovaj fajl je JEDINO mesto u agentu koje sme da čita/piše taj
/// fajl na disku.
///
/// NIKAD: izvorni kod, JSON pod izvornom kontrolom, environment
/// promenljiva kao KRAJNJI dizajn, ili čisto-tekstualni config fajl koji
/// običan korisnik može slučajno da kopira/pošalje. Koristi Windows DPAPI
/// (System.Security.Cryptography.ProtectedData).
/// </summary>
public static class CredentialStore
{
    // FAZA 2C ODLUKA — LocalMachine, NE CurrentUser (Faza 2A izbor):
    //
    // Interaktivni Setup ekran (SetupForm.cs, pokreće ga PRIJAVLJENI
    // KORISNIK koji instalira agenta) upisuje kredencijal preko istog
    // Save() poziva koji Windows servis (AgentService.cs, radi pod
    // servisnim nalogom — vidi izveštaj Faze 2C za tačan izabran nalog)
    // kasnije čita preko Load(). To su DVA RAZLIČITA Windows bezbednosna
    // principala. DPAPI CurrentUser ključ je vezan za nalog KOJI JE
    // POZVAO Protect/Unprotect — kredencijal upisan pod interaktivnim
    // korisničkim nalogom NIKAD ne bi bio čitljiv servisnom nalogu (i
    // obrnuto), pa bi servis posle svakog ponovnog uparivanja izgledao
    // "neuparen" iako fajl fizički postoji. LocalMachine ključ je vezan za
    // SAMU MAŠINU — čitljiv BILO KOM procesu na njoj, bez obzira pod kojim
    // nalogom radi, što je TAČNO potrebno ovde.
    //
    // BEZBEDNOSNI KOMPROMIS (namerno dokumentovano): LocalMachine scope
    // sam po sebi NE ograničava KOJI proces/nalog na istoj mašini sme da
    // dešifruje — bilo koji proces koji pročita fajl i pozove
    // ProtectedData.Unprotect sa LocalMachine scope-om na TOJ mašini
    // uspeva, za razliku od CurrentUser-a koji dodatno zahteva TAČAN
    // nalog. Ovo je NAMERNO ublaženo eksplicitnom NTFS ACL restrikcijom na
    // sam fajl (ApplyRestrictiveAcl ispod) — samo Administrators/SYSTEM/
    // servisni nalog smeju da PROČITAJU fajl; obična prijava restoranskog
    // radnika na tom računaru ne može ni da pristupi fajlu, a kamoli da ga
    // dešifruje. Odbrana u dubinu (DPAPI + ACL), ne oslanjanje samo na
    // DPAPI scope.
    private static DataProtectionScope Scope => DataProtectionScope.LocalMachine;

    // "Opciona entropija" DPAPI parametar dodatno vezuje šifrovane podatke
    // za OVU aplikaciju — isti princip kao AES-GCM additional authenticated
    // data (odbrana u dubinu, ne sama tajna; sme biti u izvornom kodu).
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("TableCore.PrintAgent.WorkstationCredential.v1");

    private static string CredentialFilePath => AgentPaths.CredentialFilePath;

    /// <summary>
    /// Šifruje i upisuje sirov kredencijal na disk. Poziva se TAČNO JEDNOM
    /// po uspešnoj registraciji (POST /api/agent/register).
    /// </summary>
    public static void Save(string rawCredential)
    {
        if (string.IsNullOrWhiteSpace(rawCredential))
            throw new ArgumentException("Kredencijal ne sme biti prazan.", nameof(rawCredential));

        AgentPaths.EnsureProgramDataDirectory();
        var plainBytes = Encoding.UTF8.GetBytes(rawCredential);
        var protectedBytes = ProtectedData.Protect(plainBytes, Entropy, Scope);

        // Upis u privremen fajl pa preimenovanje (atomsko na NTFS-u za isti
        // volumen) — proces koji čita CredentialFilePath nikad ne vidi
        // delimično upisan fajl.
        var tempPath = CredentialFilePath + ".tmp";
        File.WriteAllBytes(tempPath, protectedBytes);
        File.Move(tempPath, CredentialFilePath, overwrite: true);
        TryApplyRestrictiveAcl(CredentialFilePath);
    }

    /// <summary>
    /// Čita i dešifruje kredencijal. Vraća null ako fajl ne postoji (agent
    /// još nije uparen) — NIKAD ne baca za taj slučaj; pozivalac to
    /// tretira kao "pokreni tok uparivanja". Baca za STVARNU grešku
    /// dešifrovanja (npr. fajl prekopiran na drugu mašinu čiji DPAPI ključ
    /// ne odgovara) — to je ozbiljnija situacija od "nije upareno" i ne
    /// sme tiho izgledati isto.
    /// </summary>
    public static string? Load()
    {
        if (!File.Exists(CredentialFilePath)) return null;
        var protectedBytes = File.ReadAllBytes(CredentialFilePath);
        var plainBytes = ProtectedData.Unprotect(protectedBytes, Entropy, Scope);
        try
        {
            return Encoding.UTF8.GetString(plainBytes);
        }
        finally
        {
            Array.Clear(plainBytes, 0, plainBytes.Length);
        }
    }

    /// <summary>
    /// Briše sačuvan kredencijal (ponovno uparivanje nakon admin opoziva,
    /// ili ručni reset). Idempotentno.
    /// </summary>
    public static void Clear()
    {
        if (File.Exists(CredentialFilePath)) File.Delete(CredentialFilePath);
    }

    public static bool HasStoredCredential() => File.Exists(CredentialFilePath);

    /// <summary>
    /// Odbrana u dubinu iznad DPAPI LocalMachine scope-a (vidi napomenu na
    /// vrhu fajla): SAMO Administrators/SYSTEM/servisni nalog/nalog KOJI JE
    /// UPRAVO UPARIO stanicu smeju da PROČITAJU sam fajl na NTFS nivou, bez
    /// obzira što bi DPAPI LocalMachine dešifrovanje tehnički uspelo bilo
    /// kom nalogu na mašini koji bi fajl uopšte mogao da pročita.
    ///
    /// NAMERNO uključuje trenutnog pozivaoca (WindowsIdentity.GetCurrent()),
    /// NE samo Administrators — restoranski menadžer NE SME morati da
    /// pokreće Setup ekran "Run as Administrator" (zahtev specifikacije:
    /// "no admin interaction required after install"); ko god fizički
    /// upari stanicu (obično jedini interaktivni Windows nalog na tom
    /// POS računaru) time postaje i onaj ko sme da pročita taj fajl.
    /// Ostvaren cilj pretnje: DRUGI, ODVOJEN Windows nalog na istoj deljenoj
    /// mašini (da ga ima) i dalje NEMA pristup, čak ni preko standardnog
    /// DPAPI LocalMachine ponašanja koje bi mu inače to dozvolilo.
    ///
    /// Best-effort — greška ovde se NIKAD ne baca dalje (kredencijal je već
    /// bezbedno sačuvan preko DPAPI-ja, ACL je dodatan sloj, ne jedini).
    /// </summary>
    private static void TryApplyRestrictiveAcl(string path)
    {
        try
        {
            var fileInfo = new FileInfo(path);
            var security = new FileSecurity();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
            // Servisni nalog radne stanice — AgentService.ServiceAccount
            // ("NT SERVICE\TableCorePrintAgent", per-service virtuelni nalog;
            // vidi AgentService.cs za empirijsko obrazloženje ZAŠTO ovaj a ne
            // ugrađen NetworkService/LocalService). Čitanje je dovoljno,
            // servis sam nikad ne (pre)piše ovaj fajl van uparivanja preko
            // Setup ekrana. Best-effort: ime naloga se razrešava u SID samo
            // ako je LSA u stanju da ga prepozna (uvek tačno na instaliranoj
            // mašini); ako razrešavanje ovde padne (npr. self-test okruženje
            // bez tog imena registrovanog), preskačemo TU JEDNU ACE stavku —
            // Administrators/SYSTEM/trenutni korisnik i dalje pokrivaju
            // ostatak modela pretnje.
            try
            {
                var serviceAccountSid = (SecurityIdentifier)new NTAccount(AgentService.ServiceAccount).Translate(typeof(SecurityIdentifier));
                security.AddAccessRule(new FileSystemAccessRule(serviceAccountSid, FileSystemRights.Read, AccessControlType.Allow));
            }
            catch (IdentityNotMappedException)
            {
                // Vidi napomenu iznad — ne blokira ostatak ACL primene.
            }
            var currentUserSid = WindowsIdentity.GetCurrent().User;
            if (currentUserSid is not null)
                security.AddAccessRule(new FileSystemAccessRule(currentUserSid, FileSystemRights.FullControl, AccessControlType.Allow));
            fileInfo.SetAccessControl(security);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Upozorenje: nisam mogao da postavim restriktivan ACL na kredencijal fajl ({ex.Message}) — DPAPI zaštita i dalje važi.");
        }
    }
}
