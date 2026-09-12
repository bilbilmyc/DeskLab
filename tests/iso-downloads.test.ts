import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { IsoDownloads, type DownloadProgress, type IsoSource } from '../server/iso-downloads';

type Mode = 'range' | 'ignore' | 'bad-range' | 'bad-etag' | 'bad-total' | 'bad-body' | 'disconnect';
async function fixture(mode: Mode = 'range') {
  await mkdir('.runtime/tests/tests', { recursive: true });
  const directory = await mkdtemp(resolve('.runtime/tests/tests', 'iso-download-test-'));
  const bytes = Buffer.alloc(1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const requests: { range: string | null; ifRange: string | null; path: string }[] = [];
  let current = mode;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const range = request.headers.get('range'), ifRange = request.headers.get('if-range');
    requests.push({ range, ifRange, path: new URL(request.url).pathname });
    const requested = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1]) : 0;
    const offset = current === 'ignore' ? 0 : requested;
    const headers = new Headers({ 'content-type': 'application/octet-stream', 'content-length': String(bytes.length - offset), etag: current === 'bad-etag' && offset ? '"changed"' : '"fixture-v1"' });
    if (offset) headers.set('content-range', `bytes ${current === 'bad-range' ? offset + 1 : offset}-${bytes.length - 1}/${current === 'bad-total' ? bytes.length + 1 : bytes.length}`);
    let position = offset, timer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = () => {
          if (current === 'disconnect' && position >= 128 * 1024) { controller.close(); return; }
          if (position >= bytes.length) { controller.close(); return; }
          const next = Math.min(position + 16 * 1024, bytes.length);
          const chunk = current === 'bad-body' ? Buffer.alloc(next - position, 42) : bytes.subarray(position, next);
          controller.enqueue(chunk); position = next; timer = setTimeout(emit, 8);
        };
        emit();
      },
      cancel() { clearTimeout(timer); },
    });
    return new Response(body, { status: offset ? 206 : 200, headers });
  } });
  const sources: IsoSource[] = ['ubuntu', 'debian', 'rocky'].map(id => ({ id, file: `${id}.iso`, url: `${server.url}${id}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  const managers: IsoDownloads[] = [];
  return { directory, bytes, requests, sources, mode(value: Mode) { current = value; }, manager(selected = sources) { const manager = new IsoDownloads(selected); managers.push(manager); return manager; }, async close() {
    const results = await Promise.allSettled(managers.map(manager => manager.shutdown()));
    await server.stop(true);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Download fixture cleanup failed');
  } };
}
async function until(manager: IsoDownloads, directory: string, id: string, predicate: (progress: DownloadProgress) => boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const item = (await manager.list(directory)).find(item => item.id === id); if (item && predicate(item)) return item; await Bun.sleep(15); }
  throw new Error(`Download did not reach expected state: ${JSON.stringify(await manager.list(directory))}`);
}
async function settledError(directory: string, id: string, expectedError: string, timeout = 15000) {
  const deadline = Date.now() + timeout, scratch = join(directory, '.desklab-downloads');
  while (Date.now() < deadline) {
    let locked = true;
    try { await lstat(join(scratch, '.lock')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') locked = false; else throw error; }
    if (!locked) {
      const saved = JSON.parse(await readFile(join(scratch, `${id}.json`), 'utf8'));
      expect(saved.progress.status).toBe('error'); expect(saved.progress.error).toContain(expectedError);
      return;
    }
    await Bun.sleep(15);
  }
  throw new Error('Failed download did not persist its terminal state and release its directory lock');
}

test('downloads actual bytes, exposes progress, verifies hash, and publishes complete ISO', async () => {
  const f = await fixture(), manager = f.manager();
  try {
    expect(await manager.list(f.directory)).toEqual([]);
    expect((await manager.start('ubuntu', f.directory)).status).toBe('queued');
    const progress = await until(manager, f.directory, 'ubuntu', item => item.received > 0 && item.received < item.total);
    expect(progress.total).toBe(f.bytes.length); expect(manager.hasActive()).toBe(true);
    const done = await until(manager, f.directory, 'ubuntu', item => item.status === 'completed');
    expect(done.verified).toBe(true); expect(done.received).toBe(f.bytes.length);
    expect(Buffer.compare(await readFile(join(f.directory, 'ubuntu.iso')), f.bytes)).toBe(0);
    expect(await Bun.file(join(f.directory, '.desklab-downloads', 'ubuntu.part')).exists()).toBe(false);
    expect(manager.hasActive()).toBe(false);
  } finally { await f.close(); }
});

test('pause and restart persist bytes and resume with validated Range and If-Range', async () => {
  const f = await fixture(), first = f.manager();
  try {
    await first.start('ubuntu', f.directory);
    await until(first, f.directory, 'ubuntu', item => item.received >= 96 * 1024);
    const paused = await first.pause('ubuntu', f.directory);
    expect(paused.status).toBe('paused'); expect(paused.received).toBeGreaterThan(0);
    await first.shutdown();
    const second = f.manager();
    expect((await second.list(f.directory))[0].status).toBe('paused');
    expect(second.hasActive()).toBe(false);
    await second.start('ubuntu', f.directory);
    await until(second, f.directory, 'ubuntu', item => item.status === 'completed');
    expect(f.requests[1].range).toBe(`bytes=${paused.received}-`);
    expect(f.requests[1].ifRange).toBe('"fixture-v1"');
    expect(Buffer.compare(await readFile(join(f.directory, 'ubuntu.iso')), f.bytes)).toBe(0);
  } finally { await f.close(); }
});

test('server ignoring Range safely restarts instead of appending duplicate content', async () => {
  const f = await fixture(), manager = f.manager();
  try {
    await manager.start('ubuntu', f.directory);
    await until(manager, f.directory, 'ubuntu', item => item.received >= 96 * 1024);
    await manager.pause('ubuntu', f.directory); f.mode('ignore');
    await manager.start('ubuntu', f.directory);
    await until(manager, f.directory, 'ubuntu', item => item.status === 'completed');
    expect(f.requests[1].range).not.toBeNull();
    expect(Buffer.compare(await readFile(join(f.directory, 'ubuntu.iso')), f.bytes)).toBe(0);
  } finally { await f.close(); }
});

for (const mode of ['bad-range', 'bad-total', 'bad-etag'] as const) test(`rejects ${mode} on resume and retries from zero`, async () => {
  const f = await fixture(), manager = f.manager();
  try {
    await manager.start('ubuntu', f.directory);
    await until(manager, f.directory, 'ubuntu', item => item.received >= 96 * 1024);
    await manager.pause('ubuntu', f.directory); f.mode(mode);
    await manager.start('ubuntu', f.directory);
    const error = await until(manager, f.directory, 'ubuntu', item => item.status === 'error');
    expect(error.error).toContain('续传信息'); expect(await Bun.file(join(f.directory, 'ubuntu.iso')).exists()).toBe(false);
    f.mode('range'); await manager.start('ubuntu', f.directory);
    await until(manager, f.directory, 'ubuntu', item => item.status === 'completed');
    expect(f.requests[2].range).toBeNull();
  } finally { await f.close(); }
});

test('hash mismatch keeps ISO unpublished and retry downloads from zero', async () => {
  const f = await fixture('bad-body'), manager = f.manager();
  try {
    await manager.start('ubuntu', f.directory);
    expect((await until(manager, f.directory, 'ubuntu', item => item.status === 'error')).error).toContain('完整性校验失败');
    expect(await Bun.file(join(f.directory, 'ubuntu.iso')).exists()).toBe(false);
    f.mode('range'); await manager.start('ubuntu', f.directory);
    await until(manager, f.directory, 'ubuntu', item => item.status === 'completed');
    expect(f.requests[1].range).toBeNull();
  } finally { await f.close(); }
});

test('limits concurrency to two, deduplicates start, and pauses queued download without HTTP', async () => {
  const f = await fixture(), manager = f.manager();
  try {
    await manager.start('ubuntu', f.directory); await manager.start('debian', f.directory); await manager.start('rocky', f.directory);
    await manager.start('ubuntu', f.directory);
    expect((await manager.list(f.directory)).find(item => item.id === 'rocky')?.status).toBe('queued');
    expect((await manager.pause('rocky', f.directory)).status).toBe('paused');
    await until(manager, f.directory, 'ubuntu', item => item.status === 'completed');
    await until(manager, f.directory, 'debian', item => item.status === 'completed');
    expect(f.requests.map(item => item.path).sort()).toEqual(['/debian', '/ubuntu']);
    await manager.start('rocky', f.directory);
    await until(manager, f.directory, 'rocky', item => item.status === 'completed');
  } finally { await f.close(); }
});

test('another manager cannot write concurrently; existing ISO and legacy .part are preserved', async () => {
  const f = await fixture(), first = f.manager(), second = f.manager();
  try {
    await Bun.write(join(f.directory, 'ubuntu.iso.part'), 'legacy download');
    await first.start('ubuntu', f.directory);
    await until(first, f.directory, 'ubuntu', item => item.received > 0);
    await expect(second.start('debian', f.directory)).rejects.toThrow('另一个 DeskLab');
    await first.pause('ubuntu', f.directory);
    await second.start('debian', f.directory);
    await until(second, f.directory, 'debian', item => item.status === 'completed');
    await second.shutdown(); // Wait for the completed worker to release its directory lock.
    await Bun.write(join(f.directory, 'rocky.iso'), 'user ISO');
    await expect(first.start('rocky', f.directory)).rejects.toThrow('已有同名 ISO');
    expect(await Bun.file(join(f.directory, 'rocky.iso')).text()).toBe('user ISO');
    expect(await Bun.file(join(f.directory, 'ubuntu.iso.part')).text()).toBe('legacy download');
  } finally { await f.close(); }
});

test('detects shutdown interruption as paused and does not resume on launch', async () => {
  const f = await fixture(), first = f.manager();
  try {
    await first.start('ubuntu', f.directory); await first.start('debian', f.directory); await first.start('rocky', f.directory);
    await until(first, f.directory, 'ubuntu', item => item.received > 0);
    await first.shutdown();
    const second = f.manager(), saved = await second.list(f.directory), count = f.requests.length;
    expect(saved.map(item => item.status)).toEqual(['paused', 'paused', 'paused']);
    await Bun.sleep(75); expect(f.requests.length).toBe(count); expect(second.hasActive()).toBe(false);
  } finally { await f.close(); }
});

test('rejects unsafe source names and linked scratch directories', async () => {
  const f = await fixture(), manager = f.manager();
  try {
    expect(() => new IsoDownloads([{ ...f.sources[0], file: '../outside.iso' }])).toThrow();
    await expect(manager.start('unknown', f.directory)).rejects.toThrow('下载来源');
    const target = join(f.directory, 'external'); await mkdir(target);
    await symlink(target, join(f.directory, '.desklab-downloads'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(manager.start('ubuntu', f.directory)).rejects.toThrow('普通文件夹');
    expect(f.requests.length).toBe(0);
  } finally { await f.close(); }
});

test('network interruption preserves received bytes and continues after connection recovers', async () => {
  const f = await fixture('disconnect'), manager = f.manager();
  try {
    await manager.start('ubuntu', f.directory);
    const failed = await until(manager, f.directory, 'ubuntu', item => item.status === 'error');
    expect(failed.received).toBeGreaterThan(0); expect(failed.error).toMatch(/连接|下载中断/);
    expect(await Bun.file(join(f.directory, 'ubuntu.iso')).exists()).toBe(false);
    f.mode('range'); await manager.start('ubuntu', f.directory);
    await until(manager, f.directory, 'ubuntu', item => item.status === 'completed');
    expect(f.requests[1].range).toBe(`bytes=${failed.received}-`);
  } finally { await f.close(); }
});

test('recovers a dead process lock without automatically downloading', async () => {
  const f = await fixture(), manager = f.manager();
  const script = `import {IsoDownloads} from ${JSON.stringify(resolve('server/iso-downloads.ts'))}; const downloads = new IsoDownloads(${JSON.stringify(f.sources)}); await downloads.start('ubuntu', ${JSON.stringify(f.directory)}); setInterval(() => {}, 1000);`;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'pipe' });
  try {
    const partial = await until(manager, f.directory, 'ubuntu', item => item.received >= 96 * 1024);
    expect(partial.status).toBe('paused');
    await expect(manager.start('debian', f.directory)).rejects.toThrow('另一个 DeskLab');
    child.kill(); await child.exited;
    expect(manager.hasActive()).toBe(false);
    await manager.start('ubuntu', f.directory);
    await until(manager, f.directory, 'ubuntu', item => item.status === 'completed');
    expect(f.requests[1].range).not.toBeNull();
    expect(Buffer.compare(await readFile(join(f.directory, 'ubuntu.iso')), f.bytes)).toBe(0);
  } catch (error) { child.kill(); await child.exited; throw new Error(`${error}\n${await new Response(child.stderr).text()}`); }
  finally { child.kill(); await child.exited; await f.close(); }
}, 15000);

test('a same-name ISO created during download is never overwritten', async () => {
  const f = await fixture(), manager = f.manager();
  try {
    await manager.start('ubuntu', f.directory);
    await until(manager, f.directory, 'ubuntu', item => item.received > 0);
    await Bun.write(join(f.directory, 'ubuntu.iso'), 'user file appeared');
    expect((await until(manager, f.directory, 'ubuntu', item => item.status === 'error', 15000)).error).toContain('同名 ISO');
    expect(await Bun.file(join(f.directory, 'ubuntu.iso')).text()).toBe('user file appeared');
    // Public progress changes before the final metadata write and lock release.
    // A shutdown during that interval correctly reports the still-settling error.
    await settledError(f.directory, 'ubuntu', '同名 ISO');
  } finally { await f.close(); }
}, 20000);

test('records a local SHA-256 even when no official checksum is available', async () => {
  const f = await fixture(), manager = f.manager(f.sources.map(source => ({ ...source, sha256: null })));
  try {
    await manager.start('ubuntu', f.directory);
    const done = await until(manager, f.directory, 'ubuntu', item => item.status === 'completed');
    expect(done.verified).toBe(false);
    const path = join(f.directory, '.desklab-downloads', 'ubuntu.json');
    // Completion is visible before the final atomic metadata write settles.
    await manager.shutdown();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.localSha256).toBe(createHash('sha256').update(f.bytes).digest('hex'));
    expect(saved.progress.verified).toBe(false);
    expect(saved.progress.status).toBe('completed');
    const reopened = f.manager(f.sources.map(source => ({ ...source, sha256: null })));
    expect((await reopened.list(f.directory))[0].verified).toBe(false);
    expect((await reopened.start('ubuntu', f.directory)).status).toBe('completed');
    expect(JSON.parse(await readFile(path, 'utf8')).localSha256).toBe(saved.localSha256);
  } finally { await f.close(); }
});

test('shutdown waits for every download and releases other directories after a progress write fails', async () => {
  const f = await fixture(), manager = f.manager(), other = join(f.directory, 'other');
  try {
    await mkdir(other);
    await manager.start('ubuntu', f.directory); await manager.start('debian', other); await manager.start('rocky', f.directory);
    await until(manager, f.directory, 'ubuntu', item => item.received > 0);
    const progressPath = join(f.directory, '.desklab-downloads', 'rocky.json');
    await rename(progressPath, `${progressPath}.backup`); await mkdir(progressPath);
    await expect(manager.shutdown()).rejects.toThrow('下载任务已停止');
    expect(manager.hasActive()).toBe(false);
    expect((await manager.list(other))[0].status).toBe('paused');
    for (const directory of [f.directory, other]) expect(await lstat(join(directory, '.desklab-downloads', '.lock')).then(() => true).catch(() => false)).toBe(false);
    const parts = [join(f.directory, '.desklab-downloads', 'ubuntu.part'), join(other, '.desklab-downloads', 'debian.part')];
    const sizes = await Promise.all(parts.map(async path => (await lstat(path)).size));
    await Bun.sleep(50);
    expect(await Promise.all(parts.map(async path => (await lstat(path)).size))).toEqual(sizes);
    for (const path of parts) await rename(path, `${path}.closed`);
  } finally { await f.close(); }
});

test('shutdown attempts all directory locks when an earlier lock was changed externally', async () => {
  const f = await fixture(), manager = f.manager(), other = join(f.directory, 'other');
  const ownerPath = join(f.directory, '.desklab-downloads', '.lock', 'owner.json');
  let owner: string | undefined;
  try {
    await mkdir(other);
    await manager.start('ubuntu', f.directory); await manager.start('debian', other);
    await until(manager, f.directory, 'ubuntu', item => item.received > 0);
    owner = await readFile(ownerPath, 'utf8');
    await Bun.write(ownerPath, JSON.stringify({ ...JSON.parse(owner), token: 'changed-by-fixture' }));
    await expect(manager.shutdown()).rejects.toThrow('下载目录锁已变更');
    expect(manager.hasActive()).toBe(false);
    expect(await lstat(join(other, '.desklab-downloads', '.lock')).then(() => true).catch(() => false)).toBe(false);
    expect((await manager.list(other))[0].status).toBe('paused');
  } finally { if (owner) await Bun.write(ownerPath, owner); await f.close(); }
}, 20000);
