import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,rename} from 'node:fs/promises';
import {basename,join} from 'node:path';
import trayAsset,{trayVersion} from './generated/tray';

export type TrayAction = 'ready'|'open'|'quit';
export function trayAction(line: string): TrayAction | undefined {
  try {const value=JSON.parse(line);if(value&&['ready','open','quit'].includes(value.action))return value.action;}catch{}
}
export function wantsTray() {
  return process.platform==='win32'&&process.env.LAB_TRAY!=='0'&&(process.env.LAB_TRAY==='1'||basename(process.execPath).toLowerCase()==='desklab.exe');
}
export function assertCanQuit(machines: Array<{state: string}>, runtimeCount: number) {
  if(runtimeCount || machines.some(vm=>['running','starting','stopping'].includes(vm.state)))throw new Error('还有环境正在运行。请打开 DeskLab，在系统内正常关机后，再从托盘退出。');
}
export async function startTray(root: string, actions: {open:()=>Promise<void>;quit:()=>Promise<void>}, executable?: string) {
  if(!executable) {
    if(trayAsset&&trayVersion) {
      const directory=join(root,'runtime','tray',trayVersion);await mkdir(directory,{recursive:true});
      executable=join(directory,'DeskLab.Tray.exe');
      const source=Bun.file(trayAsset);
      if(!await Bun.file(executable).exists() || Bun.file(executable).size!==source.size) {
        await Bun.write(executable+'.tmp',source);await rename(executable+'.tmp',executable);
      }
    } else executable=join(process.cwd(),'.runtime','build','native','DeskLab.Tray.exe');
  }
  const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});
  let closed=false,stopping=false,lastStatus='',stderr='';
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
  child.stdin.on('error',()=>{});
  const send=(message:unknown)=>{if(!closed&&!child.stdin.destroyed)child.stdin.write(JSON.stringify(message)+'\n');};
  let pending=false;
  const ready=new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Windows 托盘启动超时')),8000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',()=>{closed=true;clearTimeout(timer);lines.close();reject(new Error(stderr||'Windows 托盘已关闭'));if(!stopping)console.error('Windows 托盘意外关闭，请在浏览器内退出服务后重新打开 DeskLab。');});
    lines.on('line',line=>{
      const action=trayAction(line);
      if(action==='ready'){clearTimeout(timer);resolve();return;}
      if(!action||pending)return;
      pending=true;
      void actions[action]().catch(error=>send({type:'error',message:error instanceof Error?error.message:String(error)})).finally(()=>{pending=false;});
    });
  });
  try {await ready;}catch(error){stopping=true;child.kill();throw error;}
  return {
    pid:child.pid,
    status(text:string){if(text!==lastStatus){lastStatus=text;send({type:'status',text});}},
    async stop(){stopping=true;send({type:'close'});child.stdin.end();for(let i=0;i<20&&!closed;i++)await Bun.sleep(50);if(!closed)child.kill();},
  };
}
