import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const root=resolve(import.meta.dir,'../..'),runtime=join(root,'.runtime','checks');
const setup=resolve(process.env.DESKLAB_INSTALLER_TEST_SETUP || join(root,'dist','installer','DeskLab-Setup.exe'));
const testRoot=join(runtime,`installer-check-${Date.now()}`),installed=join(testRoot,'DeskLab');
if(!installed.startsWith(runtime+sep))throw new Error('Installer test directory must be inside .runtime');
await mkdir(testRoot,{recursive:true});
const checks:{name:string;passed:boolean}[]=[];
function check(value:unknown,name:string){checks.push({name,passed:!!value});if(!value)throw new Error(name);}
async function hash(path:string){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
async function run(path:string,args:string[]){await new Promise<void>((done,reject)=>{const p=spawn(path,args,{windowsHide:true,stdio:'ignore'});p.on('error',reject);p.on('close',code=>code===0?done():reject(new Error(`Installer process exited with ${code}`)));});}
async function install(log:string){await run(setup,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/DESKLABTEST=1',`/DIR=${installed}`,`/LOG=${join(testRoot,log)}`]);}
try{
  check(await Bun.file(setup).exists(),'setup executable exists');
  await install('install.log');
  check(await Bun.file(join(installed,'DeskLab.exe')).exists(),'program installed');
  const marker=await Bun.file(join(installed,'desklab.install.json')).json();
  check(marker.version===1&&marker.dataDirectory==='data','installed data marker matches runtime contract');
  check((await readdir(join(installed,'data'))).length===0,'fresh data directory is empty');
  check((await readdir(join(installed,'iso'))).length===0,'fresh ISO directory is empty');
  check(!await stat(join(installed,'.data')).then(()=>true).catch(()=>false),'source .data was not bundled');
  const catalogue=await Bun.file(join(installed,'templates','builtin-catalogue.json')).json();
  check(catalogue.templates.length>0,'small builtin catalogue reference installed');
  const preserved=[join(installed,'data','lab.json'),join(installed,'data','desklab.sqlite'),join(installed,'data','engines','user-engine','data.qcow2'),join(installed,'data','templates','user-template','base.qcow2'),join(installed,'iso','user-test.iso'),join(installed,'templates','my-custom-notes.json')];
  for(const path of preserved){await mkdir(dirname(path),{recursive:true});await Bun.write(path,`installer preservation sentinel: ${path}`);}
  const before=await Promise.all(preserved.map(hash));
  await install('upgrade.log');
  check((await Promise.all(preserved.map(hash))).every((value,i)=>value===before[i]),'upgrade preserves user configuration, disks, ISO and custom template notes');
  await run(join(installed,'unins000.exe'),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',`/LOG=${join(testRoot,'uninstall.log')}`]);
  check(!await Bun.file(join(installed,'DeskLab.exe')).exists(),'uninstall removes program');
  check((await Promise.all(preserved.map(hash))).every((value,i)=>value===before[i]),'uninstall preserves user configuration, disks, ISO and custom template notes');
  check(await Bun.file(join(installed,'templates','README.txt')).exists(),'uninstall preserves template instructions');
  console.log(`Installer layout, upgrade and data preservation checks passed: ${testRoot}`);
}finally{await Bun.write(join(testRoot,'result.json'),JSON.stringify({setup,testRoot,installed,checks},null,2));}
