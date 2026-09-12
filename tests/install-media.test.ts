import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { appendInitrdPreseed, createConfigIso, extractIsoFiles, readIsoLabel } from '../server/install-media';

const BLOCK = 2048;
async function fixture() { await mkdir('.runtime/tests/tests', { recursive: true }); return mkdtemp(resolve('.runtime/tests/tests', 'install-media-test-')); }
async function digest(path: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
const put32 = (buffer: Buffer, offset: number, value: number) => { buffer.writeUInt32LE(value, offset); buffer.writeUInt32BE(value, offset + 4); };
function rawNames(iso: Buffer, descriptorSector: number) {
  const descriptor = iso.subarray(descriptorSector * BLOCK, (descriptorSector + 1) * BLOCK), extent = descriptor.readUInt32LE(158), size = descriptor.readUInt32LE(166), result: {name:string; offset:number; size:number; record:number}[] = [];
  for (let position = extent * BLOCK; position < extent * BLOCK + size;) {
    const length = iso[position]; if (!length) { position = Math.ceil((position + 1) / BLOCK) * BLOCK; continue; }
    const raw = iso.subarray(position + 33, position + 33 + iso[position + 32]);
    if (!(raw.length === 1 && raw[0] <= 1)) result.push({ name: descriptor[0] === 2 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('ascii'), offset: iso.readUInt32LE(position + 2) * BLOCK, size: iso.readUInt32LE(position + 10), record: position });
    position += length;
  }
  return result;
}

test('configuration disc exposes exact Joliet names and Rock Ridge fallback with a usable volume label', async () => {
  const root = await fixture(), iso = join(root, 'seed.iso'), files = { 'user-data': '#cloud-config\nautoinstall: {}\n', 'meta-data': 'instance-id: desklab\n', 'Autounattend.xml': '<unattend/>', 'Finish.ps1': 'Write-Host DeskLab', 'long-config-file-with-MixedCase-characters.txt': 'long name' };
  await createConfigIso(iso, 'cidata', files);
  expect(await readIsoLabel(iso)).toBe('cidata');
  const raw = await readFile(iso), joliet = rawNames(raw, 17);
  expect(joliet.map(entry => entry.name)).toEqual(Object.keys(files).sort());
  for (const entry of joliet) expect(raw.subarray(entry.offset, entry.offset + entry.size).toString()).toBe(files[entry.name as keyof typeof files]);
  const extracted = await extractIsoFiles(iso, join(root, 'joliet'), Object.keys(files).map(name => ({isoPath:name.toUpperCase(), outputName:name})));
  for (const [name, path] of Object.entries(extracted)) expect(await Bun.file(path).text()).toBe(files[Object.keys(files).find(original => original.toUpperCase() === name)! as keyof typeof files]);
  // Disable the supplementary descriptor: Linux must still see exact RR names.
  raw[17 * BLOCK] = 0; await Bun.write(join(root, 'rock-ridge.iso'), raw);
  const fallback = await extractIsoFiles(join(root, 'rock-ridge.iso'), join(root, 'rr'), [{isoPath:'user-data'}, {isoPath:'Autounattend.xml'}]);
  expect(await Bun.file(fallback['user-data']).text()).toBe(files['user-data']);
  expect(await Bun.file(fallback['Autounattend.xml']).text()).toBe(files['Autounattend.xml']);
});

test('configuration ISO enforces bounded size, safe names and non-overwriting writes', async () => {
  const root = await fixture(), iso = join(root, 'seed.iso');
  await createConfigIso(iso, 'DESKLAB', {'Finish.ps1':'original'});
  const before = await digest(iso);
  await expect(createConfigIso(iso, 'DESKLAB', {'Finish.ps1':'overwrite'})).rejects.toThrow('已存在');
  expect(await digest(iso)).toBe(before);
  await expect(createConfigIso(join(root, 'escape.iso'), 'DESKLAB', {'../outside':'x'})).rejects.toThrow('相对路径');
  await expect(createConfigIso(join(root, 'large.iso'), 'DESKLAB', {'large':new Uint8Array(16 * 1024 * 1024 + 1)})).rejects.toThrow('16 MiB');
  await expect(extractIsoFiles(iso, join(root, 'extract'), [{isoPath:'../Finish.ps1'}])).rejects.toThrow('相对路径');
  await expect(extractIsoFiles(iso, join(root, 'extract'), [{isoPath:'Finish.ps1',outputName:'../escape'}])).rejects.toThrow('相对路径');
  const outside = join(root, 'outside'); await mkdir(outside); await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(extractIsoFiles(iso, join(root, 'linked'), [{isoPath:'Finish.ps1'}])).rejects.toThrow('普通文件夹');
});

test('ISO parser rejects corrupted extents, record lengths and excessive directory sizes before copying', async () => {
  const root = await fixture(), good = join(root, 'good.iso'); await createConfigIso(good, 'DESKLAB', {'kernel':'kernel'});
  const original = await readFile(good), record = rawNames(original, 17)[0].record;
  const cases: [string,(iso:Buffer)=>void][] = [
    ['extent', iso => put32(iso, record + 2, 0xfffffff0)],
    ['size', iso => put32(iso, record + 10, 0xffffffff)],
    ['endian', iso => iso.writeUInt32BE(1, record + 6)],
    ['record', iso => { iso[record] = 10; }],
    ['volume', iso => put32(iso, 16 * BLOCK + 80, 0x7fffffff)],
    ['block', iso => { iso.writeUInt16LE(512, 16 * BLOCK + 128); iso.writeUInt16BE(512, 16 * BLOCK + 130); }],
  ];
  for (const [name, mutate] of cases) { const iso = Buffer.from(original); mutate(iso); const path = join(root, `${name}.iso`); await Bun.write(path, iso); await expect(extractIsoFiles(path, join(root, name), [{isoPath:'kernel'}])).rejects.toThrow('安装介质无效'); }
  await Bun.write(join(root, 'short.iso'), original.subarray(0, 17 * BLOCK));
  await expect(readIsoLabel(join(root, 'short.iso'))).rejects.toThrow('安装介质无效');
});

test('reads a tiny file at a distant extent without loading the image into memory', async () => {
  const root = await fixture(), seed = join(root, 'small.iso'); await createConfigIso(seed, 'DESKLAB', {'kernel':'sparse-kernel'});
  const metadata = await readFile(seed), large = join(root, 'sparse.iso'), length = 256 * 1024 * 1024, extent = length / BLOCK - 1;
  put32(metadata, 16 * BLOCK + 80, length / BLOCK); put32(metadata, 17 * BLOCK + 80, length / BLOCK);
  for (const descriptor of [16,17]) put32(metadata, rawNames(metadata, descriptor)[0].record + 2, extent);
  const handle = await open(large, 'wx');
  try { await handle.write(metadata, 0, metadata.length, 0); await handle.truncate(length); await handle.write(Buffer.from('sparse-kernel'), 0, 13, extent * BLOCK); } finally { await handle.close(); }
  const before = process.memoryUsage().arrayBuffers;
  const extracted = await extractIsoFiles(large, join(root, 'extracted'), [{isoPath:'KERNEL'}]);
  expect(await Bun.file(extracted.KERNEL).text()).toBe('sparse-kernel');
  expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
  expect((await lstat(large)).size).toBe(length);
  const malicious = Buffer.from(metadata); put32(malicious, 17 * BLOCK + 166, 32 * 1024 * 1024);
  const update = await open(large, 'r+'); try { await update.write(malicious, 0, malicious.length, 0); } finally { await update.close(); }
  await expect(extractIsoFiles(large, join(root, 'oversized-dir'), [{isoPath:'kernel'}])).rejects.toThrow('目录大小超出限制');
});

test('reads Rock Ridge continuation names and rejects continuation cycles and out-of-bounds ranges', async () => {
  const root = await fixture(), seed = join(root, 'seed.iso'); await createConfigIso(seed, 'DESKLAB', {'original-name':'kernel contents'});
  const original = await readFile(seed), image = Buffer.concat([original, Buffer.alloc(BLOCK)]), extent = original.length / BLOCK;
  image[17 * BLOCK] = 0; put32(image, 16 * BLOCK + 80, image.length / BLOCK);
  const file = rawNames(image,16)[0].record, length = image[file+32], start = file+33+length+(length%2===0?1:0);
  const name = Buffer.from('Name-In-Continuation'), nm = Buffer.concat([Buffer.from([78,77,5+name.length,1,0]),name]);
  image.fill(0,start,file+image[file]); image.set([67,69,28,1],start); put32(image,start+4,extent); put32(image,start+12,0); put32(image,start+20,nm.length); nm.copy(image,original.length);
  await Bun.write(join(root,'ce.iso'),image);
  const extracted = await extractIsoFiles(join(root,'ce.iso'),join(root,'ce'),[{isoPath:'name-in-continuation'}]);
  expect(await Bun.file(extracted['name-in-continuation']).text()).toBe('kernel contents');
  const cyclic = Buffer.from(image); put32(cyclic,start+20,28); cyclic.copy(cyclic,original.length,start,start+28); await Bun.write(join(root,'cycle.iso'),cyclic);
  await expect(extractIsoFiles(join(root,'cycle.iso'),join(root,'cycle'),[{isoPath:'name-in-continuation'}])).rejects.toThrow('循环');
  const outside = Buffer.from(image); put32(outside,start+4,extent+1); await Bun.write(join(root,'ce-bounds.iso'),outside);
  await expect(extractIsoFiles(join(root,'ce-bounds.iso'),join(root,'ce-bounds'),[{isoPath:'name-in-continuation'}])).rejects.toThrow('边界');
});

test('appends a gzip newc preseed archive while leaving original initrd bytes unchanged', async () => {
  const root = await fixture(), original = join(root, 'initrd.gz'), output = join(root, 'initrd-preseed.gz'), contents = 'd-i passwd/root-login boolean true\n';
  const initial = gzipSync(Buffer.from('original initramfs fixture')); await Bun.write(original, initial);
  await appendInitrdPreseed(original, output, contents);
  expect(Buffer.compare(await readFile(original), initial)).toBe(0);
  const result = await readFile(output); expect(Buffer.compare(result.subarray(0, initial.length), initial)).toBe(0);
  const archive = gunzipSync(result.subarray(initial.length));
  expect(archive.toString('ascii',0,6)).toBe('070701');
  const size = parseInt(archive.toString('ascii',54,62),16), nameSize = parseInt(archive.toString('ascii',94,102),16);
  expect(archive.toString('utf8',110,110+nameSize-1)).toBe('preseed.cfg');
  const start = Math.ceil((110+nameSize)/4)*4; expect(archive.toString('utf8',start,start+size)).toBe(contents);
  expect(archive.includes(Buffer.from('TRAILER!!!\0'))).toBe(true); expect(archive.length % 512).toBe(0);
  await expect(appendInitrdPreseed(original, output, 'different')).rejects.toThrow('已存在');
});

const realImages = [
  ['ubuntu-server','ubuntu-24.04.5-live-server-amd64.iso','casper/vmlinuz','casper/initrd'],
  ['ubuntu-desktop','ubuntu-24.04.5-desktop-amd64.iso','casper/vmlinuz','casper/initrd'],
  ['debian-server','debian-13.6.0-amd64-DVD-1.iso','install.amd/vmlinuz','install.amd/initrd.gz'],
  ['debian-desktop','debian-live-13.6.0-amd64-gnome.iso','install/vmlinuz','install/initrd.gz'],
  ['rocky-server','Rocky-9.8-x86_64-minimal.iso','images/pxeboot/vmlinuz','images/pxeboot/initrd.img'],
  ['rocky-desktop','Rocky-9.8-Workstation-x86_64-20260525.0.iso','boot/x86_64/loader/linux','boot/x86_64/loader/initrd'],
];
for (const [id,file,kernel,initrd] of realImages) test.skipIf(!existsSync(join('iso',file)))(`extracts authentic ${id} boot files using bounded reads`, async () => {
  const root = await fixture(), iso = resolve('iso',file), label = await readIsoLabel(iso);
  expect(label.length).toBeGreaterThan(0);
  if (id === 'rocky-server') expect(label).toBe('Rocky-9-8-x86_64-dvd');
  const extracted = await extractIsoFiles(iso, join(root,'boot'), [{isoPath:kernel.toUpperCase(),outputName:'vmlinuz'}, {isoPath:initrd.toUpperCase(),outputName:'initrd'}]);
  for (const path of [kernel,initrd]) { const reference = resolve('.runtime/tests/tests','provision',id,...path.split('/')); if (existsSync(reference)) expect(await digest(extracted[path.toUpperCase()])).toBe(await digest(reference)); else expect((await lstat(extracted[path.toUpperCase()])).size).toBeGreaterThan(1024*1024); }
}, 30000);
