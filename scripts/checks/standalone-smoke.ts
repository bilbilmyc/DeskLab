import assert from 'node:assert/strict';
import { readdir, mkdir, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { qmp, run } from '../../server/qemu';
import type { LabSnapshot, Machine, Template } from '../../shared/types';

// This test talks only to the dedicated, already running standalone EXE fixture.
const origin = 'http://127.0.0.1:43226';
const root = resolve('.runtime/checks/standalone-user/DeskLab/data');
const exeDirectory = resolve('.runtime/checks/standalone-exe');
const fixture = join(root, 'smoke');
const marker = 'DESKLAB STANDALONE OK';
const BunWebSocket = globalThis.WebSocket as unknown as {new(url: string, options: Bun.WebSocketOptions): WebSocket};
let token = '', machineId: string | undefined, templateId: string | undefined;

async function snapshot() { return await (await fetch(`${origin}/api/state`)).json() as LabSnapshot & {token: string}; }
async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${origin}/api/${path}`, {method:'POST', headers:{'Content-Type':'application/json', 'x-lab-token':token}, body:JSON.stringify(body)});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}
async function processPath(pid: number) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).Path`])).trim();
}
async function waitStopped(id: string) {
  for (let attempt=0; attempt<100; attempt++) {
    const vm = (await snapshot()).machines.find(value => value.id === id);
    if (vm?.state === 'stopped' && !vm.session) return;
    await Bun.sleep(100);
  }
  throw new Error('Dedicated smoke VM did not stop');
}
async function checkVnc(id: string) {
  const {ticket} = await post<{ticket:string}>(`machines/${id}/console`);
  await new Promise<void>((resolve, reject) => {
    const ws = new BunWebSocket(`${origin.replace('http','ws')}/vnc?ticket=${ticket}`, {headers:{Origin:origin}});
    let settled = false;
    const finish = (error?: unknown) => { if(settled)return;settled=true;clearTimeout(timer);ws.close();error?reject(error):resolve(); };
    const timer = setTimeout(() => finish(new Error('Standalone VNC bridge timed out')), 5000);
    ws.onmessage = async event => {
      try {
        const greeting = event.data instanceof Blob ? await event.data.text() : Buffer.from(event.data).toString();
        assert.match(greeting, /^RFB 003\./); finish();
      } catch(error) { finish(error); }
    };
    ws.onerror = () => finish(new Error('Standalone VNC bridge failed'));
    ws.onclose = () => {if(!settled)finish(new Error('Standalone VNC bridge closed before greeting'));};
  });
}

const health = await (await fetch(`${origin}/api/health`)).json();
assert.equal(await realpath(health.dataDirectory), await realpath(root), 'Refusing to mutate any other DeskLab data directory');
assert.deepEqual((await readdir(exeDirectory)).sort(), ['DeskLab.exe'], 'Fixture must contain only the distributable EXE');
assert.equal((await processPath(health.pid)).toLowerCase(), join(exeDirectory,'DeskLab.exe').toLowerCase());
const before = await snapshot(); token = before.token;
assert.equal(before.settings.qemuPath, '', 'QEMU must be found without source-tree configuration');
assert.equal(before.host.qemuFound, true); assert.equal(before.host.imageToolFound, true);
assert.equal(before.host.isoDirectory, join(root,'iso'));
const html = await fetch(origin + '/');
assert.equal(html.status,200); assert.match(await html.text(), /DeskLab/);
await mkdir(fixture,{recursive:true});

// A real-mode boot sector writes a signature to VGA RAM, then halts. This proves
// the imported disk executed, rather than only checking that QEMU stayed alive.
const code = [0xfa, 0xb8, 0x00, 0xb8, 0x8e, 0xc0, 0x31, 0xff];
for (const character of marker) code.push(0xb8, character.charCodeAt(0), 0x0f, 0xab);
code.push(0xf4, 0xeb, 0xfd);
const sector = new Uint8Array(512); sector.set(code); sector[510]=0x55; sector[511]=0xaa;
const source = join(fixture,'standalone-boot.raw'); await Bun.write(source,sector);
try {
  const template = await post<Template>('templates/import',{name:'Standalone smoke template',family:'linux',firmware:'bios',path:source});
  templateId=template.id;
  const vm = await post<Machine>('machines',{name:'Standalone smoke VM',family:'linux',memory:512,cpus:1,diskGB:8,templateId});
  machineId=vm.id;
  const started = await post<Machine>(`machines/${machineId}/start`);
  assert.equal(started.state,'running'); assert(started.session?.pid);
  const qemuPath = await processPath(started.session.pid);
  const engineRelative = relative(join(root,'runtime'),qemuPath);
  assert(engineRelative && !engineRelative.startsWith('..') && !isAbsolute(engineRelative), 'QEMU must execute from extracted user-data runtime');
  const identity = await qmp(started.session.qmpPort,'query-name') as {name:string};
  assert.equal(identity.name,`DeskLab-${machineId}`);
  const state = await qmp(started.session.qmpPort,'query-status') as {running:boolean}; assert.equal(state.running,true);
  let actual = '';
  for(let attempt=0;attempt<100;attempt++) {
    const memory = await qmp(started.session.qmpPort,'human-monitor-command',{'command-line':`xp /${marker.length*2}bx 0xb8000`}) as string;
    const bytes = [...memory.matchAll(/0x([a-f0-9]{2})(?=\s|$)/gi)].map(match=>parseInt(match[1],16));
    actual = String.fromCharCode(...bytes.filter((_, index)=>index%2===0));
    if(actual===marker)break;
    await Bun.sleep(100);
  }
  assert.equal(actual,marker,'Imported boot sector did not execute');
  await checkVnc(machineId);
  await post(`machines/${machineId}/force-stop`); await waitStopped(machineId);
  await post(`machines/${machineId}/delete`); machineId=undefined;
  await post(`templates/${templateId}/delete`); templateId=undefined;
  const after = await snapshot();
  assert.deepEqual(after.machines.map(x=>x.id).sort(),before.machines.map(x=>x.id).sort());
  assert.deepEqual(after.templates.map(x=>x.id).sort(),before.templates.map(x=>x.id).sort());
  console.log('PASS: EXE-only distribution, user-data engine extraction, external raw import, executed boot signature, QMP identity, browser VNC bridge, stop and cleanup.');
} finally {
  if(machineId) {
    const vm=(await snapshot()).machines.find(x=>x.id===machineId);
    if(vm?.session){await post(`machines/${machineId}/force-stop`);await waitStopped(machineId);}
    if(vm)await post(`machines/${machineId}/delete`);
  }
  if(templateId)await post(`templates/${templateId}/delete`);
}
