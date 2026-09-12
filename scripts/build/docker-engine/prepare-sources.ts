import {mkdir,rename,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {run} from '../../../server/qemu';
export const sourceDirectory=resolve('.runtime/downloads/docker-engine');
export const toolDirectory=resolve('dist/engines/docker/tools');
export async function sha256(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function download(name:string,url:string,expected?:string){
 await mkdir(sourceDirectory,{recursive:true});const file=join(sourceDirectory,name);
 if(await Bun.file(file).exists()&&(!expected||await sha256(file)===expected))return file;
 console.log('Downloading '+name);await run('curl.exe',['--fail','--location','--retry','2','--connect-timeout','20','--max-time','900','--output',file+'.partial',url],950000);
 const digest=await sha256(file+'.partial');if(expected&&digest!==expected)throw new Error('SHA-256 mismatch: '+name);await rename(file+'.partial',file);
 await Bun.write(file+'.source.json',JSON.stringify({url,sha256:digest},null,2));console.log('Verified '+name);return file;
}
export async function prepareSources(){
 const [base,cli,compose]=await Promise.all([
  download('ubuntu-minimal-24.04-20260905.qcow2','https://cloud-images.ubuntu.com/minimal/releases/noble/release-20260905/ubuntu-24.04-minimal-cloudimg-amd64.img','46b0dbaffa6950a7da5ff2dc5ed34c46084610b3b6d1fae8f1ec2d7e953984a3'),
  download('docker-29.7.2.zip','https://download.docker.com/win/static/stable/x86_64/docker-29.7.2.zip','ed9222f478a5d143ac90e8e2fd3209b5076382cdb4b210321f97aa4b68bc6811'),
  download('docker-compose-5.5.1.exe','https://github.com/docker/compose/releases/download/v5.5.1/docker-compose-windows-x86_64.exe','a3c0c73033eaede90210345d0cc2233edf4fab8fe0282a91dad8fd8436809d2f'),
 ]);
 await mkdir(join(toolDirectory,'cli-plugins'),{recursive:true});
 await run('tar.exe',['-xf',cli,'-C',sourceDirectory]);
 await copyFile(join(sourceDirectory,'docker','docker.exe'),join(toolDirectory,'docker.exe'));
  await copyFile(compose,join(toolDirectory,'cli-plugins','docker-compose.exe'));
 await copyFile(join(import.meta.dir,'NOTICES.txt'),resolve('dist/engines/docker/NOTICES.txt'));
 console.log(JSON.stringify({base,toolDirectory,docker:await run(join(toolDirectory,'docker.exe'),['--version']),compose:await run(compose,['version'])}));return {base,toolDirectory};
}
if(import.meta.main)await prepareSources();
