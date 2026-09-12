import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {freePort,run} from '../../../server/qemu';
import {fileHash} from '../../../server/docker/managed/assets';
import {processAlive} from '../../../server/process-lock';
await mkdir('.runtime/checks/docker-managed',{recursive:true});const root=await mkdtemp(resolve('.runtime/checks/docker-managed/installed-')),installed=join(root,'DeskLab'),port=await freePort(),origin=`http://127.0.0.1:${port}`;
const checks:string[]=[];function check(value:unknown,name:string){assert.ok(value,name);checks.push(name);console.log('PASS '+name);}
let app:ChildProcess|undefined,token='',enginePid:number|undefined;
const logs:string[]=[];
async function state(){return(await fetch(origin+'/api/state')).json();}
async function docker(){return(await fetch(origin+'/api/docker')).json();}
async function post(path:string,body:unknown={}){const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','x-lab-token':token},body:JSON.stringify(body)}),data=await response.json();if(!response.ok)throw new Error(data.error);return data;}
async function done(op:{id:string}){for(let i=0;i<600;i++){const status=(await docker()).operations.find((o:any)=>o.id===op.id);if(status?.state==='failed')throw new Error(status.message);if(status?.state==='succeeded')return;await Bun.sleep(500);}throw new Error('Packaged operation timed out');}
async function launch(){const env={...process.env};for(const key of Object.keys(env))if(['path','programfiles','programw6432','programfiles(x86)'].includes(key.toLowerCase()))delete env[key];app=spawn(join(installed,'DeskLab.exe'),[],{cwd:installed,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env,PATH:process.env.SystemRoot+'\\System32',ProgramFiles:join(root,'no-desktop'),ProgramW6432:join(root,'no-desktop'),'ProgramFiles(x86)':join(root,'no-desktop'),LAB_PORT:String(port),LAB_OPEN:'0',LAB_TRAY:'1'}});app.stdout?.on('data',d=>logs.push(String(d)));app.stderr?.on('data',d=>logs.push(String(d)));for(let i=0;i<400;i++){try{token=(await state()).token;if(token)return;}catch{}await Bun.sleep(100);}throw new Error('Installed app did not start');}
async function quit(){await post('app/quit');for(let i=0;i<100&&app?.exitCode===null;i++)await Bun.sleep(100);check(app?.exitCode===0,'installed program exits cleanly');}
try {
 const setup=resolve('dist/installer/DeskLab-Setup.exe');await run(setup,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/DESKLABTEST=1','/COMPONENTS=app,docker',`/DIR=${installed}`,`/LOG=${join(root,'install.log')}`],180000);
 check(await fileHash(join(installed,'DeskLab.exe'))===await fileHash('dist/app/DeskLab.exe'),'full installer contains the current tested executable');
 check(await Bun.file(join(installed,'runtime/docker-engine/manifest.json')).exists(),'offline Linux and independent clients are installed as a component');
 await launch();const initial=await docker();check(initial.contexts.length===0&&initial.managed.available,'installed app works without a system Docker client or Desktop path');
 await done(await post('docker/managed/enable',{cpus:2,memoryMB:2048,diskGB:64}));let current=await docker();enginePid=current.managed.engine.pid;check(current.managed.engine.state==='running','installed component initializes its own Linux engine');
 const endpoint=await freePort();await done(await post('docker/containers',{name:'installed-http',image:'busybox:1.37',ports:[{hostPort:endpoint,targetPort:80}],command:['sh','-c','mkdir -p /site; echo packaged-engine > /site/index.html; exec httpd -f -p 80 -h /site']}));
 const text=await(await fetch(`http://127.0.0.1:${endpoint}`)).text();check(text.includes('packaged-engine'),'installed container is reachable through Windows port mapping');
 current=await docker();const container=current.containers.find((c:any)=>c.name==='installed-http');await done(await post(`docker/containers/${container.id}/exec`,{command:'echo persisted > /site/saved'}));
 await quit();check(!processAlive(enginePid),'normal app quit releases the dedicated QEMU process');
 token='';await launch();current=await docker();check(current.managed.engine.state==='stopped'&&!current.managed.engine.pid,'reopening the app does not automatically start the engine');
 await done(await post(`docker/containers/${container.id}/start`));const op=await post(`docker/containers/${container.id}/exec`,{command:'cat /site/saved'});await done(op);current=await docker();check(current.operations.find((o:any)=>o.id===op.id).message.includes('persisted'),'installed engine retains container data across app quit and restart');enginePid=current.managed.engine.pid;
 await quit();check(!processAlive(enginePid),'second exit leaves no engine process');
}finally{if(app?.exitCode===null){await post('docker/managed/stop').then(done).catch(()=>{});await post('app/quit').catch(()=>{});}await Bun.write(join(root,'report.json'),JSON.stringify({checks,root,logs},null,2));}
console.log(JSON.stringify({checks:checks.length,root}));
