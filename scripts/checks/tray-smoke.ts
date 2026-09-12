import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {run} from '../../server/qemu';
import {startTray} from '../../server/tray';
import {buildTray} from '../build/build-tray';
const root=resolve(import.meta.dir,'../..'),dir=join(root,'.runtime','checks','tray');await mkdir(dir,{recursive:true});
const executable=await buildTray(),testExe=join(dir,'TrayHostTests.exe');
await run(join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:winexe','/main:TrayTests',`/out:${testExe}`,`/win32icon:${join(root,'installer','DeskLab.ico')}`,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',join(root,'native','windows','TrayHost.cs'),join(root,'tests','windows','TrayHostTests.cs')]);
let opened=0,quit=0;
const tray=await startTray(dir,{open:async()=>{opened++;},quit:async()=>{quit++;}},testExe);
try{
  tray.status('服务运行中 · 0 个环境运行中');
  for(let i=0;i<60&&quit===0;i++)await Bun.sleep(100);
  assert.equal(opened,1,'native open menu dispatches once');assert.equal(quit,1,'native quit menu dispatches once');
}finally{await tray.stop();}
assert.throws(()=>process.kill(tray.pid!,0),'native tray process must terminate');
const orphan=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const ended=once(orphan,'close');const timeout=setTimeout(()=>orphan.kill(),5000);
await once(orphan.stdout!,'data');orphan.stdin!.end();
const [code]=await ended;clearTimeout(timeout);assert.equal(code,0,'stdin EOF removes tray after service exit/crash');
console.log('PASS: real NotifyIcon menus, parent commands, clean close and parent-pipe loss.');
