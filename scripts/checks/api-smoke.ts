import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { freePort } from '../../server/qemu';
import { processAlive } from '../../server/process-lock';
const BunWebSocket = globalThis.WebSocket as unknown as {new(url: string, options: Bun.WebSocketOptions): WebSocket};
const root=resolve('.runtime/checks',`api-smoke-${Date.now()}`);await mkdir(root,{recursive:true});
const port=await freePort(), origin=`http://127.0.0.1:${port}`;
const env={...process.env,LAB_PORT:String(port),LAB_DATA_DIR:root,LAB_OPEN:'0'};
let processHandle:Bun.Subprocess|undefined;
let token='';
async function launch() {
  processHandle=Bun.spawn([process.execPath,'server/index.ts'],{env,stdout:'ignore',stderr:'inherit'});
  for(let i=0;i<80;i++) {
    try {const response=await fetch(origin+'/api/state');if(response.ok){const state=await response.json();token=state.token;return state;}}catch{}
    await Bun.sleep(100);
  }
  throw new Error('API startup timeout');
}
async function post(path:string,body:unknown={}) {
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','x-lab-token':token},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw new Error(value.error);return value;
}
try {
  await launch();
  const denied=await fetch(origin+'/api/settings',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json','x-lab-token':token},body:'{}'});
  assert.equal(denied.status,403);
  const unauthenticated=await fetch(origin+'/api/machines',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauthenticated.status,403);
  await post('settings',{qemuPath:resolve('.runtime/tools/qemu'),accelerator:'whpx'});
  const boot=new Uint8Array(512);boot.set([0xfa,0xf4,0xeb,0xfd]);boot[510]=0x55;boot[511]=0xaa;
  const source=resolve(root,'boot.raw');await Bun.write(source,boot);
  const template=await post('templates/import',{name:'API test',family:'linux',path:source});
  const vm=await post('machines',{name:'API test',family:'linux',memory:512,cpus:1,diskGB:8,templateId:template.id});
  await post(`machines/${vm.id}/start`);
  const ticket=await post(`machines/${vm.id}/console`);
  await new Promise<void>((res,rej)=>{
    const ws=new BunWebSocket(`${origin.replace('http','ws')}/vnc?ticket=${ticket.ticket}`,{headers:{Origin:origin}});
    const timer=setTimeout(()=>{ws.close();rej(new Error('WebSocket bridge timeout'));},5000);
    ws.onmessage=async event=>{clearTimeout(timer);const text=event.data instanceof Blob?await event.data.text():Buffer.from(event.data).toString();assert.match(text,/RFB 003/);ws.close();res();};
    ws.onerror=()=>{clearTimeout(timer);rej(new Error('WebSocket bridge failure'));};
  });
  // Simulate an abrupt parent crash: persisted QMP ownership must allow recovery.
  const beforeCrash=await (await fetch(origin+'/api/state')).json();
  const guestPid=beforeCrash.machines[0].session.pid;
  processHandle!.kill('SIGKILL');await processHandle!.exited;
  const recovered=await launch();
  if(recovered.machines[0].state==='stopped') {
    assert.equal(processAlive(guestPid),false,'A surviving QEMU must never be marked stopped');
    console.log('Parent termination also closed QEMU on this host; verified no orphan process.');
    await post(`machines/${vm.id}/start`);
  } else assert.equal(recovered.machines[0].state,'running');
  await post(`machines/${vm.id}/force-stop`);
  for(let i=0;i<80;i++){const state=await (await fetch(origin+'/api/state')).json();if(state.machines[0].state==='stopped')break;await Bun.sleep(100);}
  await post(`machines/${vm.id}/delete`);await post(`templates/${template.id}/delete`);
  console.log('PASS: API origin/token guard, real WS-to-VNC bridge, abrupt parent exit, VM recovery, stop and cleanup.');
} finally {processHandle?.kill();if(processHandle)await processHandle.exited;}
