import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { listFiles } from '../server/file-picker';

async function fixture(run: (root: string) => Promise<void>) {
  const runtime = resolve('.runtime/tests/tests');
  await mkdir(runtime, {recursive: true});
  const root = await mkdtemp(join(runtime, 'file-picker-'));
  try { await run(root); }
  finally {
    const target = resolve(root);
    if (!target.startsWith(runtime + sep)) throw new Error('Fixture cleanup must remain in .runtime');
    await rm(target, {recursive: true, force: true});
  }
}

test('lists only directories and requested extensions, with natural ordering and absolute paths', async () => {
  await fixture(async root => {
    for (const name of ['Z folder', 'A folder']) await mkdir(join(root, name));
    for (const name of ['image10.iso', 'image2.ISO', 'image1.iso', 'ignore.iso.part', 'notes.txt', 'disk.qcow2', 'disk.img', 'disk.raw', 'disk.vmdk', 'disk.vhd', 'disk.VHDX', 'disk.vdi']) await Bun.write(join(root, name), 'fixture');
    const iso = await listFiles({kind: 'iso', path: root});
    expect(iso.entries.map(item => item.name)).toEqual(['A folder', 'Z folder', 'image1.iso', 'image2.ISO', 'image10.iso']);
    expect(iso.entries.every(item => isAbsolute(item.path))).toBe(true);
    expect(iso.entries.map(item => item.directory)).toEqual([true, true, false, false, false]);
    expect(iso.path).toBe(root); expect(iso.parent).toBe(dirname(root)); expect(iso.truncated).toBe(false);
    const disk = await listFiles({kind: 'disk', path: root});
    expect(disk.entries.filter(item => !item.directory).map(item => item.name).sort()).toEqual(['disk.qcow2', 'disk.img', 'disk.raw', 'disk.vmdk', 'disk.vhd', 'disk.VHDX', 'disk.vdi'].sort());
    expect((await listFiles({kind: 'directory', path: root})).entries.map(item => item.name)).toEqual(['A folder', 'Z folder']);
  });
});

test('supports Chinese names and spaces, and shows the parent of an explicitly typed file', async () => {
  await fixture(async root => {
    const directory = join(root, '我的 系统镜像'), file = join(directory, 'Windows 服务器 安装.ISO');
    await mkdir(directory); await Bun.write(file, 'original ISO fixture');
    const listing = await listFiles({kind: 'iso', path: file});
    expect(listing.path).toBe(directory);
    expect(listing.entries).toEqual([{name: 'Windows 服务器 安装.ISO', path: file, directory: false}]);
    expect((await listFiles({kind: 'iso'}, directory)).path).toBe(directory);
  });
});

test('opening or cancelling browsing does not create or modify files', async () => {
  await fixture(async root => {
    const file = join(root, 'keep.iso'); await Bun.write(file, 'must remain unchanged');
    const before = await stat(file), names = await readdir(root);
    await listFiles({kind: 'iso', path: root});
    // Cancellation is entirely client-side: there is no selection/save API call.
    expect(await readdir(root)).toEqual(names);
    expect(await Bun.file(file).text()).toBe('must remain unchanged');
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });
});

test('rejects relative paths, malformed input and explicit missing locations with readable errors', async () => {
  await fixture(async root => {
    await expect(listFiles({kind: 'iso', path: 'relative/path'})).rejects.toThrow('绝对路径');
    await expect(listFiles({kind: 'disk', path: join(root, 'missing')})).rejects.toThrow('不存在');
    await Bun.write(join(root, 'regular.iso'), 'fixture');
    await expect(listFiles({kind: 'iso', path: join(root, 'regular.iso', 'child')})).rejects.toThrow('不存在');
    await expect(listFiles({kind: 'invalid', path: root})).rejects.toThrow('请选择');
    await expect(listFiles({kind: 'iso', path: root + '\0'})).rejects.toThrow('控制字符');
    if (process.platform === 'win32') {
      await expect(listFiles({kind: 'iso', path: 'C:relative'})).rejects.toThrow('绝对路径');
      await expect(listFiles({kind: 'iso', path: '\\relative'})).rejects.toThrow('绝对路径');
    }
  });
});

test('falls back from a missing default directory and exposes existing absolute shortcuts', async () => {
  await fixture(async root => {
    const listing = await listFiles({kind: 'directory'}, join(root, 'not-created'));
    expect(listing.path).toBe(resolve(homedir()));
    expect(listing.shortcuts.find(item => item.name === '用户目录')?.path).toBe(resolve(homedir()));
    expect(listing.shortcuts.every(item => isAbsolute(item.path))).toBe(true);
    expect((await Promise.all(listing.shortcuts.map(item => stat(item.path)))).every(info => info.isDirectory())).toBe(true);
    expect(await Bun.file(join(root, 'not-created')).exists()).toBe(false);
    const rootListing = await listFiles({kind: 'directory', path: parse(root).root});
    expect(rootListing.parent).toBeNull();
  });
});

test('returns at most 500 matches and preserves an explicit file beyond the truncated listing', async () => {
  await fixture(async root => {
    for (let batch = 0; batch < 11; batch++) await Promise.all(Array.from({length: 50}, (_, index) => Bun.write(join(root, `image-${String(batch * 50 + index).padStart(4, '0')}.iso`), 'fixture')));
    const listing = await listFiles({kind: 'iso', path: root});
    expect(listing.entries).toHaveLength(500); expect(listing.truncated).toBe(true);
    expect(listing.entries.every(item => item.name.endsWith('.iso'))).toBe(true);
    expect((await readdir(root)).length).toBe(550);
    const selected = join(root, 'image-0549.iso');
    const focused = await listFiles({kind: 'iso', path: selected});
    expect(focused.entries).toHaveLength(500); expect(focused.truncated).toBe(true);
    expect(focused.entries.filter(item => item.path === selected)).toHaveLength(1);
  });
});

test('bounds scanning even when a large directory contains no matching files', async () => {
  await fixture(async root => {
    for (let batch = 0; batch < 51; batch++) await Promise.all(Array.from({length: 100}, (_, index) => Bun.write(join(root, `unrelated-${batch * 100 + index}.txt`), 'fixture')));
    const listing = await listFiles({kind: 'iso', path: root});
    expect(listing.entries).toEqual([]);
    expect(listing.truncated).toBe(true);
    expect((await readdir(root)).length).toBe(5100);
  });
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports unreadable directories without changing their permissions', async () => {
  await fixture(async root => {
    const blocked = join(root, 'blocked'); await mkdir(blocked); await chmod(blocked, 0);
    try { await expect(listFiles({kind: 'iso', path: blocked})).rejects.toThrow('没有权限'); }
    finally { await chmod(blocked, 0o700); }
  });
});
