// Shell bridge backend. Commands are resolved by canonical verb, never menu labels.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

[ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellFolder {
    [PreserveSig] int ParseDisplayName(IntPtr hwnd,IntPtr ctx,[MarshalAs(UnmanagedType.LPWStr)] string name,ref uint eaten,out IntPtr pidl,ref uint attrs);
    [PreserveSig] int EnumObjects(IntPtr hwnd,uint flags,out IEnumIDList result);
    [PreserveSig] int BindToObject(IntPtr pidl,IntPtr ctx,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out IShellFolder result);
    [PreserveSig] int BindToStorage(IntPtr pidl,IntPtr ctx,ref Guid iid,out IntPtr result);
    [PreserveSig] int CompareIDs(IntPtr flags,IntPtr a,IntPtr b);
    [PreserveSig] int CreateViewObject(IntPtr hwnd,ref Guid iid,out IntPtr result);
    [PreserveSig] int GetAttributesOf(uint count,IntPtr[] pidls,ref uint attrs);
    [PreserveSig] int GetUIObjectOf(IntPtr hwnd,uint count,[MarshalAs(UnmanagedType.LPArray,SizeParamIndex=1)] IntPtr[] pidls,ref Guid iid,IntPtr reserved,[MarshalAs(UnmanagedType.Interface)] out IContextMenu result);
    [PreserveSig] int GetDisplayNameOf(IntPtr pidl,uint flags,IntPtr strret);
    [PreserveSig] int SetNameOf(IntPtr hwnd,IntPtr pidl,[MarshalAs(UnmanagedType.LPWStr)]string name,uint flags,out IntPtr result);
}
[ComImport,Guid("000214F2-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IEnumIDList {
    [PreserveSig] int Next(uint count,out IntPtr pidl,out uint fetched);
    [PreserveSig] int Skip(uint count);
    [PreserveSig] int Reset();
    [PreserveSig] int Clone(out IEnumIDList value);
}
[ComImport,Guid("000214E4-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IContextMenu {
    [PreserveSig] int QueryContextMenu(IntPtr menu,uint index,uint first,uint last,uint flags);
    [PreserveSig] int InvokeCommand(ref InvokeInfo info);
    [PreserveSig] int GetCommandString(UIntPtr id,uint flags,IntPtr reserved,IntPtr buffer,uint size);
}
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] struct InvokeInfo { public int size; public uint mask; public IntPtr hwnd; public IntPtr verb; public string parameters; public string directory; public int show; public uint hotkey; public IntPtr icon; }
static class ShellBridge {
    [DllImport("shell32.dll")] static extern int SHGetDesktopFolder(out IShellFolder folder);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern int SHParseDisplayName(string name,IntPtr ctx,out IntPtr pidl,uint flags,out uint attrs);
    [DllImport("shlwapi.dll",CharSet=CharSet.Unicode)] static extern int StrRetToBufW(IntPtr strret,IntPtr pidl,StringBuilder output,uint size);
    [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr menu,int position);
    [DllImport("user32.dll")] static extern uint GetMenuState(IntPtr menu,uint item,uint flags);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetMenuStringW(IntPtr menu,uint item,StringBuilder output,int length,uint flags);
    static void Check(int hr){Marshal.ThrowExceptionForHR(hr);}
    public static string Execute(string action, string[] args) {
        if(action!="probe" && action!="createbridge" && action!="addtobridge" && action!="delete" && action!="removefrombridge")throw new Exception("Unsupported Shell action");
        uint? command=null;
        var names=new List<string>();var selected=new List<IntPtr>();var allocated=new List<IntPtr>();
        IShellFolder desktop,folder;IEnumIDList items;IntPtr root;uint attrs;
        Check(SHGetDesktopFolder(out desktop));Check(SHParseDisplayName("::{7007ACC7-3202-11D1-AAD2-00805FC1270E}",IntPtr.Zero,out root,0,out attrs));
        var iid=typeof(IShellFolder).GUID;Check(desktop.BindToObject(root,IntPtr.Zero,ref iid,out folder));Marshal.FreeCoTaskMem(root);
        Check(folder.EnumObjects(IntPtr.Zero,0x60,out items));IntPtr pidl;uint fetched;
        while(items.Next(1,out pidl,out fetched)==0&&fetched==1){
            allocated.Add(pidl);var strret=Marshal.AllocHGlobal(528);var name=new StringBuilder(512);
            try {Check(folder.GetDisplayNameOf(pidl,0,strret));Check(StrRetToBufW(strret,pidl,name,512));}finally{Marshal.FreeHGlobal(strret);}
            names.Add(name.ToString());if(Array.IndexOf(args,name.ToString())>=0)selected.Add(pidl);
        }
        var commands=new List<object>();
        if(selected.Count!=args.Length||selected.Count==0)throw new Exception("Requested adapter names did not match exactly.");
        IContextMenu context;var contextId=typeof(IContextMenu).GUID;Check(folder.GetUIObjectOf(IntPtr.Zero,(uint)selected.Count,selected.ToArray(),ref contextId,IntPtr.Zero,out context));
        var menu=CreatePopupMenu();
        try {
            Check(context.QueryContextMenu(menu,0,1,0x7fff,0));
            for(int i=0;i<GetMenuItemCount(menu);i++){
                uint id=GetMenuItemID(menu,i);if(id==0xffffffff||id==0)continue;
                var label=new StringBuilder(512);GetMenuStringW(menu,(uint)i,label,512,0x400);
                var buffer=Marshal.AllocHGlobal(1024);string verb="";int hr;
                try{Marshal.WriteInt16(buffer,0);hr=context.GetCommandString((UIntPtr)(id-1),4,IntPtr.Zero,buffer,512);if(hr>=0)verb=Marshal.PtrToStringUni(buffer);}finally{Marshal.FreeHGlobal(buffer);}
                if(verb==action&&(GetMenuState(menu,(uint)i,0x400)&3)==0)command=id-1;
                commands.Add(new {id,label=label.ToString(),verb,verbHResult=hr,enabled=(GetMenuState(menu,(uint)i,0x400)&3)==0});
            }
            if(action!="probe") { if(!command.HasValue)throw new Exception("Shell command unavailable: "+action); var info=new InvokeInfo {size=Marshal.SizeOf(typeof(InvokeInfo)),mask=0x100,verb=(IntPtr)command.Value,show=0}; Check(context.InvokeCommand(ref info)); }
            return new JavaScriptSerializer().Serialize(new {action,selected=args,commands});
        }finally{DestroyMenu(menu);Marshal.ReleaseComObject(context);foreach(var item in allocated)Marshal.FreeCoTaskMem(item);Marshal.ReleaseComObject(items);Marshal.ReleaseComObject(folder);Marshal.ReleaseComObject(desktop);}
    }
}
