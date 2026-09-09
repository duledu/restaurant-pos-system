using System.Security.AccessControl;
using System.Security.Principal;

namespace TableCore.PrintAgent;

/// <summary>
/// Faza 2C — centralizovane produkcione putanje. Servis (NetworkService/
/// LocalService/LocalSystem — vidi CredentialStore.cs za tačnu odluku) i
/// interaktivni Setup ekran (pokreće ga prijavljeni korisnik) MORAJU
/// čitati/pisati IST0 mesto — zato ProgramData (mašinski deljeno), NIKAD
/// LocalAppData (po-korisniku — servisni nalog nema stabilan, deljiv
/// profil tamo). Instalacioni binarni fajlovi ostaju odvojeno u Program
/// Files (vidi installer/); ništa produkciono se ne ostavlja u izvornom
/// checkout-u (agent.local.json u CWD ostaje SAMO kao dev-only fallback
/// za `dotnet run` iz izvornog stabla — vidi AgentConfig ispod).
/// </summary>
public static class AgentPaths
{
    public static string ProgramDataDirectory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "TableCore", "PrintAgent");

    public static string ConfigFilePath => Path.Combine(ProgramDataDirectory, "agent.config.json");
    public static string CredentialFilePath => Path.Combine(ProgramDataDirectory, "workstation-credential.dat");
    public static string DatabaseFilePath => Path.Combine(ProgramDataDirectory, "agent-state.sqlite3");
    public static string LogsDirectory => Path.Combine(ProgramDataDirectory, "logs");

    /// <summary>
    /// Faza 2C — STVARNO testirano na instaliranom servisu i pukla je bez
    /// ovoga: SQLite fajl (agent-state.sqlite3) koji je PRVI put napravio
    /// JEDAN Windows identitet (npr. razvojni nalog preko `--self-test` na
    /// istoj mašini gde se kasnije instalira servis) nasleđuje SAMO
    /// generičku BUILTIN\Users "Read &amp; Execute" stavku na NOVIM
    /// fajlovima (podrazumevano NTFS nasleđivanje na ProgramData razdvaja
    /// "primeni na podfoldere" od "primeni na fajlove") — kad DRUGI
    /// identitet (servisni per-service virtuelni nalog) kasnije pokuša da
    /// UPIŠE u ISTI fajl, SQLite vraća "attempt to write a readonly
    /// database" iako je fajl fizički upisiv. Zato ovde EKSPLICITNO
    /// postavljamo ACL na SAM DIREKTORIJUM sa Object+Container nasleđivanjem
    /// (ne samo Container) tako da SVAKI nov fajl (SQLite stanje, log,
    /// config) koji BILO KOJI lokalni identitet napravi unutra nasledi
    /// dovoljna prava za BILO KOG DRUGOG kasnijeg identiteta da ga takođe
    /// otvori za pisanje. Kredencijal (workstation-credential.dat) OSTAJE
    /// posebno, STROŽE zaštićen preko CredentialStore.TryApplyRestrictiveAcl,
    /// koja se primenjuje NA TAJ JEDAN fajl posle svakog Save() poziva i
    /// time PREPISUJE (suzuje) ovo opštije nasleđeno dopuštenje samo za
    /// njega — namerno, ne slučajno.
    /// </summary>
    public static void EnsureProgramDataDirectory()
    {
        Directory.CreateDirectory(ProgramDataDirectory);
        TryApplyOperationalAcl();
    }

    private static void TryApplyOperationalAcl()
    {
        try
        {
            var dirInfo = new DirectoryInfo(ProgramDataDirectory);
            var security = dirInfo.GetAccessControl();
            var inheritance = InheritanceFlags.ObjectInherit | InheritanceFlags.ContainerInherit;
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            // Namerno široko (Modify, ne samo Read) za BUILTIN\Users na OVOM
            // deljenom operativnom direktorijumu — pokriva i servisni nalog i
            // interaktivnog korisnika koji pokreće Setup ekran, bez obzira ko
            // je od njih FIZIČKI napravio koji fajl prvi. Sam kredencijal fajl
            // dodatno se sužava posebno (vidi napomenu iznad).
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.Modify, inheritance, PropagationFlags.None, AccessControlType.Allow));
            dirInfo.SetAccessControl(security);
        }
        catch
        {
            // Best-effort — ako ACL primena ovde padne (npr. ograničeno
            // testno okruženje), nastavljamo sa podrazumevanim nasleđenim
            // dozvolama umesto da srušimo pokretanje agenta zbog toga.
        }
    }
}
