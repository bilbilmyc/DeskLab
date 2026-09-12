using System;
using System.Drawing;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Collections.Generic;

// A small native desktop companion. No HTTP endpoint or credentials: all menu
// events go through inherited pipes, whose closure also ends the tray process.
internal sealed class TrayContext : ApplicationContext
{
    private readonly NotifyIcon icon;
    private readonly Control dispatcher = new Control();
    private readonly ToolStripMenuItem status = new ToolStripMenuItem("服务运行中");
    private readonly ToolStripMenuItem quit = new ToolStripMenuItem("退出 DeskLab");
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly Icon appIcon;
    private bool exiting;

    public TrayContext()
    {
        IntPtr handle = dispatcher.Handle;
        appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        icon = new NotifyIcon { Icon = appIcon, Text = "DeskLab · 本地服务运行中", Visible = true };
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开 DeskLab", null, delegate { Emit("open"); });
        menu.Items.Add(new ToolStripSeparator());
        status.Enabled = false;
        menu.Items.Add(status);
        menu.Items.Add(quit);
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += delegate { Emit("open"); };
        quit.Click += delegate { quit.Enabled = false; Emit("quit"); };
        var reader = new Thread(ReadCommands) { IsBackground = true, Name = "DeskLab tray pipe" };
        reader.Start();
        Emit("ready");
    }

    private static void Emit(string action)
    {
        try { Console.Out.WriteLine("{\"action\":\"" + action + "\"}"); Console.Out.Flush(); }
        catch { Application.Exit(); }
    }

    private void ReadCommands()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                var message = json.Deserialize<Dictionary<string, object>>(line);
                dispatcher.BeginInvoke((Action)(() => HandleCommand(message)));
            }
        }
        catch { }
        finally { try { dispatcher.BeginInvoke((Action)ExitThread); } catch { } }
    }

    private void HandleCommand(Dictionary<string, object> message)
    {
        if (exiting || !message.ContainsKey("type")) return;
        switch (Convert.ToString(message["type"]))
        {
            case "status":
                string text = Convert.ToString(message["text"]);
                status.Text = text;
                icon.Text = ("DeskLab · " + text).Length > 63 ? "DeskLab · 本地服务运行中" : "DeskLab · " + text;
                break;
            case "error":
                quit.Enabled = true;
                MessageBox.Show(Convert.ToString(message["message"]), "DeskLab", MessageBoxButtons.OK, MessageBoxIcon.Information, MessageBoxDefaultButton.Button1, MessageBoxOptions.DefaultDesktopOnly);
                break;
            case "close": ExitThread(); break;
        }
    }

    protected override void ExitThreadCore()
    {
        if (exiting) return;
        exiting = true;
        icon.Visible = false;
        icon.ContextMenuStrip.Dispose();
        icon.Dispose();
        appIcon.Dispose();
        dispatcher.Dispose();
        base.ExitThreadCore();
    }
}

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Console.SetIn(new System.IO.StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false)));
        Console.SetOut(new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayContext());
    }
}
