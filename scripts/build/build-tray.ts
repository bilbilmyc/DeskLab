import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {run} from '../../server/qemu';
export async function buildTray() {
  const root=resolve(import.meta.dir,'../..'),directory=join(root,'.runtime','build','native');
  await mkdir(directory,{recursive:true});
  const executable=join(directory,'DeskLab.Tray.exe');
  const compiler=join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  await run(compiler,['/nologo','/target:winexe','/optimize+','/platform:anycpu',`/out:${executable}`,`/win32icon:${join(root,'installer','DeskLab.ico')}`,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',join(root,'native','windows','TrayHost.cs')]);
  return executable;
}
if(import.meta.main)console.log(await buildTray());
