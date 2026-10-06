import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import {captureEvidence, hashFile as hash, verifyEvidence, type CheckEvidence} from './check-evidence';

const root=resolve(import.meta.dir,'../..'),runtime=join(root,'.runtime','checks');
const setup=resolve(process.env.DESKLAB_INSTALLER_TEST_SETUP || join(root,'dist','installer','DeskLab-Setup.exe'));
await mkdir(runtime,{recursive:true});
const testRoot=await mkdtemp(join(runtime,'installer-check-')),installed=join(testRoot,'DeskLab');
if(!installed.startsWith(runtime+sep))throw new Error('Installer test directory must be inside .runtime');
await mkdir(testRoot,{recursive:true});
const checks:{name:string;passed:boolean}[]=[];
const startedAt=new Date().toISOString();
let evidence:CheckEvidence|undefined,passed=false,error:string|undefined;
function check(value:unknown,name:string){checks.push({name,passed:!!value});if(!value)throw new Error(name);}
async function run(path:string,args:string[]){await new Promise<void>((done,reject)=>{const p=spawn(path,args,{windowsHide:true,stdio:'ignore'});p.on('error',reject);p.on('close',code=>code===0?done():reject(new Error(`Installer process exited with ${code}`)));});}
async function install(log:string){await run(setup,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/DESKLABTEST=1',`/DIR=${installed}`,`/LOG=${join(testRoot,log)}`]);}
try{
  check(await Bun.file(setup).exists(),'setup executable exists');
  evidence=await captureEvidence({executable:process.env.DESKLAB_INSTALLER_TEST_EXE||join(root,'dist','app','DeskLab.exe'),installer:setup,manifest:process.env.DESKLAB_INSTALLER_TEST_MANIFEST});
  await install('install.log');
  check(await Bun.file(join(installed,'DeskLab.exe')).exists(),'program installed');
  check(await hash(join(installed,'DeskLab.exe'))===evidence.executable.sha256,'installed executable matches final build');
  const marker=await Bun.file(join(installed,'desklab.install.json')).json();
  check(marker.version===1&&marker.dataDirectory==='data','installed data marker matches runtime contract');
  check((await readdir(join(installed,'data'))).length===0,'fresh data directory is empty');
  check((await readdir(join(installed,'iso'))).length===0,'fresh ISO directory is empty');
  check(!await stat(join(installed,'.data')).then(()=>true).catch(()=>false),'source .data was not bundled');
  const catalogue=await Bun.file(join(installed,'templates','builtin-catalogue.json')).json();
  check(catalogue.templates.length>0,'small builtin catalogue reference installed');
  const preserved=[join(installed,'data','lab.json'),join(installed,'data','desklab.sqlite'),join(installed,'data','engines','user-engine','data.qcow2'),join(installed,'data','templates','user-template','base.qcow2'),join(installed,'data','machines','user-vm','restore-points','user-point','disk.qcow2'),join(installed,'data','machines','user-vm','restore-points','user-point','uefi.fd'),join(installed,'iso','user-test.iso'),join(installed,'templates','my-custom-notes.json')];
  for(const path of preserved){await mkdir(dirname(path),{recursive:true});await Bun.write(path,`installer preservation sentinel: ${path}`);}
  const before=await Promise.all(preserved.map(hash));
  await install('upgrade.log');
  check(await hash(join(installed,'DeskLab.exe'))===evidence.executable.sha256,'upgraded executable matches final build');
  check((await Promise.all(preserved.map(hash))).every((value,i)=>value===before[i]),'upgrade preserves user configuration, disks, restore points, ISO and custom template notes');
  await run(join(installed,'unins000.exe'),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/DESKLABTEST=1',`/LOG=${join(testRoot,'uninstall.log')}`]);
  check(!await Bun.file(join(installed,'DeskLab.exe')).exists(),'uninstall removes program');
  check((await Promise.all(preserved.map(hash))).every((value,i)=>value===before[i]),'uninstall preserves user configuration, disks, restore points, ISO and custom template notes');
  check(await Bun.file(join(installed,'templates','README.txt')).exists(),'uninstall preserves template instructions');
  await verifyEvidence(evidence);
  passed=true;
  console.log(`Installer layout, upgrade and data preservation checks passed: ${testRoot}`);
}catch(cause){error=cause instanceof Error?cause.message:String(cause);throw cause;}
finally{await Bun.write(join(testRoot,'result.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),passed,error,evidence,setup,testRoot,installed,checks},null,2));}
