import {mkdir,rename,rm} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
export async function buildWeb() {
  const root=resolve(import.meta.dir,'../..');
  const build=Bun.spawn([process.execPath,'--bun','next','build'],{cwd:root,stdout:'inherit',stderr:'inherit'});
  if(await build.exited)throw new Error('网页构建失败');
  const output=join(root,'dist','web');
  if(relative(root,output).replaceAll('\\','/')!=='dist/web')throw new Error('Invalid web output directory');
  await mkdir(join(root,'dist'),{recursive:true});
  await rm(output,{recursive:true,force:true});
  await rename(join(root,'out'),output);
  return output;
}
if(import.meta.main)console.log(`网页输出：${await buildWeb()}`);
