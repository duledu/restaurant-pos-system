using System;
using System.Drawing;
using System.Windows.Forms;

namespace TableCore.PrintAgent;

/// <summary>
/// PRINTING P0 — TableCore-styled WinForms confirmation dialog. Replaces
/// the ugly system <c>MessageBox.Show(..., MessageBoxButtons.YesNo, ...)</c>
/// that the previous Setup wizard used for "Da li je test tiket
/// uspešno odštampan?".
///
/// Visual identity:
///   - Same warm-cream surface + graphite text palette as SetupForm so the
///     two read as one product (no white/grey "system dialog" look).
///   - Fixed single-column layout with generous padding so it never clips
///     Serbian text at 100/125/150 % DPI on Windows 10/11.
///   - 2-line title + descriptive body + two equal-weight buttons.
///     The destructive-leaning option ("Ne — pokušaj ponovo") is the
///     LEFT button (Windows convention) and is the keyboard default
///     only when the question phrasing would be misleading otherwise —
///     for "Da li je štampano?" the affirmative MUST be the safer action
///     since most operators want to confirm and move on, so YES is
///     Enter / keyboard default.
///
/// Return value: <c>DialogResult.Yes</c> or <c>DialogResult.No</c>.
/// The dialog is intentionally modal so the user cannot accidentally
/// click outside and lose context.
/// </summary>
internal sealed class WizardConfirmationForm : Form
{
    private readonly Label _titleLabel;
    private readonly Label _bodyLabel;
    private readonly Button _yesButton;
    private readonly Button _noButton;

    public WizardConfirmationForm(string title, string body)
    {
        Text = "TableCore Print Agent";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.CenterParent;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        MinimumSize = new Size(420, 0);
        BackColor = Color.FromArgb(0xFD, 0xF6, 0xE6); // cream-100, same as SetupForm
        Font = new Font("Segoe UI", 9.5F, FontStyle.Regular, GraphicsUnit.Point);
        KeyPreview = true;

        var layout = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            Dock = DockStyle.Fill,
            Padding = new Padding(20, 20, 20, 20),
        };

        _titleLabel = new Label
        {
            Text = title,
            AutoSize = true,
            MaximumSize = new Size(560, 0),
            Font = new Font("Segoe UI Semibold", 11F, FontStyle.Bold, GraphicsUnit.Point),
            ForeColor = Color.FromArgb(0x2A, 0x2A, 0x2A), // graphite
            Margin = new Padding(0, 0, 0, 12),
        };
        layout.Controls.Add(_titleLabel);

        _bodyLabel = new Label
        {
            Text = body,
            AutoSize = true,
            MaximumSize = new Size(560, 0),
            ForeColor = Color.FromArgb(0x4A, 0x4A, 0x4A),
            Margin = new Padding(0, 0, 0, 18),
        };
        layout.Controls.Add(_bodyLabel);

        var buttonRow = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            Dock = DockStyle.Bottom,
            Margin = new Padding(0, 8, 0, 0),
        };
        _yesButton = new Button
        {
            Text = "Da — radi",
            DialogResult = DialogResult.Yes,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(18, 8, 18, 8),
            Margin = new Padding(8, 0, 0, 0),
            BackColor = Color.FromArgb(0x1E, 0x7A, 0x3C), // success green
            ForeColor = Color.White,
            FlatStyle = FlatStyle.System,
        };
        _yesButton.FlatAppearance.BorderSize = 0;
        _noButton = new Button
        {
            Text = "Ne — pokušaj ponovo",
            DialogResult = DialogResult.No,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(14, 8, 14, 8),
            Margin = new Padding(0, 0, 8, 0),
            BackColor = Color.FromArgb(0xFD, 0xF6, 0xE6),
            ForeColor = Color.FromArgb(0x2A, 0x2A, 0x2A),
            FlatStyle = FlatStyle.System,
        };
        buttonRow.Controls.Add(_yesButton);
        buttonRow.Controls.Add(_noButton);
        layout.Controls.Add(buttonRow);

        AcceptButton = _yesButton;
        CancelButton = _noButton;

        Controls.Add(layout);

        // Escape cancels (treated as "Ne — pokušaj ponovo"); Enter confirms.
        KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Escape)
            {
                DialogResult = DialogResult.No;
                Close();
            }
        };
    }
}
