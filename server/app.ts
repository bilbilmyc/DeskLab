import { basename, join, resolve } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { ZodError } from 'zod';
import { Store } from './store';
import { Lab } from './lab';
import { idInput } from './validation';
import embedded from './generated/web';
import { lockDirectory } from './process-lock';
import { listFiles } from './file-picker';
import {inspectIso} from './iso-inspection';
import { extractEngine } from './embedded-engine';
import {bindAvailable,existingInstance,openBrowser,preferredPort,publishInstance,wantsBrowser} from './startup';
import {version} from '../package.json';
import {assertCanQuit,startTray,wantsTray} from './tray';
import {networkCapabilities} from './network';
import {PortMappings} from './ports';
import {DockerService} from './docker/service';
import {ComposeProjects} from './docker/compose';
import {Diagnostics} from './diagnostics';

export async function startDeskLab(bundle:string,root:string) {
let port = preferredPort();
const requestedPort = port;
let origin = `http://127.0.0.1:${port}`;
const development = process.env.LAB_DEV === '1';
const shouldOpen = wantsBrowser();
const existing=await existingInstance(root,port);
if(existing){if(shouldOpen)await openBrowser(existing);return;}
let unlock:()=>Promise<void>;
try {unlock=await lockDirectory(root);}catch(error){
  // The first process may still be preparing its engine when a second click arrives.
  if((error as Error).message.includes('本地数据锁')||(error as Error).message.includes('另一个 DeskLab')){
    for(let attempt=0;attempt<100;attempt++){
      const existing=await existingInstance(root,port);
      if(existing){if(shouldOpen)await openBrowser(existing);return;}
      await Bun.sleep(100);
    }
  }
  throw error;
}
let recoveryTimer:ReturnType<typeof setInterval>|undefined,removeInstance:(()=>Promise<void>)|undefined;
let tray:Awaited<ReturnType<typeof startTray>>|undefined,trayTimer:ReturnType<typeof setInterval>|undefined;
try {
const store = new Store(root);
await store.init();
if (basename(process.execPath).toLowerCase() === 'desklab.exe') await extractEngine(root);
const bundleIso = join(bundle, 'iso');
const isoDirectory = await stat(bundleIso).then(s=>s.isDirectory()).catch(()=>false) ? bundleIso : join(root, 'iso');
await mkdir(isoDirectory, {recursive:true});
const lab = new Lab(store, isoDirectory), token = crypto.randomUUID();
const diagnostics = new Diagnostics(() => ({root: store.root, isoDirectory: lab.isoDirectory(), settings: {...store.data.settings}, requestedPort, actualPort: port}));
const mappings=new PortMappings(store,lab),docker=new DockerService(store),compose=new ComposeProjects(docker);
await docker.backups.recover();await docker.managed.recover();
await lab.recover();
recoveryTimer=setInterval(()=>void lab.exclusive(()=>lab.refreshRecovered()).catch(console.error),5000);
let exitRequested=false;
const tickets = new Map<string, {id: string; expires: number}>();
type WSData = {id: string; socket?: Socket; devUrl?: string; upstream?: WebSocket; pending?: (string|Buffer)[]};
const responseJson = (value: unknown, status = 200) => Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
const server = bindAvailable(port,listenPort=>Bun.serve<WSData>({
  hostname: '127.0.0.1', port:listenPort, idleTimeout: 255, maxRequestBodySize: 64 * 1024,
  async fetch(request, server) {
    const url = new URL(request.url);
    const json = (value: unknown, status = 200, error?: unknown) => {
      if (request.method === 'POST' && request.headers.get('x-lab-token') === token) diagnostics.events.record(url.pathname, status, error);
      return responseJson(value, status);
    };
    if (request.headers.get('host') !== `127.0.0.1:${port}`) return json({error: '无效的主机地址'}, 403);
    const requestOrigin = request.headers.get('origin');
    if (requestOrigin && requestOrigin !== origin) return json({error: '拒绝跨站请求'}, 403);
    if (development && url.pathname.startsWith('/_next/') && request.headers.get('upgrade')?.toLowerCase()==='websocket') {
      if (server.upgrade(request,{data:{id:'hmr',devUrl:`ws://127.0.0.1:3000${url.pathname}${url.search}`,pending:[]}})) return;
      return new Response('WebSocket required',{status:400});
    }
    if (url.pathname === '/vnc') {
      if (requestOrigin !== origin) return json({error: '桌面连接来源无效'}, 403);
      const key = url.searchParams.get('ticket') ?? '', ticket = tickets.get(key);
      tickets.delete(key);
      const runtime = ticket ? await lab.checkedRuntime(ticket.id).catch(()=>undefined) : undefined;
      if (!ticket || ticket.expires < Date.now() || !runtime || runtime.exited) return json({error: '连接凭据已失效，请重新连接'}, 403);
      if (server.upgrade(request, {data: {id: ticket.id}})) return;
      return json({error: '无法升级桌面连接'}, 400);
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        if (request.method === 'GET' && url.pathname === '/api/state') return json({...await lab.snapshot(), token});
        if (request.method === 'GET' && url.pathname === '/api/network') return json(await networkCapabilities(url.searchParams.get('refresh')==='1'));
        if (request.method === 'GET' && url.pathname === '/api/network/mappings') {if(docker.engine())await docker.snapshot();return json([...mappings.list(),...docker.mappings()]);}
        if (request.method === 'GET' && url.pathname === '/api/docker') return json(await docker.snapshot());
        if (url.pathname === '/api/network/setup') return json({error:'桥接配置已停用，当前版本仅支持 NAT。'},410);
        if (request.method === 'GET' && url.pathname === '/api/health') return json({ok: true, version, pid: process.pid, dataDirectory: store.root});
        if (request.method !== 'POST' || request.headers.get('x-lab-token') !== token) return json({error: '请求凭据无效，请刷新页面'}, 403);
        if (!request.headers.get('content-type')?.startsWith('application/json')) return json({error: '需要 JSON 请求'}, 415);
        const body = await request.json();
        if(exitRequested)return json({error:'DeskLab 正在退出'},409);
        if(url.pathname==='/api/diagnostics/check')return json(await diagnostics.check(body?.refresh === true));
        if(url.pathname==='/api/diagnostics/export')return json(await diagnostics.export());
        const managedAction=url.pathname.match(/^\/api\/docker\/managed\/(enable|start|stop|force-stop|select|backup|restore|rebuild|configure)$/);
        if(managedAction)return json(docker.managedAction(managedAction[1],body),202);
        if(url.pathname==='/api/docker/managed/logs')return json({text:await docker.managed.logs()});
        if(url.pathname==='/api/docker/connect')return json(await docker.connect(body));
        if(url.pathname==='/api/docker/pull')return json(docker.pull(body),202);
        if(url.pathname==='/api/docker/containers')return json(docker.create(body),202);
        if(url.pathname==='/api/docker/projects')return json(await compose.import(body));
        const containerAction=url.pathname.match(/^\/api\/docker\/containers\/([a-f0-9]{64})\/(start|stop|restart|delete|logs|exec)$/);
        if(containerAction)return json(containerAction[2]==='logs'?await docker.logs(containerAction[1]):containerAction[2]==='exec'?docker.exec(containerAction[1],body):docker.control(containerAction[1],containerAction[2]));
        const projectAction=url.pathname.match(/^\/api\/docker\/projects\/([^/]+)\/(up|stop|down|delete)$/);
        if(projectAction)return json(compose.control(idInput.parse(projectAction[1]),projectAction[2]),202);
        // Directory browsing is read-only and must not lock VM operations.
        if (url.pathname === '/api/files/list') return json(await listFiles(body,lab.isoDirectory()));
        if (url.pathname === '/api/isos/inspect') return json(await inspectIso(body));
        const value = await lab.exclusive(async () => {
          if(exitRequested)throw new Error('DeskLab 正在退出');
          if(url.pathname==='/api/app/quit'){
            assertCanQuit(store.data.machines,lab.runtime.size);
            exitRequested=true;
            try{await docker.shutdown();}catch(error){exitRequested=false;throw error;}
            setTimeout(()=>void quit(),300);return {ok:true};
          }
          if (url.pathname === '/api/settings') return lab.settings(body);
          if (url.pathname === '/api/network/mappings') return mappings.save(body);
          const mappingAction=url.pathname.match(/^\/api\/network\/mappings\/([^/]+)\/(update|delete)$/);
          if(mappingAction)return mappingAction[2]==='delete'?mappings.remove(idInput.parse(mappingAction[1])):mappings.save(body,idInput.parse(mappingAction[1]));
          if (url.pathname === '/api/isos/scan') return lab.isoLibrary();
          if (url.pathname === '/api/ssh/key') return lab.sshKeys.ensure();
          const isoMatch=url.pathname.match(/^\/api\/isos\/([a-z0-9-]+)\/(download|pause)$/);
          if(isoMatch)return isoMatch[2]==='download'?lab.downloadIso(isoMatch[1]):lab.pauseIso(isoMatch[1]);
          if (url.pathname === '/api/machines') return lab.create(body);
          if (url.pathname === '/api/templates/import') return lab.importTemplate(body);
          const match = url.pathname.match(/^\/api\/machines\/([^/]+)\/(start|stop|force-stop|reset|delete|eject|template|console|network)$/);
          if (match) {
            const id = idInput.parse(match[1]);
            switch (match[2]) {
              case 'start': return lab.start(id);
              case 'network': return lab.updateNetwork(id,body);
              case 'stop': return lab.power(id);
              case 'force-stop': return lab.power(id, true);
              case 'reset': return lab.reset(id);
              case 'delete': await lab.remove(id); return {ok: true};
              case 'eject': return lab.eject(id);
              case 'template': return lab.saveTemplate(id, body);
              case 'console': {
                const runtime = await lab.checkedRuntime(id);
                if (!runtime || runtime.exited) throw new Error('请先启动环境');
                for (const [key, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(key);
                const ticket = crypto.randomUUID(); tickets.set(ticket, {id, expires: Date.now() + 30000});
                return {ticket};
              }
            }
          }
          const templateMatch = url.pathname.match(/^\/api\/templates\/([^/]+)\/(delete|update)$/);
          if (templateMatch) {
            const id = idInput.parse(templateMatch[1]);
            if (templateMatch[2] === 'update') return lab.updateTemplate(id, body);
            await lab.removeTemplate(id); return {ok: true};
          }
          throw new Error('接口不存在');
        });
        return json(value);
      } catch (error) {
        const message = error instanceof ZodError ? error.issues.map(x => x.message).join('；') : error instanceof Error ? error.message : '操作失败';
        return json({error: message}, 400, error);
      }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', {status: 405});
    if (development) {
      try {
        const response = await fetch(`http://127.0.0.1:3000${url.pathname}${url.search}`, {headers: {accept: request.headers.get('accept') ?? '*/*', 'accept-encoding': 'identity'}});
        const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.delete('content-length'); headers.delete('transfer-encoding');
        return new Response(response.body, {status: response.status, headers});
      }
      catch { return new Response('界面正在启动，请稍后刷新。', {status: 503}); }
    }
    const key = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
    const asset = embedded[key as keyof typeof embedded];
    if (asset) return new Response(Buffer.from(asset.body, 'base64'), {headers: {'Content-Type': asset.type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "frame-ancestors 'none'"}});
    const filePath = resolve('dist/web', `.${key}`);
    if (!filePath.startsWith(resolve('dist/web') + (process.platform === 'win32' ? '\\' : '/'))) return new Response('Forbidden', {status: 403});
    const file = Bun.file(filePath);
    return await file.exists() ? new Response(file,{headers:{'Content-Security-Policy':"frame-ancestors 'none'"}}) : new Response('Not found', {status: 404});
  },
  websocket: {
    open(ws) {
      if(ws.data.devUrl) {
        const upstream=new WebSocket(ws.data.devUrl); ws.data.upstream=upstream;upstream.binaryType='arraybuffer';
        upstream.onopen=()=>{for(const message of ws.data.pending??[]) upstream.send(typeof message==='string'?message:new Uint8Array(message));ws.data.pending=[];};
        upstream.onmessage=e=>{if(typeof e.data==='string')ws.sendText(e.data);else ws.sendBinary(new Uint8Array(e.data));};
        upstream.onclose=()=>ws.close();upstream.onerror=()=>ws.close(1011,'开发服务已断开');return;
      }
      const runtime = lab.runtime.get(ws.data.id);
      if (!runtime || runtime.exited) { ws.close(1011, '环境已关闭'); return; }
      const socket = createConnection({host: '127.0.0.1', port: runtime.vncPort}); ws.data.socket = socket;
      socket.on('data', data => { const sent = ws.sendBinary(data); if (sent === -1) socket.pause(); });
      socket.on('error', () => ws.close(1011, '桌面连接失败'));
      socket.on('close', () => ws.close(1000, '环境已关闭'));
    },
    message(ws, message) {
      if(ws.data.devUrl) {if(ws.data.upstream?.readyState===WebSocket.OPEN)ws.data.upstream.send(message);else if((ws.data.pending?.length??0)<32)ws.data.pending?.push(message);return;}
      const socket = ws.data.socket;
      if (!socket || socket.destroyed) return;
      if (socket.writableLength > 4 * 1024 * 1024) { ws.close(1009, '输入缓冲区已满'); return; }
      socket.write(typeof message === 'string' ? Buffer.from(message) : message);
    },
    drain(ws) { ws.data.socket?.resume(); },
    close(ws) { ws.data.socket?.destroy(); ws.data.upstream?.close(); },
    maxPayloadLength: 4 * 1024 * 1024, backpressureLimit: 8 * 1024 * 1024,
  },
}));
port=server.port!;origin=`http://127.0.0.1:${port}`;
try{removeInstance=await publishInstance(root,port);}catch(error){server.stop(true);throw error;}
console.log(`DeskLab ${version} · ${origin}\n数据目录：${store.root}\n关闭浏览器后服务仍在运行，可从右下角 DeskLab 托盘菜单退出。`);
let quitting = false;
async function quit() {
  if (quitting) return;
  quitting = true; clearInterval(recoveryTimer);clearInterval(trayTimer);
  let code = 0;
  try { await docker.shutdown(); }
  catch(error){code=1;console.error('退出时 Docker 工作负载未能停止：',error);}
  try { await lab.shutdown(); }
  catch (error) { code = 1; console.error('退出时部分进度未能保存：', error); }
  finally {
    await tray?.stop();server.stop(true);
    try { await removeInstance?.(); } catch(error) {code=1;console.error('清理程序地址失败：',error);}
    try { await unlock(); } catch (error) { code = 1; console.error('释放程序锁失败：', error); }
    process.exit(code);
  }
}
process.on('SIGINT', () => void quit()); process.on('SIGTERM', () => void quit());
if(wantsTray()) {
  try {
    tray=await startTray(root,{open:()=>openBrowser(origin),quit:()=>lab.exclusive(async()=>{
      assertCanQuit(store.data.machines,lab.runtime.size);
      if(exitRequested)return;exitRequested=true;
      try{await docker.shutdown();}catch(error){exitRequested=false;throw error;}
      setTimeout(()=>void quit(),0);
    })});
      const status=()=>{const engine=docker.managed.record();tray?.status(`服务运行中 · ${lab.runtime.size} 个环境${engine?.pid?' · 内置 Docker 运行中':''}`);};
    status();trayTimer=setInterval(status,2000);
  }catch(error){const {reportStartupError}=await import('./startup');await reportStartupError(new Error(`托盘未能启动。仍可在浏览器内点击“退出程序”。${String(error)}`),root,true);}
}
if (shouldOpen) {void openBrowser(origin).catch(async error=>{const {reportStartupError}=await import('./startup');await reportStartupError(error,root);});}
}catch(error){if(recoveryTimer)clearInterval(recoveryTimer);if(trayTimer)clearInterval(trayTimer);await tray?.stop();await removeInstance?.();await unlock();throw error;}
}
