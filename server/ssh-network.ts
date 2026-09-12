import {createServer} from 'node:net';
import {freePort, qmp} from './qemu';

export async function sshPortAvailable(port: number) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
  return new Promise<boolean>(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function allocateSshPort(preferred?: number, reserved: number[] = []) {
  const candidates = [...new Set([preferred, ...Array.from({length: 100}, (_, i) => 2222 + i)])];
  for (const port of candidates) {
    if (port !== undefined && !reserved.includes(port) && await sshPortAvailable(port)) return port;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await freePort();
    if (!reserved.includes(port)) return port;
  }
  throw new Error('无法分配本机 SSH 端口，请稍后重试。');
}

export function forwardedSshPort(info: unknown): number | undefined {
  if (typeof info !== 'string') throw new Error('无法读取虚拟机网络转发信息。');
  for (const line of info.split('\n')) {
    const match = line.match(/^\s*TCP\[HOST_FORWARD\]\s+[0-9a-fA-F]+\s+127\.0\.0\.1\s+(\d+)\s+\S+\s+22\s/);
    if (match) return Number(match[1]);
  }
}

// QEMU's user network is private NAT. Host SSH requires an explicit loopback
// forwarding rule; adding one through QMP also supports already running guests.
export async function ensureSshForward(qmpPort: number, preferred?: number, reserved: number[] = []) {
  const monitor = (command: string) => qmp(qmpPort, 'human-monitor-command', {'command-line': command});
  const existing = forwardedSshPort(await monitor('info usernet'));
  if (existing) return existing;
  const port = await allocateSshPort(preferred, reserved);
  const result = await monitor(`hostfwd_add tcp:127.0.0.1:${port}-:22`);
  if (typeof result !== 'string' || result.trim()) throw new Error(`无法开启本机 SSH 转发：${String(result)}`);
  if (forwardedSshPort(await monitor('info usernet')) !== port) throw new Error('SSH 本机端口转发未生效。');
  return port;
}
