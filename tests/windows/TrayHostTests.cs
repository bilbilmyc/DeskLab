using System;
using System.Reflection;
using System.Windows.Forms;
internal static class TrayTests
{
    [STAThread]
    private static void Main()
    {
        Console.SetIn(new System.IO.StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false)));
        Console.SetOut(new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
        Application.EnableVisualStyles();
        var context = new TrayContext();
        var icon = (NotifyIcon)typeof(TrayContext).GetField("icon", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(context);
        if (!icon.Visible || icon.ContextMenuStrip.Items.Count != 4) throw new Exception("Tray/menu missing");
        var timer = new Timer { Interval = 300 };
        timer.Tick += delegate {
            timer.Stop(); timer.Dispose();
            ((ToolStripMenuItem)icon.ContextMenuStrip.Items[0]).PerformClick();
            // A separate tick allows the parent to finish its open callback.
            var exitTimer = new Timer { Interval = 300 };
            exitTimer.Tick += delegate { exitTimer.Stop(); exitTimer.Dispose(); ((ToolStripMenuItem)icon.ContextMenuStrip.Items[3]).PerformClick(); };
            exitTimer.Start();
        };
        timer.Start();
        Application.Run(context);
    }
}
