namespace TableCore.PrintAgent;

/// <summary>
/// Faza 2C, sekcija 12 — bezbedno operativno logovanje. Namerno JEDNOSTAVAN
/// append-fajl logger (bez spoljne zavisnosti) sa veličinski ograničenom
/// rotacijom — dovoljno za servis koji radi nenadgledano na restoranskom
/// računaru; nije zamišljen kao opšti aplikacioni logging framework.
///
/// STROGA ZABRANA (nikad ne prosleđuj ovim metodama, ni slučajno preko
/// interpolacije): sirov trajan kredencijal, kod za uparivanje POSLE
/// predaje serveru, AUTH_SECRET, connection string baze podataka, sadržaj
/// tuđih porudžbina. Pozivaoci prosleđuju SAMO: jobId/attemptId, imena
/// stanica/štampača (ne i sadržaj tiketa), HTTP status kodove, verzije,
/// bezopasne poruke o grešci (izuzetak.Message, ne ceo objekat/stack sa
/// mogućim sadržajem zahteva).
/// </summary>
public static class AgentLog
{
    private const long MaxBytesBeforeRotate = 2 * 1024 * 1024;
    private static readonly object Gate = new();

    private static string LogFilePath => Path.Combine(AgentPaths.LogsDirectory, "agent.log");
    private static string RotatedLogFilePath => Path.Combine(AgentPaths.LogsDirectory, "agent.log.1");

    public static void Info(string message) => Write("INFO", message);
    public static void Warn(string message) => Write("WARN", message);
    public static void Error(string message) => Write("ERROR", message);

    private static void Write(string level, string message)
    {
        try
        {
            Directory.CreateDirectory(AgentPaths.LogsDirectory);
            lock (Gate)
            {
                RotateIfNeeded();
                var line = $"{DateTime.UtcNow:O} [{level}] {message}{Environment.NewLine}";
                File.AppendAllText(LogFilePath, line);
            }
        }
        catch
        {
            // Logovanje nikad ne sme oboriti glavnu petlju agenta — ako disk
            // nije pisiv (npr. privremen problem sa dozvolama), nastavljamo
            // rad bez log zapisa umesto da bacimo dalje.
        }
    }

    private static void RotateIfNeeded()
    {
        if (!File.Exists(LogFilePath)) return;
        if (new FileInfo(LogFilePath).Length < MaxBytesBeforeRotate) return;
        File.Move(LogFilePath, RotatedLogFilePath, overwrite: true);
    }
}
