import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { embeddedEngineDirectory } from './embedded-engine';

export async function executable(configured: string, imageTool = false) {
  const file = imageTool ? 'qemu-img' : 'qemu-system-x86_64';
  const ext = process.platform === 'win32' ? '.exe' : '';
  if (configured) {
    const dir = /qemu-system-x86_64(?:\.exe)?$/i.test(configured) ? dirname(configured) : configured;
    const target = join(dir, file + ext);
    try { await access(target); return target; } catch { return null; }
  }
  const embedded = embeddedEngineDirectory();
  if (embedded) return join(embedded, file + ext);
  const developmentEngine=join(process.cwd(),'.runtime','tools','qemu',file+ext);
  try {await access(developmentEngine);return developmentEngine;}catch{}
  for (const root of [dirname(process.execPath), process.cwd()]) {
    const portable = join(root, 'runtime', 'qemu', file + ext);
    try { await access(portable); return portable; } catch {}
  }
  return Bun.which(file) ?? (process.platform === 'win32' && await Bun.file(`C:/Program Files/qemu/${file}.exe`).exists() ? `C:/Program Files/qemu/${file}.exe` : null);
}
export function run(file: string, args: string[], timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', d => { output = (output + d).slice(-64000); });
    child.stderr.on('data', d => { output = (output + d).slice(-64000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('操作超时，请检查镜像文件和虚拟化组件')); }, timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(output.trim() || `进程退出，代码 ${code}`)); });
  });
}
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as {port: number}).port; s.close(() => resolve(port)); });
  });
}
export function qmp(port: number, command: string, args?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({host: '127.0.0.1', port});
    let pending = '', complete = false;
    const finish = (error?: Error, value?: unknown) => {
      if (complete) return; complete = true; socket.destroy(); error ? reject(error) : resolve(value);
    };
    socket.setTimeout(5000, () => finish(new Error('QMP 响应超时')));
    socket.on('error', e => finish(e));
    socket.on('close', () => { if (!complete) finish(new Error('QMP 连接已断开')); });
    socket.on('data', bytes => {
      pending += bytes.toString();
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const reply = JSON.parse(line);
          if (reply.QMP) socket.write(JSON.stringify({execute: 'qmp_capabilities', id: 'cap'}) + '\n');
          if (reply.id === 'cap') {
            if (reply.error) return finish(new Error(reply.error.desc));
            socket.write(JSON.stringify({execute: command, arguments: args, id: 'cmd'}) + '\n');
          }
          if (reply.id === 'cmd') finish(reply.error ? new Error(reply.error.desc) : undefined, reply.return);
        } catch { finish(new Error('QMP 返回了无效数据')); }
      }
    });
  });
}

export interface QmpEvent {event: string; data?: {guest?: boolean; reason?: string};}
// Dedicated event monitor: command connections remain available for consoles and probes.
export function watchQmp(port: number, event: (value: QmpEvent) => void, disconnected: () => void): Promise<() => void> {
  return new Promise((resolve,reject) => {
    const socket=createConnection({host:'127.0.0.1',port});
    let pending='', ready=false, closed=false;
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('QMP 事件连接超时'));},5000);
    socket.on('error',error=>{if(!ready)reject(error);});
    socket.on('close',()=>{clearTimeout(timer);if(!ready)reject(new Error('QMP 事件连接已断开'));else if(!closed)disconnected();});
    socket.on('data',bytes=>{
      pending+=bytes.toString();let end:number;
      while((end=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,end);pending=pending.slice(end+1);
        try{
          const value=JSON.parse(line);
          if(value.QMP)socket.write(JSON.stringify({execute:'qmp_capabilities',id:'events'})+'\n');
          if(value.id==='events'){
            if(value.error){reject(new Error(value.error.desc));socket.destroy();return;}
            ready=true;clearTimeout(timer);resolve(()=>{closed=true;socket.destroy();});
          }
          if(ready&&value.event)event(value);
        }catch{socket.destroy();return;}
      }
    });
  });
}
