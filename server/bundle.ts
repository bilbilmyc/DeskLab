import { basename, dirname, join, resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Family, SystemImage, Template } from '../shared/types';
import { homedir } from 'node:os';

export async function bundleDirectory(execPath = process.execPath, cwd = process.cwd()) {
  if (basename(execPath).toLowerCase() !== 'desklab.exe') return resolve(cwd);
  const directory = dirname(resolve(execPath));
  if (basename(directory).toLowerCase() === 'app' && basename(dirname(directory)).toLowerCase() === 'dist') {
    const root=resolve(directory,'../..'),marker=Bun.file(join(root,'desklab.bundle.json'));
    if(await marker.exists()&&(await marker.json()).version===1)return root;
  }
  if (basename(directory).toLowerCase() === 'dist') {
    const marker = Bun.file(join(directory, '..', 'desklab.bundle.json'));
    if (await marker.exists() && (await marker.json()).version === 1) return dirname(directory);
  }
  return directory;
}

export async function dataDirectory(bundle: string, execPath = process.execPath) {
  if (process.env.LAB_DATA_DIR) return resolve(process.env.LAB_DATA_DIR);
  const installed=Bun.file(join(bundle,'desklab.install.json'));
  if(basename(execPath).toLowerCase()==='desklab.exe' && await installed.exists()) {
    const marker=await installed.json();
    if(marker.version!==1 || marker.dataDirectory!=='data')throw new Error('DeskLab 安装目录配置无效，请重新安装程序');
    return join(bundle,'data');
  }
  const portable = join(bundle, '.data');
  if (basename(execPath).toLowerCase() !== 'desklab.exe' || await Bun.file(join(portable, 'lab.json')).exists()) return portable;
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'DeskLab', 'data');
}

const record = z.object({id: z.string().optional(), iso: z.string().regex(/^[^\\/:]+\.iso$/i), name: z.string(), templateId: z.string().uuid(), status: z.literal('ready')});
export async function preparedImages(directory?: string): Promise<z.infer<typeof record>[]> {
  if (!directory) return [];
  const manifest = Bun.file(join(directory, 'prepared-images.json'));
  if (!await manifest.exists()) return [];
  let data: {images?: unknown};
  try { data = await manifest.json(); } catch { return []; }
  if (!data || !Array.isArray(data.images)) return [];
  return data.images.flatMap(value => { const parsed = record.safeParse(value); return parsed.success ? [parsed.data] : []; });
}
export async function systemImages(directory: string, templates: Template[], dataDirectory: string): Promise<SystemImage[]> {
  let files;
  try { files = await readdir(directory, {withFileTypes: true}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const pairs = new Map<string, z.infer<typeof record>>();
  for (const pair of await preparedImages(directory)) pairs.set(pair.iso.toLowerCase(), pair);
  const images: SystemImage[] = [];
  for (const file of files.filter(x => x.isFile() && /\.iso$/i.test(x.name))) {
    const pair = pairs.get(file.name.toLowerCase());
    const template = pair ? templates.find(x => x.id === pair.templateId) : undefined;
    const available = template && await stat(join(dataDirectory, 'templates', template.id, 'base.qcow2')).then(s => s.isFile()).catch(() => false);
    const lower = file.name.toLowerCase();
    const family: Family = lower.includes('windows') ? 'windows' : lower.includes('ubuntu') ? 'ubuntu' : lower.includes('debian') ? 'debian' : lower.includes('rocky') ? 'rocky' : 'linux';
    images.push({file: file.name, name: pair?.name ?? file.name, family: template?.family ?? family, isoPath: join(directory, file.name), templateId: available ? template.id : undefined, firmware: available ? template.firmware ?? 'bios' : family === 'windows' ? 'uefi' : 'bios'});
  }
  return images.sort((a, b) => a.name.localeCompare(b.name));
}
