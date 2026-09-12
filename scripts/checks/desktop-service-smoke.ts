import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createConfigIso} from '../../server/install-media';
import {freePort,qmp,run} from '../../server/qemu';
const project=resolve(import.meta.dir,'../..');await mkdir(join(project,'.runtime/checks'),{recursive:true});
const root=await mkdtemp(join(project,'.runtime/checks/desktop-service-')),port=await freePort(),origin=`http://127.0.0.1:${port}`;
const exe=join(project,'dist/app/DeskLab.exe');
const app=spawn(exe,[],{cwd:project,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,LAB_DATA_DIR:root,LAB_PORT:String(port),LAB_OPEN:'0',LAB_TRAY:'1'}});
let appLog='';app.stdout.on('data',d=>{appLog=(appLog+d).slice(-4000);});app.stderr.on('data',d=>{appLog=(appLog+d).slice(-4000);});
let token='',vmId='',trayPid=0;
const checks:string[]=[];const check=(value:unknown,name:string)=>{assert.ok(value,name);checks.push(name);};
async function state(){return(await fetch(origin+'/api/state')).json();}
async function post(path:string,body:unknown={}){const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','x-lab-token':token},body:JSON.stringify(body)});return {response,value:await response.json()};}
try {
  for(let i=0;i<400;i++){try{const data=await state();token=data.token;break;}catch{}await Bun.sleep(100);}
  check(!!token,'packaged application starts from isolated data');
  for(let i=0;i<40;i++){
    const output=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter "ParentProcessId=${app.pid} AND Name='DeskLab.Tray.exe'" | Select-Object -ExpandProperty ProcessId`]);
    trayPid=Number(output);if(trayPid)break;await Bun.sleep(100);
  }
  check(trayPid>0,'packaged tray helper is embedded, extracted and running');
  check((await fetch(origin)).ok,'embedded page serves successfully');
  const key=(await post('ssh/key')).value;check(key.publicKey?.startsWith('ssh-ed25519 '),'API prepares public key metadata');
  check(!(JSON.stringify(await state())).includes('BEGIN OPENSSH PRIVATE KEY'),'private key is absent from API snapshot');
  const privateBefore=await readFile(key.privateKeyPath);await post('ssh/key');check((await readFile(key.privateKeyPath)).equals(privateBefore),'repeated key preparation preserves identity');
  const capabilities=await(await fetch(origin+'/api/network')).json();check(Array.isArray(capabilities.adapters),'network capabilities endpoint returns adapter inventory');
  const setup=await fetch(origin+'/api/network/setup');check(setup.status===410,'bridge setup endpoint is retired');
  const denied=await fetch(origin+'/api/network/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'validate'})});check(denied.status===410,'retired bridge setup cannot request elevation');
  const invalid=await post('network/setup',{action:'validate',command:'forbidden'});check(!invalid.response.ok,'network setup refuses arbitrary command fields without starting a helper');
  check(!existsSync(join(root,'runtime','network')),'NAT-only package does not extract a network administrator helper');
  const wrongIso=join(root,'renamed-ubuntu.iso');await createConfigIso(wrongIso,'Rocky-9-8',{'marker':'wrong family fixture'});
  const deniedIso=await fetch(origin+'/api/isos/inspect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:wrongIso,family:'ubuntu'})});
  check(deniedIso.status===403,'ISO inspection requires authenticated local request');
  const inspected=await post('isos/inspect',{path:wrongIso,family:'ubuntu',recipeId:'ubuntu-server'});
  check(inspected.response.ok&&inspected.value.status==='mismatch'&&inspected.value.detectedFamily==='rocky','packaged API detects renamed wrong-family ISO');
  const refusedIso=await post('machines',{name:'Wrong ISO fixture',family:'ubuntu',firmware:'bios',memory:2048,cpus:1,diskGB:40,isoPath:wrongIso,recipeId:'ubuntu-server'});
  check(!refusedIso.response.ok&&(await state()).machines.length===0,'wrong ISO creates no instance through direct API');
  const sector=new Uint8Array(512);sector.set([0xfa,0xf4,0xeb,0xfd]);sector[510]=0x55;sector[511]=0xaa;const disk=join(root,'boot.raw');await Bun.write(disk,sector);
  const imported=await post('templates/import',{name:'Isolated boot fixture',family:'linux',firmware:'bios',path:disk});check(imported.response.ok,'isolated disk fixture imports');
  const created=await post('machines',{name:'SSH NAT fixture',family:'linux',memory:512,cpus:1,diskGB:8,templateId:imported.value.id,network:{mode:'nat'}});check(created.response.ok,'new instance defaults to managed public key and selected NAT');vmId=created.value.id;
  const mappedPort=await freePort();
  const mapped=await post('network/mappings',{ownerId:vmId,label:'HTTP fixture',hostPort:mappedPort,targetPort:80,protocol:'tcp'});check(mapped.response.ok,'stopped VM accepts a durable TCP mapping');
  const duplicate=await post('network/mappings',{ownerId:vmId,label:'Conflict',hostPort:mappedPort,targetPort:81,protocol:'tcp'});check(!duplicate.response.ok,'reserved endpoint conflict is rejected');
  const started=await post(`machines/${vmId}/start`);check(started.response.ok,'packaged QEMU starts isolated NAT guest');
  const vm=started.value;check(vm.session?.sshPort>=1024,'actual SSH port is published');
  const network=await qmp(vm.session.qmpPort,'human-monitor-command',{'command-line':'info usernet'});check(String(network).includes('127.0.0.1')&&String(network).includes(String(vm.session.sshPort)),'real QEMU forwards SSH on loopback');
  check(String(network).includes(String(mappedPort)),'persisted mapping is applied to real QEMU at startup');
  const udpPort=await freePort(),live=await post('network/mappings',{ownerId:vmId,label:'UDP fixture',hostPort:udpPort,targetPort:53,protocol:'udp'});
  if(!live.response.ok)console.error(JSON.stringify({error:live.value,network:await qmp(vm.session.qmpPort,'human-monitor-command',{'command-line':'info usernet'})}));
  check(live.response.ok,'running QEMU accepts a live UDP mapping');
  check(String(await qmp(vm.session.qmpPort,'human-monitor-command',{'command-line':'info usernet'})).includes(String(udpPort)),'live UDP rule appears in QEMU');
  check((await post(`network/mappings/${live.value.id}/delete`)).response.ok,'live UDP mapping removes cleanly');
  check(!String(await qmp(vm.session.qmpPort,'human-monitor-command',{'command-line':'info usernet'})).includes(String(udpPort)),'deleted rule is removed from QEMU');
  check(!(await post(`network/mappings/${mapped.value.id}/update`,{ownerId:vmId,label:'edited',hostPort:mappedPort,targetPort:81,protocol:'tcp'})).response.ok,'editing a running endpoint is rejected');
  const quit=await post('app/quit');check(!quit.response.ok&&quit.value.error.includes('正常关机'),'service exit protects a running guest');
  const change=await post(`machines/${vmId}/network`,{mode:'bridged',adapterId:crypto.randomUUID()});check(!change.response.ok,'running guest cannot switch network');
  // Browser fixtures never send operations to this VM; all browser /api routes are intercepted.
  const shutdownUi=spawn('node',[join(project,'scripts/checks/shutdown-confirm-ui.mjs'),origin],{cwd:project,windowsHide:true,stdio:'inherit'});
  check(await new Promise<number|null>(r=>shutdownUi.on('close',r))===0,'normal VM shutdown requires explicit confirmation');
  const ui=spawn('node',[join(project,'scripts/checks/workspace-ui.mjs'),origin],{cwd:project,windowsHide:true,stdio:'inherit'});
  const uiCode=await new Promise<number|null>(r=>ui.on('close',r));check(uiCode===0,'responsive UI and connection flow pass');
  const dockerUi=spawn('node',[join(project,'scripts/checks/docker-ui.mjs'),origin],{cwd:project,windowsHide:true,stdio:'inherit'});
  check(await new Promise<number|null>(r=>dockerUi.on('close',r))===0,'Docker and mapping UI flows pass');
  const managedUi=spawn('node',[join(project,'scripts/checks/docker-managed/ui.mjs'),origin],{cwd:project,windowsHide:true,stdio:'inherit'});
  check(await new Promise<number|null>(r=>managedUi.on('close',r))===0,'managed Docker UI flows pass');
  const workspaceUi=spawn('node',[join(project,'scripts/checks/docker-workspace-ui.mjs'),origin],{cwd:project,windowsHide:true,stdio:'inherit'});
  check(await new Promise<number|null>(r=>workspaceUi.on('close',r))===0,'Docker fixed workspace and resource filters pass');
  const unifiedUi=spawn('node',[join(project,'scripts/checks/unified-workspace-ui.mjs'),origin],{cwd:project,windowsHide:true,stdio:'inherit'});
  check(await new Promise<number|null>(r=>unifiedUi.on('close',r))===0,'unified environment, template, settings and port workspaces pass');
  const readabilityUi=spawn('node',[join(project,'scripts/checks/readability-resources-ui.mjs'),origin],{cwd:project,windowsHide:true,stdio:'inherit'});
  check(await new Promise<number|null>(r=>readabilityUi.on('close',r))===0,'template resources and high DPI readability pass');
  const createUi=spawn('node',[join(project,'scripts/checks/create-dialog-ui.mjs'),origin],{cwd:project,windowsHide:true,stdio:'inherit'});
  check(await new Promise<number|null>(r=>createUi.on('close',r))===0,'compact creation flow keeps actions accessible');
  const isoUi=spawn('node',[join(project,'scripts/checks/iso-inspection-ui.mjs'),origin],{cwd:project,windowsHide:true,stdio:'inherit'});
  check(await new Promise<number|null>(r=>isoUi.on('close',r))===0,'ISO mismatch, manual confirmation and stale-response protection pass');
  check((await fetch(origin+'/api/health')).ok,'closing browser leaves tray service available');
  await post(`machines/${vmId}/force-stop`);for(let i=0;i<100;i++){if((await state()).machines[0].state==='stopped')break;await Bun.sleep(100);}
  check((await post(`network/mappings/${mapped.value.id}/update`,{ownerId:vmId,label:'edited',hostPort:mappedPort,targetPort:81,protocol:'tcp'})).response.ok,'stopped endpoint edits persist');
  const mappings=await(await fetch(origin+'/api/network/mappings')).json();check(mappings.some((p:any)=>p.id===mapped.value.id&&p.targetPort===81&&p.status==='stopped'),'mapping page reports persisted stopped configuration');
  const result=await post('app/quit');check(result.response.ok,'idle app accepts explicit quit');
  for(let i=0;i<100&&app.exitCode===null;i++)await Bun.sleep(100);check(app.exitCode===0,'application exits cleanly');
  let alive=true;try{process.kill(trayPid,0);}catch{alive=false;}check(!alive,'tray helper does not survive service exit');
  console.log(JSON.stringify({checks,root},null,2));
}finally {
  if(app.exitCode===null){if(vmId)await post(`machines/${vmId}/force-stop`).catch(()=>{});await post('app/quit').catch(()=>{});for(let i=0;i<50&&app.exitCode===null;i++)await Bun.sleep(100);if(app.exitCode===null)app.kill();}
  await Bun.write(join(root,'report.json'),JSON.stringify({checks,appLog},null,2));
}
