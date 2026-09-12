import { mkdir, rename } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import assets, {engineVersion} from './generated/engine';

let embeddedDirectory: string | undefined;
export function embeddedEngineDirectory() { return embeddedDirectory; }
export async function extractEngine(dataDirectory: string) {
  if (!engineVersion || !Object.keys(assets).length) return;
  const root = join(dataDirectory, 'runtime', engineVersion, 'qemu');
  for (const [name, source] of Object.entries(assets)) {
    const target = resolve(root, name), rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('无效的内置引擎文件路径');
    const file = Bun.file(source);
    if (await Bun.file(target).exists() && Bun.file(target).size === file.size) continue;
    await mkdir(dirname(target), {recursive:true});
    const temporary = target + '.tmp';
    await Bun.write(temporary, file);
    await rename(temporary, target);
  }
  embeddedDirectory = root;
}
