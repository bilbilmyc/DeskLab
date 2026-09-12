import {mkdir,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {run} from '../../server/qemu';
const commit='85f07f7b784009adf90129b3854c5b742ca3cef9';
const zipHash='36e2609b7ceefedcb978ce5c48caf9e0e5af83423717c4e2e3c1d7ebca8f62a5';
export async function prepareNetwork() {
  const root=resolve(import.meta.dir,'../..'),downloads=join(root,'.runtime/downloads/network');
  await mkdir(downloads,{recursive:true});
  const zip=join(downloads,'tap-9.27.0.zip');
  if(!await Bun.file(zip).exists()) {
    const response=await fetch('https://github.com/OpenVPN/tap-windows6/releases/download/9.27.0/dist.win10.zip');
    if(!response.ok)throw new Error('无法下载官方 TAP 驱动包');await Bun.write(zip,await response.arrayBuffer());
  }
  if(new Bun.CryptoHasher('sha256').update(await Bun.file(zip).arrayBuffer()).digest('hex')!==zipHash)throw new Error('TAP 驱动包摘要不一致');
  const powershell=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const literal=(value:string)=>`'${value.replaceAll("'","''")}'`;
  const extract=`$ErrorActionPreference='Stop';Expand-Archive -LiteralPath ${literal(zip)} -DestinationPath ${literal(join(downloads,'tap-9.27.0'))} -Force`;
  await run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(extract,'utf16le').toString('base64')],60000);
  const source=join(downloads,'openvpn-source');
  if(!await Bun.file(join(source,'src/tapctl/main.c')).exists())await run('git',['clone','--depth','1','--branch','v2.7.7','https://github.com/OpenVPN/openvpn.git',source],120000);
  if((await run('git',['-C',source,'rev-parse','HEAD'])).trim()!==commit)throw new Error('tapctl 源码版本不一致');
  if((await run('git',['-C',source,'status','--porcelain','--untracked-files=no'])).trim())throw new Error('tapctl 上游源码已修改');
  await run('cmake',['-S',join(root,'scripts/build/tapctl'),'-B',join(root,'.runtime/build/tapctl'),'-A','x64',`-DOPENVPN_SOURCE=${source.replaceAll('\\','/')}`],60000);
  await run('cmake',['--build',join(root,'.runtime/build/tapctl'),'--config','Release'],60000);
  const licenses=join(root,'.runtime/build/network-licenses');await mkdir(licenses,{recursive:true});
  await run('git',['-C',source,'archive','--format=zip',`--output=${join(licenses,'openvpn-2.7.7-source.zip')}`,commit],60000);
  await cp(join(source,'COPYRIGHT.GPL'),join(licenses,'COPYRIGHT.GPL'));
  await cp(join(source,'COPYING'),join(licenses,'COPYING.OpenVPN'));
  await cp(join(root,'scripts/build/tapctl/CMakeLists.txt'),join(licenses,'CMakeLists.txt'));
  await Bun.write(join(licenses,'NETWORK-SOURCES.txt'),`TAP-Windows6 9.27.0 (unmodified signed driver)\nhttps://github.com/OpenVPN/tap-windows6/tree/9.27.0\nDriver package SHA256: ${zipHash}\n\ntapctl from OpenVPN 2.7.7, GPL-2.0, commit ${commit}.\nComplete corresponding source: openvpn-2.7.7-source.zip\nBuild: cmake -S <directory containing CMakeLists.txt> -B build -A x64 -DOPENVPN_SOURCE=<extracted source>\ncmake --build build --config Release\nWindows SDK and Visual Studio C++ tools required.\n`);
}
if(import.meta.main)await prepareNetwork();
