import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {run} from '../../server/qemu';
import {prepareNetwork} from './prepare-network';
export async function buildNetwork() {
  const root=resolve(import.meta.dir,'../..'),directory=join(root,'.runtime','build','native');
  await mkdir(directory,{recursive:true});
  await prepareNetwork();
  const driver=join(root,'.runtime/downloads/network/tap-9.27.0/dist.win10/amd64');
  const script=join(directory,'network-setup.ps1');
  await Bun.write(script,'\uFEFF'+(await Bun.file(join(root,'native/windows/NetworkSetup/setup.ps1')).text()).replace(/^\uFEFF/,''));
  const resources:Record<string,string>={
    'setup.ps1':script,
    'tapctl.exe':join(root,'.runtime/build/tapctl/Release/tapctl.exe'),
    'OemVista.inf':join(driver,'OemVista.inf'),'tap0901.cat':join(driver,'tap0901.cat'),'tap0901.sys':join(driver,'tap0901.sys'),
    'COPYRIGHT.GPL':join(root,'.runtime/build/network-licenses/COPYRIGHT.GPL'),
    'COPYING.OpenVPN':join(root,'.runtime/build/network-licenses/COPYING.OpenVPN'),
    'openvpn-2.7.7-source.zip':join(root,'.runtime/build/network-licenses/openvpn-2.7.7-source.zip'),
    'CMakeLists.txt':join(root,'.runtime/build/network-licenses/CMakeLists.txt'),
    'NETWORK-SOURCES.txt':join(root,'.runtime/build/network-licenses/NETWORK-SOURCES.txt'),
  };
  for(const path of Object.values(resources))if(!await Bun.file(path).exists())throw new Error(`缺少网络助手资源：${path}`);
  const sources=['Program.cs','ShellBridge.cs'].map(name=>join(root,'native/windows/NetworkSetup',name));
  const hash=new Bun.CryptoHasher('sha256');
  for(const path of [...sources,...Object.values(resources)])hash.update(await Bun.file(path).arrayBuffer());
  const executable=join(directory,`DeskLab.NetworkSetup-${hash.digest('hex').slice(0,16)}.exe`);
  const compiler=join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  if(!await Bun.file(executable).exists())await run(compiler,['/nologo','/codepage:65001','/target:exe','/optimize+','/platform:x64',`/out:${executable}`,'/reference:System.Web.Extensions.dll','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',...Object.entries(resources).map(([name,path])=>`/resource:${path},${name}`),...sources]);
  await Bun.write(join(directory,'network-helper.json'),JSON.stringify({filename:executable.split(/[\\/]/).at(-1)}));
  return executable;
}
if(import.meta.main)console.log(await buildNetwork());
