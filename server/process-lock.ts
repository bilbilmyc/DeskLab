import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
export function processAlive(pid?: number) {
  if (!pid) return false;
  try {process.kill(pid,0); return true;} catch(e) {return (e as NodeJS.ErrnoException).code !== 'ESRCH';}
}
export async function lockDirectory(root: string) {
  await mkdir(root,{recursive:true});
  const path = join(root,'owner.lock');
  for (let attempt=0;attempt<2;attempt++) {
    try {
      const file = await open(path,'wx'); await file.writeFile(String(process.pid)); await file.close();
      return async () => {await rm(path,{force:true});};
    } catch(e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const content = (await readFile(path,'utf8')).trim();
      if (!/^\d+$/.test(content)) throw new Error('本地数据锁未就绪，请稍后重试');
      if (processAlive(Number(content))) throw new Error('这个数据目录已经由另一个 DeskLab 程序使用。请打开已有窗口。');
      await rm(path);
    }
  }
  throw new Error('无法获取本地数据锁');
}
