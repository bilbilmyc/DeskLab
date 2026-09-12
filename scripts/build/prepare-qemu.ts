import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
const release='20260811',url=`https://qemu.weilnetz.de/w64/qemu-w64-setup-${release}.exe`;
const expected='5bcf9eed634e8575a37b74f445af41a2fe4106da512d0c30c368301d4c105037fdfab40a5287367a28a957624cddebbc8c07e16c88ab6634f554cdf3d16bf543';
if(process.platform!=='win32')throw new Error('This QEMU bundle is for Windows x64 builds.');
const archive=resolve(`.runtime/downloads/qemu-w64-setup-${release}.exe`),output=resolve('.runtime/tools/qemu');
await mkdir(resolve('.runtime/downloads'),{recursive:true});
if(!await Bun.file(archive).exists()){
  const response=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error(`QEMU download: ${response.status}`);
  await Bun.write(archive,response);
}
const hash=createHash('sha512');for await(const bytes of createReadStream(archive))hash.update(bytes);
if(hash.digest('hex')!==expected)throw new Error('QEMU installer SHA-512 mismatch. Remove the cached download and retry.');
await mkdir(output,{recursive:true});
const extractor=Bun.which('7z')??(await Bun.file('C:/Program Files/7-Zip/7z.exe').exists()?'C:/Program Files/7-Zip/7z.exe':undefined);
if(!extractor)throw new Error('Install 7-Zip or add 7z to PATH; extraction does not install QEMU globally.');
const child=Bun.spawn([extractor,'x',archive,`-o${output}`,'-y'],{stdout:'ignore',stderr:'inherit',windowsHide:true});
if(await child.exited)throw new Error('QEMU extraction failed');
for(const file of ['qemu-system-x86_64.exe','qemu-img.exe','COPYING'])if(!await Bun.file(join(output,file)).exists())throw new Error(`Missing QEMU file: ${file}`);
await Bun.write(join(output,'QEMU-SOURCE.txt'),`Windows QEMU build: ${url}\nSHA512: ${expected}\nPublisher build/source information: https://qemu.weilnetz.de/w64/\nSource mirror: https://github.com/stweil/qemu\nKeep COPYING and bundled firmware notices when distributing.\n`);
console.log('Pinned QEMU extracted to '+output);
