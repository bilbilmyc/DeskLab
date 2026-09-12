import { mkdir, cp } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { generateWindowsIcon } from './generate-icon';
import { windowsBranding } from './windows-branding';
import { finalizeWindowsExecutable } from './finalize-windows-executable';
import {buildTray} from './build-tray';
import {buildWeb} from './web';
const packageInfo = await Bun.file('package.json').json();
await generateWindowsIcon();
const webDirectory=await buildWeb();
const assets: Record<string, {type: string; body: string}> = {};
for await (const path of new Bun.Glob('**/*').scan({cwd: webDirectory, onlyFiles: true})) {
  const file = Bun.file(join(webDirectory, path));
  assets['/' + path.replaceAll('\\', '/')] = {type: file.type, body: Buffer.from(await file.arrayBuffer()).toString('base64')};
}
await Bun.write('server/generated/web.ts', `export default ${JSON.stringify(assets)} as Record<string, {type: string; body: string}>;\n`);
await mkdir('dist/app', {recursive: true});
if (process.argv.includes('--with-qemu')) {
  const source=process.env.QEMU_TEST_DIR??'.runtime/tools/qemu';
  if(!await Bun.file(join(source,'qemu-system-x86_64.exe')).exists())throw new Error('未找到可打包的 QEMU 目录');
  const target='.runtime/build/engine/qemu';await mkdir(target,{recursive:true});
  for await(const file of new Bun.Glob('*.dll').scan({cwd:source}))await cp(join(source,file),join(target,file));
  for(const file of ['qemu-system-x86_64.exe','qemu-img.exe','COPYING','README.rst'])if(await Bun.file(join(source,file)).exists())await cp(join(source,file),join(target,file));
  await cp(join(source,'share'),join(target,'share'),{recursive:true});
  await Bun.write('.runtime/build/engine/QEMU-SOURCE.txt','QEMU Windows build: https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe\nCorresponding source/build information: https://qemu.weilnetz.de/w64/ and https://github.com/stweil/qemu\nLocal convenience bundle; preserve upstream licenses and review redistribution obligations before publishing.\n');
}
// The engine and small installation recipes ship in the EXE. Original ISOs and
// installed guest disks are managed separately and never enter this build.
const engineRoot = await Bun.file('.runtime/build/engine/qemu/qemu-system-x86_64.exe').exists() ? '.runtime/build/engine/qemu' : '.runtime/tools/qemu';
if (!await Bun.file(join(engineRoot, 'qemu-system-x86_64.exe')).exists()) throw new Error('请先用 --with-qemu 准备要内置的 QEMU 引擎');
if (await Bun.file('.runtime/build/engine/QEMU-SOURCE.txt').exists()) await cp('.runtime/build/engine/QEMU-SOURCE.txt', join(engineRoot,'QEMU-SOURCE.txt'));
const names: string[] = [];
for await (const name of new Bun.Glob('**/*').scan({cwd:engineRoot,onlyFiles:true})) {
  const normalized=name.replaceAll('\\','/');
  if (!normalized.includes('/') || /^share\/(keymaps\/|.*\.(bin|rom)$|edk2-(x86_64|i386).*\.fd$)/.test(normalized)) names.push(normalized);
}
names.sort();
const hash=new Bun.CryptoHasher('sha256'), imports:string[]=[], entries:string[]=[];
for (const [index,name] of names.entries()) {
  const source=join(engineRoot,name), bytes=await Bun.file(source).arrayBuffer();
  hash.update(name); hash.update(bytes);
  imports.push(`import file${index} from ${JSON.stringify('../../'+relative(resolve('.'),resolve(source)).replaceAll('\\','/'))} with {type:'file'};`);
  entries.push(`${JSON.stringify(name)}: file${index}`);
}
await Bun.write('server/generated/engine.ts', `// @ts-nocheck\n${imports.join('\n')}\nexport const engineVersion=${JSON.stringify(hash.digest('hex').slice(0,16))};\nexport default {${entries.join(',')}} as Record<string,string>;\n`);
const result = await (async () => {
  const root=process.cwd(),tray=await buildTray();
  const trayVersion=new Bun.CryptoHasher('sha256').update(await Bun.file(tray).arrayBuffer()).digest('hex').slice(0,16);
  await Bun.write('server/generated/tray.ts',`// @ts-nocheck\nimport file from ${JSON.stringify('../../'+relative(root,tray).replaceAll('\\','/'))} with {type:'file'};\nexport const trayVersion=${JSON.stringify(trayVersion)};\nexport default file;\n`);
  try {
    process.chdir(join(root,'.runtime','build'));
    return await Bun.build({entrypoints: [join(root,'server/index.ts')], compile: {target: 'bun-windows-x64', outfile: join(root,'dist/app/DeskLab.exe'), windows: windowsBranding(packageInfo.version)}, minify: true});
  }
  finally {
    process.chdir(root);
    await Bun.write('server/generated/engine.ts', "export const engineVersion = '';\nexport default {} as Record<string, string>;\n");
    await Bun.write('server/generated/tray.ts', "export const trayVersion = '';\nexport default '';\n");
    await Bun.write('server/generated/network.ts', "export const networkVersion = '';\nexport default '';\n");
  }
})();
if (!result.success) { console.error(result.logs); process.exit(1); }
await finalizeWindowsExecutable('dist/app/DeskLab.exe');
console.log('已生成 dist/app/DeskLab.exe（含托盘、Bun、界面、QEMU 和自动安装模板）。运行 bun run installer 生成 dist/installer/ 安装包。');
