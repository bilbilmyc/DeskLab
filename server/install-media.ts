import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const BLOCK = 2048, CHUNK = 1024 * 1024, MAX_DIRECTORY = 16 * CHUNK, MAX_BOOT_FILE = 512 * CHUNK;
function failure(message: string): never { throw new Error(`安装介质无效：${message}`); }
const normalized = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const align = (n: number, size: number) => Math.ceil(n / size) * size;
const both32 = (buffer: Buffer, offset: number) => { const value = buffer.readUInt32LE(offset); if (value !== buffer.readUInt32BE(offset + 4)) failure('双字节序数值不一致'); return value; };
const both16 = (buffer: Buffer, offset: number) => { const value = buffer.readUInt16LE(offset); if (value !== buffer.readUInt16BE(offset + 2)) failure('双字节序数值不一致'); return value; };
const put32 = (buffer: Buffer, offset: number, value: number) => { buffer.writeUInt32LE(value, offset); buffer.writeUInt32BE(value, offset + 4); };
const put16 = (buffer: Buffer, offset: number, value: number) => { buffer.writeUInt16LE(value, offset); buffer.writeUInt16BE(value, offset + 2); };
const ucs2 = (value: string) => Buffer.from(value, 'utf16le').swap16();
const fromUcs2 = (value: Buffer) => { if (value.length % 2) failure('Joliet 文件名长度无效'); return Buffer.from(value).swap16().toString('utf16le'); };
const decodeName = (name: string) => name.replace(/;\d+$/, '').replace(/\.$/, '');
type Entry = { extent: number; size: number; directory: boolean; multi: boolean; name: string; system: Buffer };
type Tree = { root: Entry; joliet: boolean; skip: number; volumeBytes: number };

function safeRelative(input: string, flat = false): string[] {
  if (!input || input.includes('\\') || input.startsWith('/') || input.includes('\0') || input.includes(':')) throw new Error('文件路径必须是安全的相对路径');
  const parts = input.split('/');
  if (parts.length > 16 || (flat && parts.length !== 1) || parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) throw new Error('文件路径必须是安全的相对路径');
  return parts;
}

async function directory(path: string, create = false) {
  const absolute = resolve(path);
  try { const info = await lstat(absolute); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('输出位置必须是普通文件夹'); }
  catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await directory(dirname(absolute)); await mkdir(absolute);
  }
  if (normalized(await realpath(absolute)) !== normalized(absolute)) throw new Error('输出路径不能包含符号链接或目录联接');
  return absolute;
}

async function outputFile(outputPath: string, write: (handle: FileHandle) => Promise<void>) {
  const output = resolve(outputPath), parent = await directory(dirname(output)); safeRelative(basename(output), true);
  try { await lstat(output); throw new Error('输出文件已存在，已保留原文件'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(parent, `.desklab-media-${randomUUID()}.tmp`), handle = await open(temporary, 'wx', 0o600);
  let closed = false;
  try { await write(handle); await handle.sync(); await handle.close(); closed = true; await directory(parent); await link(temporary, output); }
  finally { if (!closed) await handle.close(); await unlink(temporary).catch(() => {}); }
}

async function writeAll(handle: FileHandle, data: Uint8Array, position: number) {
  for (let written = 0; written < data.length;) { const result = await handle.write(data, written, data.length - written, position + written); if (!result.bytesWritten) throw new Error('安装介质文件无法继续写入'); written += result.bytesWritten; }
}

class IsoReader {
  private constructor(private handle: FileHandle, private size: number) {}
  private volumeBytes = 0;
  private trees: Tree[] = [];
  label = '';

  static async open(path: string) {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('ISO 必须是普通文件');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const actual = await handle.stat(), reader = new IsoReader(handle, actual.size);
    try { if (before.ino !== actual.ino || before.dev !== actual.dev) failure('ISO 文件在读取前发生变化'); await reader.descriptors(); return reader; } catch (error) { await handle.close(); throw error; }
  }

  async close() { await this.handle.close(); }
  private bounds(position: number, size: number, limit = this.volumeBytes || this.size) {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(size) || position < 0 || size < 0 || position > limit || size > limit - position || position + size > this.size) failure('文件范围超出 ISO 边界');
  }
  private async read(position: number, size: number, limit?: number): Promise<Buffer> {
    this.bounds(position, size, limit);
    if (size > CHUNK) failure('单次读取超出内存限制');
    const buffer = Buffer.alloc(size);
    for (let read = 0; read < size;) { const result = await this.handle.read(buffer, read, size - read, position + read); if (!result.bytesRead) failure('ISO 被截断'); read += result.bytesRead; }
    return buffer;
  }
  private record(record: Buffer, joliet: boolean, limit = this.volumeBytes): Entry {
    if (record.length < 34 || record[0] !== record.length || record[32] === 0 || 33 + record[32] > record.length) failure('目录记录长度无效');
    if (record[26] || record[27]) failure('不支持交错存储文件');
    if (both16(record, 28) !== 1) failure('不支持多卷 ISO');
    const extent = (both32(record, 2) + record[1]) * BLOCK, size = both32(record, 10), special = record[32] === 1 && record[33] <= 1;
    this.bounds(extent, size, limit);
    const raw = record.subarray(33, 33 + record[32]), name = special ? (record[33] === 0 ? '.' : '..') : decodeName(joliet ? fromUcs2(raw) : raw.toString('ascii'));
    const start = 33 + record[32] + (record[32] % 2 === 0 ? 1 : 0);
    if (start > record.length) failure('目录记录填充无效');
    return { extent, size, directory: Boolean(record[25] & 2), multi: Boolean(record[25] & 128), name, system: record.subarray(start) };
  }
  private async descriptors() {
    if (this.size < 18 * BLOCK) failure('缺少 ISO9660 卷描述符');
    let primary: Buffer | undefined, supplementary: Buffer | undefined, terminated = false;
    for (let sector = 16; sector < 80; sector++) {
      const block = await this.read(sector * BLOCK, BLOCK, this.size);
      if (block.toString('ascii', 1, 6) !== 'CD001' || block[6] !== 1) failure('ISO9660 卷描述符签名无效');
      if (block[0] === 1 && !primary) primary = block;
      if (block[0] === 2 && ['%/@', '%/C', '%/E'].includes(block.toString('ascii', 88, 91))) supplementary = block;
      if (block[0] === 255) { terminated = true; break; }
    }
    if (!primary || !terminated) failure('缺少主卷或结束描述符');
    if (both16(primary, 128) !== BLOCK) failure('仅支持 2048 字节 ISO 逻辑块');
    this.volumeBytes = both32(primary, 80) * BLOCK;
    this.bounds(0, this.volumeBytes, this.size);
    if (this.volumeBytes < 18 * BLOCK) failure('ISO 卷大小无效');
    this.label = primary.toString('ascii', 40, 72).replace(/[\0 ]+$/, '');
    const primaryRoot = this.record(primary.subarray(156, 156 + primary[156]), false);
    if (!primaryRoot.directory) failure('根记录不是目录');
    const tree = { root: primaryRoot, joliet: false, skip: 0, volumeBytes: this.volumeBytes };
    const first = await this.read(primaryRoot.extent, Math.min(BLOCK, primaryRoot.size));
    if (first[0]) { const system = this.record(first.subarray(0, first[0]), false).system; if (system.length >= 7 && system.toString('ascii', 0, 2) === 'SP' && system[2] === 7 && system[4] === 0xbe && system[5] === 0xef) tree.skip = system[6]; }
    this.trees.push(tree);
    if (supplementary) {
      const volumeBytes = both32(supplementary, 80) * BLOCK;
      if (both16(supplementary, 128) !== BLOCK || volumeBytes < 18 * BLOCK || volumeBytes > this.volumeBytes) failure('Joliet 卷大小无效');
      // Hybrid images may append EFI partitions after the Joliet volume ends.
      const root = this.record(supplementary.subarray(156, 156 + supplementary[156]), true, volumeBytes);
      if (!root.directory) failure('Joliet 根记录不是目录');
      this.trees.unshift({ root, joliet: true, skip: 0, volumeBytes });
    }
  }
  private async rockName(system: Buffer, skip: number, depth = 0, seen = new Set<string>()): Promise<string | undefined> {
    if (depth > 4) failure('Rock Ridge 扩展嵌套过深');
    let name = '', found = false;
    for (let offset = skip; offset + 4 <= system.length;) {
      const signature = system.toString('ascii', offset, offset + 2), length = system[offset + 2];
      if (!length && system[offset] === 0) break;
      if (length < 4 || offset + length > system.length || system[offset + 3] !== 1) failure('Rock Ridge 扩展长度无效');
      const entry = system.subarray(offset, offset + length);
      if (signature === 'ST') break;
      if (signature === 'NM') { if (length < 5) failure('Rock Ridge 文件名无效'); if (!(entry[4] & 6)) { name += entry.toString('utf8', 5); found = true; } }
      if (signature === 'CE') {
        if (length !== 28) failure('Rock Ridge 续表无效');
        const block = both32(entry, 4), displacement = both32(entry, 12), size = both32(entry, 20), position = block * BLOCK + displacement, id = `${position}:${size}`;
        if (size > 65536 || displacement >= BLOCK || seen.has(id)) failure('Rock Ridge 续表超出限制或形成循环');
        seen.add(id);
        const continuation = await this.rockName(await this.read(position, size), 0, depth + 1, seen);
        if (continuation !== undefined) { name += continuation; found = true; }
      }
      offset += length;
    }
    return found ? name : undefined;
  }
  private async child(parent: Entry, wanted: string, tree: Tree): Promise<Entry | undefined> {
    if (!parent.directory || parent.multi || parent.size > MAX_DIRECTORY) failure('目录大小超出限制');
    for (let position = 0; position < parent.size; position += BLOCK) {
      const block = await this.read(parent.extent + position, Math.min(BLOCK, parent.size - position), tree.volumeBytes);
      for (let offset = 0; offset < block.length;) {
        const length = block[offset]; if (!length) break;
        if (length < 34 || offset + length > block.length) failure('目录记录跨越逻辑块边界');
        const entry = this.record(block.subarray(offset, offset + length), tree.joliet, tree.volumeBytes); offset += length;
        if (entry.name === '.' || entry.name === '..') continue;
        const alternate = !tree.joliet ? await this.rockName(entry.system, tree.skip) : undefined;
        if (alternate !== undefined) { safeRelative(alternate, true); entry.name = alternate; }
        if (entry.name.toLowerCase() === wanted.toLowerCase()) return entry;
      }
    }
    return undefined;
  }
  async find(path: string) {
    const parts = safeRelative(path);
    for (const tree of this.trees) {
      let entry: Entry | undefined = tree.root;
      for (const component of parts) { entry = await this.child(entry, component, tree); if (!entry) break; }
      if (entry) { if (entry.directory || entry.multi || entry.size > MAX_BOOT_FILE) failure('仅允许提取不超过 512 MiB 的单段启动文件'); return entry; }
    }
    throw new Error(`ISO 中找不到启动文件：${path}`);
  }
  async copy(entry: Entry, output: FileHandle) {
    for (let offset = 0; offset < entry.size; offset += CHUNK) await writeAll(output, await this.read(entry.extent + offset, Math.min(CHUNK, entry.size - offset)), offset);
  }
}

export async function readIsoLabel(isoPath: string): Promise<string> {
  const iso = await IsoReader.open(isoPath); try { return iso.label; } finally { await iso.close(); }
}

export async function extractIsoFiles(isoPath: string, outputDirectory: string, files: readonly {isoPath: string; outputName?: string}[]): Promise<Record<string, string>> {
  if (!files.length || files.length > 16) throw new Error('一次只能提取 1 至 16 个启动文件');
  const destination = await directory(outputDirectory, true), used = new Set<string>(), result: Record<string, string> = {};
  const planned = files.map(file => { const parts = safeRelative(file.isoPath), name = file.outputName ?? parts.at(-1)!; safeRelative(name, true); if (used.has(name.toLowerCase())) throw new Error('提取文件名称重复'); used.add(name.toLowerCase()); return { ...file, name }; });
  const iso = await IsoReader.open(isoPath);
  try {
    const entries = await Promise.all(planned.map(file => iso.find(file.isoPath)));
    for (let i = 0; i < planned.length; i++) { const file = planned[i], output = join(destination, file.name); await outputFile(output, handle => iso.copy(entries[i], handle)); result[file.isoPath] = output; }
    return result;
  } finally { await iso.close(); }
}

const rrEntry = (signature: string, payload: Buffer) => Buffer.concat([Buffer.from([signature.charCodeAt(0), signature.charCodeAt(1), payload.length + 4, 1]), payload]);
function px(isDirectory: boolean) { const data = Buffer.alloc(40); put32(data, 0, isDirectory ? 0o040755 : 0o100644); put32(data, 8, isDirectory ? 2 : 1); return rrEntry('PX', data); }
const er = () => { const id = Buffer.from('RRIP_1991A'); return rrEntry('ER', Buffer.concat([Buffer.from([id.length, 0, 0, 1]), id])); };
function record(extent: number, size: number, name: Buffer, isDirectory: boolean, system = Buffer.alloc(0)) {
  const length = 33 + name.length + (name.length % 2 === 0 ? 1 : 0) + system.length;
  if (length > 255) throw new Error('配置文件名过长');
  const buffer = Buffer.alloc(length); buffer[0] = length; put32(buffer, 2, extent); put32(buffer, 10, size);
  buffer.set([126, 1, 1, 0, 0, 0, 0], 18); buffer[25] = isDirectory ? 2 : 0; put16(buffer, 28, 1); buffer[32] = name.length; name.copy(buffer, 33); system.copy(buffer, length - system.length); return buffer;
}
function packRecords(records: Buffer[]) {
  const pieces: Buffer[] = []; let offset = 0;
  for (const record of records) { const remaining = BLOCK - offset % BLOCK; if (record.length > remaining) { pieces.push(Buffer.alloc(remaining)); offset += remaining; } pieces.push(record); offset += record.length; }
  pieces.push(Buffer.alloc(align(offset, BLOCK) - offset)); return Buffer.concat(pieces);
}
function pathTable(extent: number, big: boolean) { const buffer = Buffer.alloc(10); buffer[0] = 1; if (big) { buffer.writeUInt32BE(extent, 2); buffer.writeUInt16BE(1, 6); } else { buffer.writeUInt32LE(extent, 2); buffer.writeUInt16LE(1, 6); } return buffer; }

/** Small root-only configuration CD with ISO9660, Joliet and Rock Ridge names. */
export async function createConfigIso(outputPath: string, label: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(label)) throw new Error('配置光盘标签须为 1 至 32 位字母、数字、下划线或连字符');
  const names = new Set<string>(); let total = 0;
  const entries = Object.entries(files).map(([name, contents], index) => {
    safeRelative(name, true);
    if (name.length > 64 || Buffer.byteLength(name) > 120 || /[\ud800-\udfff]/.test(name) || names.has(name.toLowerCase())) throw new Error('配置文件名过长、重复或包含不支持的字符');
    names.add(name.toLowerCase()); const data = typeof contents === 'string' ? Buffer.from(contents) : Buffer.from(contents); total += data.length;
    if (total > 16 * CHUNK) throw new Error('配置光盘内容不得超过 16 MiB');
    return { name, alias: Buffer.from(`FILE${String(index + 1).padStart(4, '0')}.;1`), data, extent: 0 };
  });
  if (!entries.length || entries.length > 64) throw new Error('配置光盘须包含 1 至 64 个文件');
  const jolietEntries = [...entries].sort((left, right) => Buffer.compare(ucs2(left.name), ucs2(right.name)));
  const rr = (name: string) => Buffer.concat([rrEntry('RR', Buffer.from([9])), px(false), rrEntry('NM', Buffer.concat([Buffer.from([0]), Buffer.from(name)]))]);
  const rootSystem = Buffer.concat([rrEntry('SP', Buffer.from([0xbe, 0xef, 0])), rrEntry('RR', Buffer.from([1])), px(true), er()]);
  const primarySize = packRecords([record(0, 0, Buffer.from([0]), true, rootSystem), record(0, 0, Buffer.from([1]), true, px(true)), ...entries.map(file => record(0, file.data.length, file.alias, false, rr(file.name)))]).length;
  const jolietSize = packRecords([record(0, 0, Buffer.from([0]), true), record(0, 0, Buffer.from([1]), true), ...jolietEntries.map(file => record(0, file.data.length, ucs2(file.name), false))]).length;
  const primaryExtent = 23, jolietExtent = primaryExtent + primarySize / BLOCK;
  let cursor = jolietExtent + jolietSize / BLOCK;
  for (const entry of entries) { entry.extent = cursor; cursor += Math.max(1, Math.ceil(entry.data.length / BLOCK)); }
  const volume = Buffer.alloc(cursor * BLOCK);
  function descriptor(type: number, rootExtent: number, rootSize: number, le: number, be: number) {
    const block = Buffer.alloc(BLOCK); block[0] = type; block.write('CD001', 1); block[6] = 1;
    if (type === 2) { ucs2('DESKLAB'.padEnd(16)).copy(block, 8); ucs2(label.padEnd(16).slice(0,16)).copy(block, 40); block.write('%/E', 88); }
    else { block.write('DESKLAB'.padEnd(32), 8); block.write(label.padEnd(32), 40); }
    put32(block, 80, cursor); put16(block, 120, 1); put16(block, 124, 1); put16(block, 128, BLOCK); put32(block, 132, 10); block.writeUInt32LE(le, 140); block.writeUInt32BE(be, 148);
    record(rootExtent, rootSize, Buffer.from([0]), true).copy(block, 156); block.fill(type === 2 ? 0 : 32, 190, 813); block[881] = 1;
    for (const offset of [813, 830, 847, 864]) block.write('0000000000000000', offset);
    return block;
  }
  descriptor(1, primaryExtent, primarySize, 19, 20).copy(volume, 16 * BLOCK); descriptor(2, jolietExtent, jolietSize, 21, 22).copy(volume, 17 * BLOCK);
  volume[18 * BLOCK] = 255; volume.write('CD001', 18 * BLOCK + 1); volume[18 * BLOCK + 6] = 1;
  pathTable(primaryExtent, false).copy(volume, 19 * BLOCK); pathTable(primaryExtent, true).copy(volume, 20 * BLOCK); pathTable(jolietExtent, false).copy(volume, 21 * BLOCK); pathTable(jolietExtent, true).copy(volume, 22 * BLOCK);
  packRecords([record(primaryExtent, primarySize, Buffer.from([0]), true, rootSystem), record(primaryExtent, primarySize, Buffer.from([1]), true, px(true)), ...entries.map(file => record(file.extent, file.data.length, file.alias, false, rr(file.name)))]).copy(volume, primaryExtent * BLOCK);
  packRecords([record(jolietExtent, jolietSize, Buffer.from([0]), true), record(jolietExtent, jolietSize, Buffer.from([1]), true), ...jolietEntries.map(file => record(file.extent, file.data.length, ucs2(file.name), false))]).copy(volume, jolietExtent * BLOCK);
  for (const entry of entries) entry.data.copy(volume, entry.extent * BLOCK);
  await outputFile(outputPath, handle => writeAll(handle, volume, 0));
}

function cpioFile(name: string, data: Buffer, inode: number) {
  const filename = Buffer.from(`${name}\0`), fields = [inode, 0o100644, 0, 0, 1, 0, data.length, 0, 0, 0, 0, filename.length, 0];
  const header = Buffer.from(`070701${fields.map(value => value.toString(16).padStart(8, '0')).join('')}`), prefix = Buffer.concat([header, filename]);
  return Buffer.concat([prefix, Buffer.alloc(align(prefix.length, 4) - prefix.length), data, Buffer.alloc(align(data.length, 4) - data.length)]);
}

/** Linux accepts concatenated gzip cpio members; the original initrd remains unchanged. */
export async function appendInitrdPreseed(initrdPath: string, outputPath: string, preseed: string | Uint8Array): Promise<void> {
  const data = typeof preseed === 'string' ? Buffer.from(preseed) : Buffer.from(preseed);
  if (data.length > CHUNK) throw new Error('Debian 自动安装配置不得超过 1 MiB');
  const info = await lstat(initrdPath); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BOOT_FILE) throw new Error('initrd 必须是不超过 512 MiB 的普通文件');
  const source = await open(initrdPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const actual = await source.stat(); if (actual.ino !== info.ino || actual.dev !== info.dev || actual.size !== info.size) throw new Error('initrd 文件已变更');
    const archive = Buffer.concat([cpioFile('preseed.cfg', data, 1), cpioFile('TRAILER!!!', Buffer.alloc(0), 2)]), tail = gzipSync(Buffer.concat([archive, Buffer.alloc(align(archive.length, 512) - archive.length)]));
    await outputFile(outputPath, async output => {
      const buffer = Buffer.alloc(CHUNK); let position = 0;
      while (position < info.size) { const { bytesRead } = await source.read(buffer, 0, Math.min(CHUNK, info.size - position), position); if (!bytesRead) throw new Error('initrd 文件被截断'); await writeAll(output, buffer.subarray(0, bytesRead), position); position += bytesRead; }
      await writeAll(output, tail, position);
    });
  } finally { await source.close(); }
}
