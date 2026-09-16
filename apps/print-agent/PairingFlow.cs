namespace TableCore.PrintAgent;

/// <summary>
/// Physical QA follow-up — broken re-pair UX investigation. Pure decision
/// logic for "what should Setup's pairing UI show", extracted OUT of
/// SetupForm (a WinForms Form, not unit-testable in this project's
/// self-test harness) so the actual bug class (an incoming
/// tablecore-print:// pairing code being silently ignored because the
/// machine is already paired) can be proven fixed with a real, automated
/// test — same pattern as SetupArgumentDispatch (Program.cs) for CLI args.
///
/// Two independent inputs decide everything: is this machine already
/// paired, and did we receive an explicit incoming pairing code (from a
/// tablecore-print:// URI activation)? There is no third "just typed
/// something manually" input here — that's SetupForm's own live
/// EnterRepairMode transition, triggered by a button click, not by this
/// static resolution (which only runs once, at Setup startup).
/// </summary>
public enum PairingUiMode
{
    /// <summary>CASE A — normal open, no incoming code. If already paired,
    /// show connected status with the pairing field disabled; nothing about
    /// the pairing is touched. If NOT paired, this is just the ordinary
    /// empty "enter a code" first-pairing screen.</summary>
    NormalSettings,

    /// <summary>CASE B, unpaired machine — pre-fill the incoming code and
    /// enable the field so the user can review and click "Poveži". Never
    /// auto-submitted.</summary>
    PrefillUnpaired,

    /// <summary>CASE B, ALREADY paired machine — the explicit URI re-pair
    /// intent must win, but ONLY as a visible, confirmable offer: show the
    /// incoming code, a clear warning that pairing again replaces the
    /// existing one, and require an explicit "Poveži ponovo" click (or let
    /// the user "Otkaži" and keep the current pairing completely
    /// untouched). Never silently consumes the code.</summary>
    ConfirmRepair,
}

public sealed record PairingUiState(PairingUiMode Mode, string PairingCodeBoxText, bool PairingCodeBoxEnabled, bool ShowRepairWarning);

public static class PairingFlow
{
    public static PairingUiState Resolve(bool alreadyPaired, string? incomingPairingCode)
    {
        var code = string.IsNullOrWhiteSpace(incomingPairingCode) ? null : incomingPairingCode.Trim();

        if (alreadyPaired && code is not null)
            return new PairingUiState(PairingUiMode.ConfirmRepair, code, PairingCodeBoxEnabled: true, ShowRepairWarning: true);

        if (!alreadyPaired && code is not null)
            return new PairingUiState(PairingUiMode.PrefillUnpaired, code, PairingCodeBoxEnabled: true, ShowRepairWarning: false);

        if (alreadyPaired)
            return new PairingUiState(PairingUiMode.NormalSettings, "", PairingCodeBoxEnabled: false, ShowRepairWarning: false);

        // Not paired, no incoming code — ordinary first-time pairing screen.
        return new PairingUiState(PairingUiMode.NormalSettings, "", PairingCodeBoxEnabled: true, ShowRepairWarning: false);
    }
}
