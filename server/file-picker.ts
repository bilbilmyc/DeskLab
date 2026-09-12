import { opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import type { FileListing, FilePickerKind } from '../shared/file-picker';

const input = z.object({
  kind: z.enum(['iso', 'disk', 'directory','compose'], {error: '请选择文件类型或文件夹'}),
  path: z.string({error: '请输入文件夹路径'}).trim().max(32768, '路径太长，请选择较短的路径')
    .regex(/^[^\x00-\x1f]*$/, '路径不能包含控制字符').optional(),
}).strict();
const diskExtensions = new Set(['.qcow2', '.img', '.raw', '.vmdk', '.vhd', '.vhdx', '.vdi']);
const maxEntries = 500;
const maxScannedEntries = 5000;
const collator = new Intl.Collator('zh-CN', {numeric: true, sensitivity: 'base'});
let shortcutCache: {home: string; expires: number; value: Promise<FileListing['shortcuts']>} | undefined;

function absolutePath(path: string) {
  // A Windows root-relative path (\images) depends on the current drive.
  return isAbsolute(path) && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(path) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path));
}

function readableError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new Error('这个路径不存在，请检查后重试');
  if (code === 'EACCES' || code === 'EPERM') return new Error('没有权限读取这个文件夹，请选择其他位置');
  if (code === 'EINVAL' || code === 'ENAMETOOLONG') return new Error('路径格式不正确或过长，请检查后重试');
  return new Error('无法读取这个文件夹，请确认路径和访问权限后重试');
}

async function directoryAt(path: string): Promise<{directory: string; file?: string}> {
  const info = await stat(path);
  if (info.isDirectory()) return {directory: resolve(path)};
  if (info.isFile()) return {directory: dirname(resolve(path)), file: resolve(path)};
  throw Object.assign(new Error('Not a directory or regular file'), {code: 'ENOTDIR'});
}

async function shortcuts(home: string): Promise<FileListing['shortcuts']> {
  if (shortcutCache?.home === home && shortcutCache.expires > Date.now()) return shortcutCache.value;
  const candidates = [
    {name: '用户目录', path: home},
    {name: '下载', path: join(home, 'Downloads')},
    {name: '桌面', path: join(home, 'Desktop')},
  ];
  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code++) {
      const drive = String.fromCharCode(code);
      candidates.push({name: `磁盘 ${drive}:`, path: `${drive}:\\`});
    }
  } else candidates.push({name: '文件系统', path: parse(home).root});
  const value = Promise.all(candidates.map(item => new Promise<typeof item | undefined>(done => {
    let settled = false;
    const finish = (result?: typeof item) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    // Offline mapped drives may never resolve promptly. Only the shortcut is
    // omitted; browsing a healthy directory must remain usable.
    const timer = setTimeout(() => finish(), 500);
    stat(item.path).then(info => finish(info.isDirectory() ? item : undefined), () => finish());
  }))).then(available => available.filter((item): item is {name: string; path: string} => !!item));
  shortcutCache = {home, expires: Date.now() + 30000, value};
  return value;
}

function matchesFile(name: string, kind: FilePickerKind) {
  const extension = extname(name).toLowerCase();
  return kind === 'iso' ? extension === '.iso' : kind==='compose'?['.yaml','.yml'].includes(extension):kind === 'disk' && diskExtensions.has(extension);
}

export async function listFiles(value: unknown, defaultDirectory?: string): Promise<FileListing> {
  const {kind, path: requested} = input.parse(value);
  const home = resolve(homedir());
  if (requested && !absolutePath(requested)) throw new Error('请输入完整的绝对路径');
  const initial = requested || (defaultDirectory && absolutePath(defaultDirectory) ? defaultDirectory : home);
  let location: Awaited<ReturnType<typeof directoryAt>>;
  try { location = await directoryAt(initial); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (!requested && initial !== home && (code === 'ENOENT' || code === 'ENOTDIR')) {
      try { location = await directoryAt(home); } catch (fallbackError) { throw readableError(fallbackError); }
    } else throw readableError(error);
  }

  const {directory, file} = location;
  const entries: FileListing['entries'] = [];
  // Preserve an explicitly typed file even when its parent listing is truncated.
  if (file && matchesFile(file, kind)) entries.push({name: basename(file), path: file, directory: false});
  let scanned = 0, truncated = false;
  try {
    const handle = await opendir(directory, {bufferSize: 32});
    // Stream one directory only. Bound both matches and non-matching entries.
    for await (const entry of handle) {
      if (scanned++ === maxScannedEntries) { truncated = true; break; }
      const path = join(directory, entry.name);
      if (file && (process.platform === 'win32' ? path.toLowerCase() === file.toLowerCase() : path === file)) continue;
      let isDirectory = entry.isDirectory(), isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { const target = await stat(path); isDirectory = target.isDirectory(); isFile = target.isFile(); }
        catch { continue; }
      }
      if (!isDirectory && !(isFile && matchesFile(entry.name, kind))) continue;
      if (entries.length === maxEntries) { truncated = true; break; }
      entries.push({name: entry.name, path, directory: isDirectory});
    }
  } catch (error) { throw readableError(error); }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || collator.compare(a.name, b.name) || a.name.localeCompare(b.name));
  const parent = dirname(directory);
  return {path: directory, parent: parent === directory ? null : parent, entries, shortcuts: await shortcuts(home), truncated};
}
