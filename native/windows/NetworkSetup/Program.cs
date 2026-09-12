using System;
using System.IO;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Net.NetworkInformation;
using System.Windows.Forms;
using System.Drawing;
using System.Threading;
using Microsoft.Win32;

static class Program {
    static readonly string Root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"DeskLab.NetworkSetup");
    static bool Admin { get {return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);} }
    static string Quote(string s) {return "\""+s.Replace("\"", "")+"\"";}
    static void SecureDirectory(string path) {
        if(Directory.Exists(path)&&(File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new Exception("Refusing reparse point");
        if(Directory.Exists(path)) {
            var owner=(SecurityIdentifier)Directory.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier));
            if(!owner.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid)&&!owner.IsWellKnown(WellKnownSidType.LocalSystemSid))throw new Exception("Network setup directory is not administrator-owned");
        }
        var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{WellKnownSidType.BuiltinAdministratorsSid,WellKnownSidType.LocalSystemSid})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid,null),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid,null),FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        if(!Directory.Exists(path))Directory.CreateDirectory(path,acl);else Directory.SetAccessControl(path,acl);
    }
    [STAThread] static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        try {
            if(args.Length>=3&&args[0]=="--shell") {
                if(args[1]!="probe"&&!Admin)throw new Exception("Administrator required");
                var names=args.Skip(2).Select(s=> {
                    var adapterId=Guid.Parse(s);
                    // Bridged TAP adapters may be absent from GetAdaptersAddresses because IP is unbound.
                    using(var connection=Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Network\{4D36E972-E325-11CE-BFC1-08002BE10318}\"+adapterId.ToString("B")+@"\Connection")) {
                        string name=connection==null?null:connection.GetValue("Name") as string;
                        if(String.IsNullOrEmpty(name))throw new Exception("Adapter GUID no longer exists");return name;
                    }
                }).ToArray();
                Console.WriteLine(ShellBridge.Execute(args[1],names));return 0;
            }
            if(args.Length!=4 || (args[0]!="--run"&&args[0]!="--interactive"&&args[0]!="--elevated"))throw new Exception("Invalid arguments");
            string action=args[1],id=Guid.Parse(args[2]).ToString(),target=Guid.Parse(args[3]).ToString();
            if(action!="isolated"&&action!="prepare"&&action!="rollback")throw new Exception("Invalid action");
            if(args[0]=="--run"||args[0]=="--interactive") {
                Process process=null;
                var launch=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"--elevated "+action+" "+id+" "+target){UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden};
                if(args[0]=="--interactive") {
                    Application.EnableVisualStyles();
                    using(var form=new Form {Text="DeskLab 网络配置",Size=new Size(480,230),StartPosition=FormStartPosition.CenterScreen,TopMost=true,MaximizeBox=false,MinimizeBox=false,FormBorderStyle=FormBorderStyle.FixedDialog}) {
                        var label=new Label {Text=action=="rollback"?"Windows 管理员授权\n\n撤销 DeskLab 日志记录的测试网桥和 TAP 网卡。\n不会修改其他网卡。":"Windows 管理员授权\n\n将安装签名 TAP 驱动，并创建、撤销两块独立测试网卡。\n不会接入正在联网的物理网卡。",AutoSize=false,Location=new Point(20,20),Size=new Size(430,110)};
                        var button=new Button {Text="继续管理员授权",Location=new Point(270,140),Size=new Size(165,32)};
                        button.Click+=(s,e)=>{try{launch.ErrorDialog=true;launch.ErrorDialogParentHandle=form.Handle;process=Process.Start(launch);form.Close();}catch(Exception ex){label.Text=ex.Message;}};
                        form.Controls.Add(label);form.Controls.Add(button);form.AcceptButton=button;
                        form.Shown+=(s,e)=>form.BeginInvoke(new Action(()=>{form.Activate();button.PerformClick();}));
                        Application.Run(form);
                    }
                    if(process==null)throw new Exception("已取消管理员授权");
                } else process=Process.Start(launch);
                process.WaitForExit();
                string status=Path.Combine(Root,id,"status.json");
                if(File.Exists(status))Console.WriteLine(File.ReadAllText(status));
                else throw new Exception("Network helper ended without a result ("+process.ExitCode+")");
                return process.ExitCode;
            }
            if(!Admin)throw new Exception("Administrator required");
            bool created;var mutex=new Mutex(true,"Global\\DeskLab.NetworkSetup",out created);
            if(!created){mutex.Dispose();throw new Exception("另一个网络助手正在运行");}
            // The operating system releases this mutex if the helper is interrupted.
            SecureDirectory(Root);string work=Path.Combine(Root,id);SecureDirectory(work);
            // Resources come from this executable, not from caller-provided paths.
            foreach(string resource in Assembly.GetExecutingAssembly().GetManifestResourceNames()) {
                string dest=Path.Combine(work,resource);
                if(File.Exists(dest)&&(File.GetAttributes(dest)&FileAttributes.ReparsePoint)!=0)throw new Exception("Refusing reparse point");
                using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))using(var output=new FileStream(dest,FileMode.Create,FileAccess.Write,FileShare.None))input.CopyTo(output);
            }
            string self=Path.Combine(work,"DeskLab.NetworkSetup.exe");
            if(File.Exists(self)&&(File.GetAttributes(self)&FileAttributes.ReparsePoint)!=0)throw new Exception("Refusing reparse point");
            if(!String.Equals(Assembly.GetExecutingAssembly().Location,self,StringComparison.OrdinalIgnoreCase))File.Copy(Assembly.GetExecutingAssembly().Location,self,true);
            string script="$ErrorActionPreference='Stop'; & "+"'"+Path.Combine(work,"setup.ps1").Replace("'","''")+"' -Action "+action+" -Target "+target;
            var start=new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,"WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script))){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=work};
            var child=Process.Start(start);child.WaitForExit();GC.KeepAlive(mutex);mutex.ReleaseMutex();mutex.Dispose();return child.ExitCode;
        }catch(Exception e){Console.WriteLine(new JavaScriptSerializer().Serialize(new {state="failed",message=e.Message}));return 1;}
    }
}
