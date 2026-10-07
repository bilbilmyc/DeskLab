import { lstat, opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Machine, MachineShare, ShareChannel } from '../shared/types';
import type { Store } from './store';

// Windows reserves these device stems even with an extension (CON.txt is not creatable).
const reservedNames = new Set(['CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({length: 9}, (_, index) => `COM${index + 1}`), ...Array.from({length: 9}, (_, index) => `LPT${index + 1}`)]);
const collator = new Intl.Collator('zh-CN', {numeric: true, sensitivity: 'base'});
const maxListing = 500;
export const maxUploadBytes = 4 * 1024 * 1024 * 1024;

/** Resolve one decoded URL-relative path inside a share root, or undefined when any
 * segment could escape the root or is unsafe to touch on a Windows host. */
export function resolveShareTarget(root: string, relative: string): string | undefined {
  const parts = relative ? relative.split('/') : [];
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('\\') || /[\x00-\x1f]/.test(part)) return undefined;
    if (part.length > 255 || /[. ]$/.test(part) || reservedNames.has(part.split('.')[0].toUpperCase())) return undefined;
  }
  return join(root, ...parts);
}

/** A loopback, token-scoped guest endpoint for configured host directories. Like the
 *  install channel it never exposes the app API and only answers while the VM runs. */
export class Shares {
  private servers = new Map<string, ReturnType<typeof Bun.serve>>();
  constructor(private store: Store, private running: (id: string) => boolean) {}
  guestUrl(channel: ShareChannel, name: string) { return `http://10.0.2.2:${channel.port}/share/${channel.token}/${name}`; }
  private json(payload: unknown, status = 200) {
    return new Response(JSON.stringify(payload), {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8'}});
  }
  private handler(vm: Machine, channel: ShareChannel) {
    return async (request: Request): Promise<Response> => {
      const url = new URL(request.url), host = request.headers.get('host');
      if (request.headers.has('origin') || (host !== `10.0.2.2:${channel.port}` && host !== `127.0.0.1:${channel.port}`)) return new Response('Not found', {status: 404});
      const prefix = `/share/${channel.token}`;
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return new Response('Not found', {status: 404});
      const current = this.store.data.machines.find(item => item.id === vm.id);
      if (!current || current.shareChannel?.token !== channel.token || !this.running(current.id)) return new Response('Not found', {status: 404});
      let remainder = url.pathname === prefix ? '' : url.pathname.slice(prefix.length + 1);
      try { remainder = decodeURIComponent(remainder); } catch { return new Response('Not found', {status: 404}); }
      if (!remainder) return this.json({shares: (current.shares ?? []).map(share => ({name: share.name, readOnly: share.readOnly}))});
      const [requested, ...rest] = remainder.split('/');
      const share = (current.shares ?? []).find(item => item.name === requested);
      if (!share) return new Response('Not found', {status: 404});
      const relative = rest.join('/');
      if (request.method === 'PUT') return await this.write(share, relative, request);
      if (request.method !== 'GET') return new Response('Method not allowed', {status: 405});
      return await this.read(share, relative);
    };
  }
  private async read(share: MachineShare, relative: string): Promise<Response> {
    const target = resolveShareTarget(share.hostPath, relative);
    if (!target) return new Response('Not found', {status: 404});
    let info;
    try { info = await stat(target); } catch { return new Response('Not found', {status: 404}); }
    if (!info.isDirectory()) {
      if (!info.isFile()) return new Response('Not found', {status: 404});
      return new Response(Bun.file(target), {headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/octet-stream'}});
    }
    const entries: {name: string; directory: boolean; size?: number}[] = [];
    let truncated = false;
    try {
      const handle = await opendir(target);
      for await (const entry of handle) {
        if (entries.length === maxListing) { truncated = true; break; }
        try { const resolved = await stat(join(target, entry.name)); if (resolved.isDirectory()) entries.push({name: entry.name, directory: true}); else if (resolved.isFile()) entries.push({name: entry.name, directory: false, size: resolved.size}); }
        catch { continue; } // Unreadable or dangling entries are skipped, not fatal.
      }
    } catch { return new Response('无法读取这个文件夹', {status: 403}); }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || collator.compare(a.name, b.name));
    return this.json({path: relative, entries, truncated});
  }
  private async write(share: MachineShare, relative: string, request: Request): Promise<Response> {
    if (share.readOnly) return new Response('此共享为只读，不能上传', {status: 403});
    if (!relative || relative.includes('/') || !resolveShareTarget(share.hostPath, relative)) return new Response('上传仅支持共享文件夹根目录下的普通文件名', {status: 400});
    const target = join(share.hostPath, relative);
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) return new Response('目标已存在且不是普通文件，已拒绝覆盖', {status: 409});
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return new Response('无法在此共享中写入文件', {status: 403}); }
    if (!request.body) return new Response('缺少文件内容', {status: 400});
    try { await Bun.write(target, request.body); } catch { return new Response('写入失败，请检查磁盘空间和文件夹权限', {status: 403}); }
    return this.json({written: relative});
  }
  /** Start (or reuse) the per-machine channel. Mutates the machine record; the caller saves. */
  ensure(vm: Machine): ShareChannel | undefined {
    if (!vm.shares?.length || this.servers.has(vm.id)) return vm.shareChannel;
    const channel: ShareChannel = vm.shareChannel ?? {port: 0, token: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')};
    const create = () => Bun.serve({hostname: '127.0.0.1', port: channel.port, maxRequestBodySize: maxUploadBytes, fetch: this.handler(vm, channel)});
    let server;
    try { server = create(); }
    catch {
      // A persisted port may be taken after reboot or by another program; fall back
      // to an ephemeral one instead of blocking the whole machine from starting.
      channel.port = 0;
      server = create();
    }
    channel.port = server.port!;
    vm.shareChannel = channel;
    this.servers.set(vm.id, server);
    return channel;
  }
  stop(id: string) { this.servers.get(id)?.stop(true); this.servers.delete(id); }
  shutdown() { for (const id of this.servers.keys()) this.stop(id); }
}
