import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export interface IsoSource { id: string; file: string; url: string; bytes: number; sha256?: string | null; }
export interface DownloadProgress {
  id: string; file: string; directory: string;
  status: 'queued' | 'downloading' | 'verifying' | 'paused' | 'completed' | 'error';
  received: number; total: number; speed: number; eta?: number; error?: string; verified?: boolean;
}
type SavedJob = { version: 1; source: string; progress: DownloadProgress; etag?: string; restart?: boolean; localSha256?: string };
type Job = SavedJob & { controller?: AbortController; running?: Promise<void> };
type Directory = { path: string; scratch: string; jobs: Map<string, Job>; lock?: string };
const active = (job: Job) => ['queued', 'downloading', 'verifying'].includes(job.progress.status);
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sourceKey = (source: IsoSource) => createHash('sha256').update(JSON.stringify(source)).digest('hex');
const safeName = (value: string) => /^[a-z0-9][a-z0-9._-]*$/i.test(value) && value === basename(value) && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value);
const copy = (job: Job): DownloadProgress => ({ ...job.progress });

/** Fixed-source downloads. ISO files become visible only after full validation. */
export class IsoDownloads {
  private sources = new Map<string, IsoSource>();
  private directories = new Map<string, Directory>();
  private sequence: Promise<unknown> = Promise.resolve();
  private running = 0;
  private closing = false;

  constructor(sources: readonly IsoSource[]) {
    const files = new Set<string>();
    for (const source of sources) {
      const url = new URL(source.url);
      if (!safeName(source.id) || !safeName(source.file) || !/\.iso$/i.test(source.file) || !Number.isSafeInteger(source.bytes) || source.bytes <= 0 || (source.sha256 && !/^[a-f0-9]{64}$/i.test(source.sha256)) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || this.sources.has(source.id) || files.has(source.file.toLowerCase())) throw new Error('系统镜像下载来源配置无效');
      this.sources.set(source.id, { ...source }); files.add(source.file.toLowerCase());
    }
  }

  async list(directory: string): Promise<DownloadProgress[]> {
    return this.exclusive(async () => {
      const dir = await this.directory(directory, false);
      return dir ? [...dir.jobs.values()].map(copy) : [];
    });
  }

  async start(id: string, directory: string): Promise<DownloadProgress> {
    return this.exclusive(async () => {
      if (this.closing) throw new Error('程序正在退出，请重新打开后下载');
      const source = this.sources.get(id);
      if (!source) throw new Error('找不到这个系统的下载来源');
      const dir = (await this.directory(directory, true))!;
      await this.acquire(dir);
      try {
        let job = dir.jobs.get(id);
        if (job && active(job)) return copy(job);
        if (await this.fileInfo(join(dir.path, source.file))) {
          if (job?.progress.status === 'completed') return copy(job);
          throw new Error('目录中已有同名 ISO，已保留原文件；请直接使用它，或选择其他目录');
        }
        if (!job || job.source !== sourceKey(source)) job = { version: 1, source: sourceKey(source), progress: { id, file: source.file, directory: dir.path, status: 'paused', received: 0, total: source.bytes, speed: 0 }, restart: true };
        job.progress = { ...job.progress, status: 'queued', speed: 0, eta: undefined, error: undefined, verified: undefined };
        job.localSha256 = undefined;
        dir.jobs.set(id, job);
        await this.save(dir, job);
        const result = copy(job);
        this.pump();
        return result;
      } finally { await this.releaseIdle(dir); }
    });
  }

  async pause(id: string, directory: string): Promise<DownloadProgress> {
    const result = await this.exclusive(async () => {
      const dir = await this.directory(directory, false), job = dir?.jobs.get(id);
      if (!dir || !job) throw new Error('找不到这个下载任务');
      if (!active(job)) return { job };
      if (job.controller) { job.controller.abort(new Error('paused')); return { job, pending: job.running }; }
      job.progress = { ...job.progress, status: 'paused', speed: 0, eta: undefined };
      await this.save(dir, job); await this.releaseIdle(dir);
      return { job };
    });
    await result.pending;
    return copy(result.job);
  }

  hasActive(): boolean { return [...this.directories.values()].some(dir => [...dir.jobs.values()].some(active)); }

  async shutdown(): Promise<void> {
    this.closing = true;
    const errors: unknown[] = [], stopping: Job[] = [];
    const pending = await this.exclusive(async () => {
      const promises: Promise<void>[] = [], queued: {dir: Directory; job: Job}[] = [];
      for (const dir of this.directories.values()) for (const job of dir.jobs.values()) {
        if (job.running) { job.controller?.abort(new Error('paused')); promises.push(job.running); stopping.push(job); }
        else if (active(job)) { job.progress = { ...job.progress, status: 'paused', speed: 0, eta: undefined }; queued.push({dir, job}); }
      }
      for (const {dir, job} of queued) try { await this.save(dir, job); } catch (error) { job.progress.error = friendly(error); errors.push(error); }
      return promises;
    });
    for (const result of await Promise.allSettled(pending)) if (result.status === 'rejected') errors.push(result.reason);
    for (const job of stopping) if (job.progress.status === 'error' && job.progress.error) errors.push(new Error(job.progress.error));
    await this.exclusive(async () => {
      for (const dir of this.directories.values()) try { await this.releaseIdle(dir); } catch (error) { errors.push(error); }
    });
    if (errors.length) throw new AggregateError(errors, `下载任务已停止，但部分进度或目录锁未能保存：${[...new Set(errors.map(friendly))].join('；')}`);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.sequence.then(fn); this.sequence = result.catch(() => {}); return result;
  }

  private async directory(input: string, required: boolean): Promise<Directory | undefined> {
    const path = resolve(input);
    try {
      if (!(await lstat(path)).isDirectory() || key(await realpath(path)) !== key(path)) throw new Error('ISO 目录不能使用符号链接或目录联接，请选择实际文件夹');
    } catch (error) { if (!required && absent(error)) return; if (absent(error)) throw new Error('ISO 目录不存在或无法访问，请先在本机设置中选择有效目录'); throw error; }
    const existing = this.directories.get(key(path));
    if (existing) { const present = await this.checkDirectory(existing, true); if (present && !existing.lock) await this.load(existing); return existing; }
    const dir: Directory = { path, scratch: join(path, '.desklab-downloads'), jobs: new Map() };
    const present = await this.checkDirectory(dir, true);
    if (present) await this.load(dir);
    this.directories.set(key(path), dir);
    return dir;
  }

  private async checkDirectory(dir: Directory, allowMissing = false): Promise<boolean> {
    if (key(await realpath(dir.path)) !== key(dir.path)) throw new Error('ISO 目录已变更，请重新选择实际文件夹');
    try {
      const info = await lstat(dir.scratch);
      if (!info.isDirectory() || info.isSymbolicLink() || key(await realpath(dir.scratch)) !== key(dir.scratch)) throw new Error('下载临时目录不是普通文件夹，已停止写入');
      return true;
    } catch (error) { if (allowMissing && absent(error)) return false; throw error; }
  }

  private async fileInfo(path: string) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('下载文件路径被链接或其他文件占用，已停止写入');
      return info;
    } catch (error) { if (absent(error)) return undefined; throw error; }
  }

  private async load(dir: Directory) {
    dir.jobs.clear();
    for (const source of this.sources.values()) {
      const path = join(dir.scratch, `${source.id}.json`);
      if (!await this.fileInfo(path)) continue;
      let saved: SavedJob;
      try { saved = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
      if (saved.version !== 1 || saved.source !== sourceKey(source) || saved.progress?.id !== source.id || !['queued', 'downloading', 'verifying', 'paused', 'completed', 'error'].includes(saved.progress.status)) continue;
      const part = await this.fileInfo(join(dir.scratch, `${source.id}.part`));
      const progress: DownloadProgress = { ...saved.progress, file: source.file, directory: dir.path, total: source.bytes, received: Math.min(part?.size ?? (saved.progress.status === 'completed' ? source.bytes : 0), source.bytes), speed: 0, eta: undefined };
      if (['queued', 'downloading', 'verifying'].includes(progress.status)) progress.status = 'paused';
      if (progress.status === 'completed') {
        const final = await this.fileInfo(join(dir.path, source.file));
        if (!final) { progress.status = 'paused'; progress.received = part?.size ?? 0; }
        else if (final.size !== source.bytes) { progress.status = 'error'; progress.error = '已下载的 ISO 大小发生变化，请检查原文件或选择其他目录'; progress.verified = false; }
      }
      dir.jobs.set(source.id, { version: 1, source: saved.source, progress, etag: typeof saved.etag === 'string' ? saved.etag : undefined, restart: saved.restart === true, localSha256: typeof saved.localSha256 === 'string' && /^[a-f0-9]{64}$/i.test(saved.localSha256) ? saved.localSha256 : undefined });
    }
  }

  private async acquire(dir: Directory) {
    if (dir.lock) { await this.checkDirectory(dir); return; }
    if (!await this.checkDirectory(dir, true)) { try { await mkdir(dir.scratch); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    await this.checkDirectory(dir);
    const lock = join(dir.scratch, '.lock');
    try { await mkdir(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await lstat(lock);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('下载目录锁无效，请检查 .desklab-downloads 文件夹');
      const ownerPath = join(lock, 'owner.json');
      let owner: {pid?: number; token?: string};
      try { await this.fileInfo(ownerPath); owner = JSON.parse(await readFile(ownerPath, 'utf8')); } catch { throw new Error('另一个 DeskLab 正在使用这个下载目录，请稍后重试'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) throw new Error('下载目录锁无效，请稍后重试');
      try { process.kill(owner.pid!, 0); throw new Error('另一个 DeskLab 正在使用这个下载目录，请先暂停它的下载'); }
      catch (check) { if ((check as NodeJS.ErrnoException).code === 'EPERM') throw new Error('另一个 DeskLab 正在使用这个下载目录，请先暂停它的下载'); if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check; }
      // Keep a tiny tombstone for this owner. A delayed competing recovery cannot
      // rename a newly acquired lock over this non-empty, deterministic directory.
      const stale = join(dir.scratch, `.stale-${createHash('sha256').update(JSON.stringify(owner)).digest('hex')}`);
      try { await rename(lock, stale); } catch { throw new Error('下载目录正在被另一个 DeskLab 接管，请稍后重试'); }
      try { await mkdir(lock); } catch { throw new Error('另一个 DeskLab 正在使用这个下载目录，请稍后重试'); }
    }
    const token = randomUUID();
    try {
      const file = await open(join(lock, 'owner.json'), 'wx');
      try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync(); } finally { await file.close(); }
      dir.lock = token;
      await this.load(dir);
    } catch (error) {
      if (dir.lock) await this.releaseIdle(dir);
      else { await unlink(join(lock, 'owner.json')).catch(() => {}); await rmdir(lock).catch(() => {}); }
      throw error;
    }
  }

  private async releaseIdle(dir: Directory) {
    if (!dir.lock || [...dir.jobs.values()].some(active)) return;
    await this.checkDirectory(dir);
    const lock = join(dir.scratch, '.lock'), owner = join(lock, 'owner.json');
    if ((await lstat(lock)).isSymbolicLink()) throw new Error('下载目录锁已变更');
    await this.fileInfo(owner);
    if (JSON.parse(await readFile(owner, 'utf8')).token !== dir.lock) throw new Error('下载目录锁已变更');
    await unlink(owner); await rmdir(lock); dir.lock = undefined;
  }

  private async save(dir: Directory, job: Job) {
    await this.checkDirectory(dir);
    const path = join(dir.scratch, `${job.progress.id}.json`);
    await this.fileInfo(path);
    const temporary = join(dir.scratch, `${job.progress.id}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx');
    try { const saved: SavedJob = { version: 1, source: job.source, progress: copy(job), etag: job.etag, restart: job.restart, localSha256: job.localSha256 }; await handle.writeFile(JSON.stringify(saved)); await handle.sync(); }
    finally { await handle.close(); }
    await this.checkDirectory(dir); await this.fileInfo(path); await rename(temporary, path);
  }

  private pump() {
    if (this.closing) return;
    for (const dir of this.directories.values()) for (const job of dir.jobs.values()) {
      if (this.running >= 2) return;
      if (job.progress.status !== 'queued' || job.running) continue;
      this.running++; job.controller = new AbortController(); job.progress.status = 'downloading';
      job.running = this.run(dir, job).catch(error => { job.progress = { ...job.progress, status: 'error', speed: 0, eta: undefined, error: friendly(error) }; }).then(() => this.exclusive(async () => {
        this.running--; job.controller = undefined; job.running = undefined;
        try { await this.releaseIdle(dir); } catch (error) { job.progress.error = friendly(error); }
        this.pump();
      }));
    }
  }

  private async run(dir: Directory, job: Job) {
    const source = this.sources.get(job.progress.id)!, part = join(dir.scratch, `${source.id}.part`), signal = job.controller!.signal;
    let handle: FileHandle | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const timeout = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { timedOut = true; job.controller?.abort(); }, 30_000); };
    try {
      await this.checkDirectory(dir);
      const previous = await this.fileInfo(part);
      handle = await open(part, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
      const actual = await handle.stat();
      if (!actual.isFile() || actual.nlink !== 1 || (previous && (actual.ino !== previous.ino || actual.dev !== previous.dev))) throw new Error('下载临时文件已变更，已停止写入');
      let offset = actual.size;
      if (job.restart || !job.etag || offset > source.bytes) { await handle.truncate(0); offset = 0; job.etag = undefined; }
      job.restart = false; job.progress.received = offset;
      const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
      if (offset > 0) { headers.Range = `bytes=${offset}-`; headers['If-Range'] = job.etag!; }
      if (offset < source.bytes) {
        timeout();
        const response = await fetch(source.url, { headers, signal, redirect: 'follow' });
        const etag = response.headers.get('etag');
        if (response.status !== 200 && response.status !== 206) { await response.body?.cancel(); throw new Error(`下载服务器返回 HTTP ${response.status}，请稍后重试`); }
        if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') { await response.body?.cancel(); job.restart = true; throw new Error('服务器返回了压缩内容，无法验证镜像大小'); }
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
          if (!range || Number(range[1]) !== offset || Number(range[2]) !== source.bytes - 1 || Number(range[3]) !== source.bytes || (offset > 0 && (!etag || etag !== job.etag))) { await response.body?.cancel(); job.restart = true; throw new Error('服务器的续传信息与镜像不一致，请重试以重新下载'); }
        } else if (offset) { await handle.truncate(0); offset = 0; job.progress.received = 0; }
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) !== source.bytes - offset)) { await response.body?.cancel(); job.restart = true; throw new Error('服务器返回的镜像大小与预期不一致，请稍后重试'); }
        job.etag = etag && !etag.startsWith('W/') ? etag : undefined;
        await this.save(dir, job);
        if (!response.body) throw new Error('下载服务器未返回镜像内容');
        let sampleAt = Date.now(), sampleBytes = offset, savedAt = sampleAt;
        for await (const chunk of response.body) {
          signal.throwIfAborted(); timeout();
          if (job.progress.received + chunk.length > source.bytes) { job.restart = true; throw new Error('收到的镜像超出预期大小，已停止下载'); }
          let consumed = 0;
          while (consumed < chunk.length) { const result = await handle.write(chunk, consumed, chunk.length - consumed, job.progress.received + consumed); if (!result.bytesWritten) throw new Error('磁盘无法继续写入'); consumed += result.bytesWritten; }
          job.progress.received += chunk.length;
          const now = Date.now(), elapsed = (now - sampleAt) / 1000;
          if (elapsed >= 0.25) { job.progress.speed = Math.round((job.progress.received - sampleBytes) / elapsed); job.progress.eta = job.progress.speed ? Math.ceil((source.bytes - job.progress.received) / job.progress.speed) : undefined; sampleAt = now; sampleBytes = job.progress.received; }
          if (now - savedAt >= 1000) { await this.save(dir, job); savedAt = now; }
        }
        clearTimeout(idleTimer);
      }
      signal.throwIfAborted();
      if (job.progress.received !== source.bytes) throw new Error('下载中断，镜像尚未下载完整；点击继续下载即可重试');
      job.progress.status = 'verifying'; job.progress.speed = 0; job.progress.eta = undefined;
      await handle.sync(); await this.save(dir, job);
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
      for (let position = 0; position < source.bytes;) { signal.throwIfAborted(); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, source.bytes - position), position); if (!bytesRead) throw new Error('校验时发现镜像不完整，请重新下载'); hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; }
      job.localSha256 = hash.digest('hex');
      if (source.sha256 && job.localSha256 !== source.sha256.toLowerCase()) { job.restart = true; throw new Error('镜像完整性校验失败；点击重试将重新下载'); }
      job.progress.verified = Boolean(source.sha256);
      await handle.close(); handle = undefined; signal.throwIfAborted();
      await this.checkDirectory(dir);
      const validated = await this.fileInfo(part);
      if (!validated || validated.ino !== actual.ino || validated.dev !== actual.dev || validated.size !== source.bytes) throw new Error('下载临时文件已变更，请重新下载');
      // A hard link publishes a complete file atomically and refuses to replace existing user files.
      try { await link(part, join(dir.path, source.file)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目录中出现了同名 ISO，已保留原文件；请选择其他目录'); throw error; }
      await unlink(part);
      job.progress.status = 'completed';
    } catch (error) {
      if (signal.aborted && !timedOut) { job.progress.status = 'paused'; job.progress.error = undefined; }
      else { job.progress.status = 'error'; job.progress.error = timedOut ? '下载连接超时，请检查网络后继续下载' : friendly(error); }
      job.progress.speed = 0; job.progress.eta = undefined;
    } finally {
      clearTimeout(idleTimer); await handle?.close();
      await this.save(dir, job);
    }
  }
}

function friendly(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC') return 'ISO 目录所在磁盘空间不足，请释放空间后继续下载';
  if (code === 'EACCES' || code === 'EPERM') return '无法写入 ISO 目录，请选择有写入权限的文件夹';
  if (code === 'EIO') return '磁盘写入失败，请检查磁盘连接后重试';
  if (code === 'ENOTSUP' || code === 'EXDEV') return '此目录不支持安全保存下载文件，请选择本机 NTFS 磁盘目录';
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network|socket|ECONN|ENOTFOUND|connection|certificate|tls/i.test(`${code} ${message}`)) return '下载连接中断，请检查网络后继续下载';
  return message;
}
