import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { builtinTemplates } from '../../server/catalog';

const root=resolve(import.meta.dir,'../..');
const version='7.1.0';
const compilerDirectory=join(root,'.runtime','tools',`inno-setup-${version}`);
const compilerInstaller=join(root,'.runtime','downloads',`innosetup-${version}-x64.exe`);
const compilerUrl=`https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-${version}-x64.exe`;
const compilerSha256='0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f';
async function hash(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function run(file:string,args:string[]){await new Promise<void>((done,reject)=>{const child=spawn(file,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>process.stdout.write(chunk));child.stderr.on('data',chunk=>process.stderr.write(chunk));child.on('error',reject);child.on('close',code=>code===0?done():reject(new Error(`${file} exited with ${code}`)));});}
async function prepareCompiler(){
  const iscc=join(compilerDirectory,'ISCC.exe');
  if(await Bun.file(iscc).exists())return iscc;
  await mkdir(dirname(compilerInstaller),{recursive:true});
  if(!await Bun.file(compilerInstaller).exists() || await hash(compilerInstaller)!==compilerSha256){
    console.log(`Downloading official Inno Setup ${version} compiler…`);
    const response=await fetch(compilerUrl,{signal:AbortSignal.timeout(180_000)});
    if(!response.ok)throw new Error(`Compiler download failed: ${response.status}`);
    const bytes=await response.arrayBuffer();
    if(createHash('sha256').update(Buffer.from(bytes)).digest('hex')!==compilerSha256)throw new Error('Compiler SHA-256 did not match the pinned official release asset');
    await Bun.write(compilerInstaller,bytes);
  }
  await mkdir(compilerDirectory,{recursive:true});
  await run(compilerInstaller,['/PORTABLE=1','/CURRENTUSER','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',`/DIR=${compilerDirectory}`,`/LOG=${join(compilerDirectory,'prepare.log')}`]);
  if(!await Bun.file(iscc).exists())throw new Error('Portable compiler extraction did not produce ISCC.exe');
  await Bun.write(join(compilerDirectory,'compiler-source.json'),JSON.stringify({version,url:compilerUrl,sha256:compilerSha256,mode:'official /PORTABLE=1 /CURRENTUSER'},null,2));
  return iscc;
}

if(process.platform!=='win32'||process.arch!=='x64')throw new Error('The Windows installer must currently be built on Windows x64.');
const compiler=await prepareCompiler();
if(process.argv.includes('--prepare')){console.log(`Compiler ready: ${compiler}`);process.exit(0);}
const executable=resolve(process.env.DESKLAB_INSTALLER_EXE || join(root,'dist','app','DeskLab.exe'));
if(!await Bun.file(executable).exists())throw new Error('Compile dist/app/DeskLab.exe first with bun run package.');
const stage=join(root,'.runtime','build','installer-stage'),output=resolve(process.env.DESKLAB_INSTALLER_OUTPUT || join(root,'dist','installer'));
await mkdir(stage,{recursive:true});await mkdir(output,{recursive:true});
await Bun.write(join(stage,'desklab.install.json'),JSON.stringify({version:1,dataDirectory:'data'},null,2)+'\n');
await Bun.write(join(stage,'node-forge.LICENSE.txt'),Bun.file(join(root,'node_modules','node-forge','LICENSE')));
await Bun.write(join(stage,'builtin-catalogue.json'),JSON.stringify({version:1,note:'Reference only. DeskLab uses its embedded catalogue. User templates are managed in the app and stored in data/templates.',templates:builtinTemplates.map(({id,name,family,description,interface:ui,memory,cpus,diskGB,firmware})=>({id,name,family,description,interface:ui,memory,cpus,diskGB,firmware}))},null,2)+'\n');
const packageInfo=await Bun.file(join(root,'package.json')).json();
const sourceHash=await hash(executable);
const dockerDirectory=join(root,'dist','engines','docker'),hasDocker=await Bun.file(join(dockerDirectory,'manifest.json')).exists();
await run(compiler,['/Qp',`/DAppExe=${executable}`,`/DStageDir=${stage}`,`/DAppVersion=${packageInfo.version}`,...(hasDocker?[`/DDockerEngineDir=${dockerDirectory}`]:[]),`/O${output}`,join(root,'installer','DeskLab.iss')]);
if(await hash(executable)!==sourceHash)throw new Error('DeskLab.exe changed during installer compilation; rebuild the installer from the final executable.');
const setup=join(output,'DeskLab-Setup.exe');
const manifest={appVersion:packageInfo.version,builtAt:new Date().toISOString(),executable:{path:executable,sha256:sourceHash,bytes:(await stat(executable)).size},installer:{path:setup,sha256:await hash(setup),bytes:(await stat(setup)).size},compiler:{version,url:compilerUrl,sha256:compilerSha256},includesOperatingSystemImages:hasDocker,managedDockerComponent:hasDocker};
await Bun.write(join(output,'DeskLab-Setup.build.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Installer ready: ${setup} (${(manifest.installer.bytes/1048576).toFixed(1)} MiB)`);
