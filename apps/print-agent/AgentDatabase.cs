using Microsoft.Data.Sqlite;

namespace TableCore.PrintAgent;

/// <summary>
/// Faza 2B — trajno lokalno stanje pokušaja štampe. SQLite (lagan,
/// pouzdan, fajl-baziran format — samo Microsoft.Data.Sqlite ADO.NET
/// provajder, bez EF Core) ZAMENJUJE in-memory skup iz Faze 1
/// (`records` u Program.cs), koji NE preživljava restart procesa.
///
/// KRITIČNO PRAVILO: red se upisuje PRE svakog nepovratnog koraka —
/// `RecordSubmissionStarted` pre poziva serverskog /start endpoint-a,
/// `RecordPrintInvoked` NEPOSREDNO PRE PrintDocument.Print poziva (pre
/// nego što se zna ishod), `RecordResultKnown` čim je ishod lokalno
/// poznat, `RecordAcked` tek kad server POTVRDI prijem rezultata. Restart
/// procesa u BILO KOM trenutku mora moći da vidi TAČNO dokle se stiglo,
/// bez nagađanja — vidi Program.cs ReconcileOnStartup.
/// </summary>
public enum AttemptState
{
    Received,
    SubmissionStarted,
    PrintInvoked,
    ResultKnown,
    Acked,
}

public sealed record LocalAttempt(
    string JobId,
    string AttemptId,
    string? PayloadHash,
    AttemptState State,
    DateTime ReceivedAtUtc,
    DateTime? SubmissionStartedAtUtc,
    string? Result,
    string? ErrorMessage,
    DateTime? LastServerAckAtUtc
);

public static class AgentDatabase
{
    // Faza 2C — premešteno iz LocalAppData (po-korisniku) u ProgramData
    // (AgentPaths.DatabaseFilePath) iz istog razloga kao CredentialStore:
    // Windows servis i interaktivni Setup ekran rade pod različitim
    // Windows nalozima i moraju videti ISTU bazu lokalnog stanja pokušaja
    // štampe, a po-korisnički profil servisnog naloga nije pouzdan/deljiv.
    private static string DatabasePath => AgentPaths.DatabaseFilePath;

    private static string ConnectionString => $"Data Source={DatabasePath}";

    public static void EnsureInitialized()
    {
        AgentPaths.EnsureProgramDataDirectory();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS print_attempts (
                jobId               TEXT PRIMARY KEY,
                attemptId           TEXT NOT NULL,
                payloadHash         TEXT,
                state               TEXT NOT NULL,
                receivedAt          TEXT NOT NULL,
                submissionStartedAt TEXT,
                result              TEXT,
                errorMessage        TEXT,
                lastServerAckAt     TEXT
            );
            """;
        command.ExecuteNonQuery();
    }

    private static SqliteConnection Open()
    {
        var connection = new SqliteConnection(ConnectionString);
        connection.Open();
        return connection;
    }

    private static string Iso(DateTime utc) => utc.ToString("O");

    public static void RecordReceived(string jobId, string attemptId, string? payloadHash)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO print_attempts (jobId, attemptId, payloadHash, state, receivedAt)
            VALUES ($jobId, $attemptId, $payloadHash, $state, $receivedAt)
            ON CONFLICT(jobId) DO UPDATE SET
                attemptId = excluded.attemptId, payloadHash = excluded.payloadHash,
                state = excluded.state, receivedAt = excluded.receivedAt,
                submissionStartedAt = NULL, result = NULL, errorMessage = NULL, lastServerAckAt = NULL;
            """;
        command.Parameters.AddWithValue("$jobId", jobId);
        command.Parameters.AddWithValue("$attemptId", attemptId);
        command.Parameters.AddWithValue("$payloadHash", (object?)payloadHash ?? DBNull.Value);
        command.Parameters.AddWithValue("$state", nameof(AttemptState.Received));
        command.Parameters.AddWithValue("$receivedAt", Iso(DateTime.UtcNow));
        command.ExecuteNonQuery();
    }

    public static void RecordSubmissionStarted(string jobId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE print_attempts SET state = $state, submissionStartedAt = $at WHERE jobId = $jobId;";
        command.Parameters.AddWithValue("$state", nameof(AttemptState.SubmissionStarted));
        command.Parameters.AddWithValue("$at", Iso(DateTime.UtcNow));
        command.Parameters.AddWithValue("$jobId", jobId);
        command.ExecuteNonQuery();
    }

    /// <summary>Upisuje se NEPOSREDNO PRE PrintDocument.Print poziva — ako
    /// proces padne TAČNO za vreme tog poziva, restart mora videti da je
    /// štampa MOGLA biti pokrenuta i NIKAD ne sme pokušati ponovo.</summary>
    public static void RecordPrintInvoked(string jobId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE print_attempts SET state = $state WHERE jobId = $jobId;";
        command.Parameters.AddWithValue("$state", nameof(AttemptState.PrintInvoked));
        command.Parameters.AddWithValue("$jobId", jobId);
        command.ExecuteNonQuery();
    }

    public static void RecordResultKnown(string jobId, string result, string? errorMessage)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE print_attempts SET state = $state, result = $result, errorMessage = $err WHERE jobId = $jobId;";
        command.Parameters.AddWithValue("$state", nameof(AttemptState.ResultKnown));
        command.Parameters.AddWithValue("$result", result);
        command.Parameters.AddWithValue("$err", (object?)errorMessage ?? DBNull.Value);
        command.Parameters.AddWithValue("$jobId", jobId);
        command.ExecuteNonQuery();
    }

    public static void RecordAcked(string jobId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE print_attempts SET state = $state, lastServerAckAt = $at WHERE jobId = $jobId;";
        command.Parameters.AddWithValue("$state", nameof(AttemptState.Acked));
        command.Parameters.AddWithValue("$at", Iso(DateTime.UtcNow));
        command.Parameters.AddWithValue("$jobId", jobId);
        command.ExecuteNonQuery();
    }

    /// <summary>Sve što NIJE potvrđeno od strane servera — ono što
    /// ReconcileOnStartup mora obraditi PRE nego što se pređe na normalan
    /// poll ciklus.</summary>
    public static List<LocalAttempt> GetUnresolved()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT jobId, attemptId, payloadHash, state, receivedAt, submissionStartedAt, result, errorMessage, lastServerAckAt FROM print_attempts WHERE state != $acked;";
        command.Parameters.AddWithValue("$acked", nameof(AttemptState.Acked));
        using var reader = command.ExecuteReader();
        var results = new List<LocalAttempt>();
        while (reader.Read())
        {
            results.Add(new LocalAttempt(
                JobId: reader.GetString(0),
                AttemptId: reader.GetString(1),
                PayloadHash: reader.IsDBNull(2) ? null : reader.GetString(2),
                State: Enum.Parse<AttemptState>(reader.GetString(3)),
                ReceivedAtUtc: DateTime.Parse(reader.GetString(4)).ToUniversalTime(),
                SubmissionStartedAtUtc: reader.IsDBNull(5) ? null : DateTime.Parse(reader.GetString(5)).ToUniversalTime(),
                Result: reader.IsDBNull(6) ? null : reader.GetString(6),
                ErrorMessage: reader.IsDBNull(7) ? null : reader.GetString(7),
                LastServerAckAtUtc: reader.IsDBNull(8) ? null : DateTime.Parse(reader.GetString(8)).ToUniversalTime()
            ));
        }
        return results;
    }

    /// <summary>Best-effort kućni red — briše ACKED redove starije od
    /// zadatog perioda da baza ne raste neograničeno. Nikad ne briše
    /// nerešene redove.</summary>
    public static void PruneAcked(TimeSpan olderThan)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM print_attempts WHERE state = $acked AND lastServerAckAt < $cutoff;";
        command.Parameters.AddWithValue("$acked", nameof(AttemptState.Acked));
        command.Parameters.AddWithValue("$cutoff", Iso(DateTime.UtcNow - olderThan));
        command.ExecuteNonQuery();
    }

    /// <summary>Bezuslovno brisanje jednog reda — ISKLJUČIVO za
    /// SelfTests.cs čišćenje sopstvenih test redova; normalan tok nikad ne
    /// briše osim preko PruneAcked.</summary>
    public static void Delete(string jobId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM print_attempts WHERE jobId = $jobId;";
        command.Parameters.AddWithValue("$jobId", jobId);
        command.ExecuteNonQuery();
    }
}
