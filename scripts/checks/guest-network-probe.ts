import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../../server/store';
import { Shares } from '../../server/shares';
import { executable, run, freePort, qmp } from '../../server/qemu';
import type { Machine } from '../../shared/types';

// Boots the real Debian server template (read-only backing chain). The probe
// script lives in the host share; we type one bootstrap line onto the guest's
// autologin tty1 console via QMP send-key (the mechanism lab.ts already uses).
// From inside the guest, over the real slirp NAT, we then verify the token
// share channel (list/download/upload) and TCP reachability of host SMB 445.
// Results come back through the channel itself, so the check is self-verifying.
const templateBase = resolve('.data/templates/3628f107-3bed-4f1c-8fd8-e5c9ed182e08/base.qcow2');
const root = resolve('.runtime/checks', `guest-probe-${Date.now()}`);
await mkdir(join(root, 'data'), {recursive:true});
await mkdir(join(root, 'shared'), {recursive:true});
const store = new Store(join(root, 'data')); await store.init();
const vm: Machine = {id: crypto.randomUUID(), name: 'guest probe', family: 'debian', firmware: 'bios', memory: 2048, cpus: 2, diskGB: 40,
  state: 'stopped', backingResolved: true, createdAt: new Date().toISOString(),
  shares: [{id: crypto.randomUUID(), name: 'probe', hostPath: join(root, 'shared'), readOnly: false, createdAt: new Date().toISOString()}]};
store.data.machines.push(vm); await store.save();
let running = false;
const shares = new Shares(store, () => running);
const channel = shares.ensure(vm)!;
const base = `http://10.0.2.2:${channel.port}/share/${channel.token}/probe`;
await Bun.write(join(root, 'shared', 'guest-reads-this.txt'), 'channel proof from host');
await Bun.write(join(root, 'shared', 'bootstrap.sh'), [
  '#!/bin/sh',
  `{ echo "SMB445=$(timeout 3 bash -c 'echo > /dev/tcp/10.0.2.2/445' 2>/dev/null && echo OPEN || echo CLOSED)"`,
  `  echo "LISTING=$(curl -s -m 5 ${base}/)"`,
  `  echo "DOWNLOAD=$(curl -s -m 5 ${base}/guest-reads-this.txt)"`,
  '} > /tmp/desklab-probe.txt',
  `curl -s -m 10 -X PUT --data-binary @/tmp/desklab-probe.txt ${base}/from-guest.txt`,
  '', ''].join('\n'));
const qemu = await executable(''), imgTool = await executable('', true);
if (!qemu || !imgTool) throw new Error('未找到 QEMU 或 qemu-img');
const disk = join(root, 'disk.qcow2');
await run(imgTool, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', templateBase, disk, '40G']);
const vncPort = await freePort(), qmpPort = await freePort(), serialPort = await freePort();
let child: ChildProcess | undefined;
const args = ['-name', 'DeskLab-guest-probe', '-machine', 'pc', '-accel', process.env.QEMU_TEST_ACCEL ?? 'whpx', '-cpu', 'max', '-m', '2048', '-smp', '2',
  '-drive', `file=${disk.replaceAll(',', ',,')},format=qcow2,if=ide`, '-nic', 'user,model=e1000',
  '-vga', 'std', '-display', 'none', '-vnc', `127.0.0.1:${vncPort - 5900}`, '-qmp', `tcp:127.0.0.1:${qmpPort},server=on,wait=off`,
  '-serial', `tcp:127.0.0.1:${serialPort},server=on,wait=off`, '-pidfile', join(root, 'qemu.pid'),
  '-usb', '-device', 'usb-tablet', '-boot', 'order=c,menu=on'];
let serialLog = '';

// QMP send-key qcodes for the symbols the bootstrap line needs.
const plainQcodes = new Map([[' ', 'spc'], ['-', 'minus'], ['.', 'dot'], ['/', 'slash'], [';', 'semicolon']]);
const shiftedQcodes = new Map([[':', 'semicolon']]);
async function typeLine(line: string) {
  for (const character of line) {
    const keys = shiftedQcodes.has(character) ? [{type:'qcode',data:'shift'},{type:'qcode',data:shiftedQcodes.get(character)!}]
      : plainQcodes.has(character) ? [{type:'qcode',data:plainQcodes.get(character)!}]
      : /[a-z0-9]/.test(character) ? [{type:'qcode',data:character}]
      : null;
    if (!keys) throw new Error(`无法输入字符 ${character}`);
    await qmp(qmpPort, 'send-key', {keys, 'hold-time': 30});
    await Bun.sleep(40);
  }
  await qmp(qmpPort, 'send-key', {keys: [{type:'qcode',data:'ret'}], 'hold-time': 30});
  await Bun.sleep(300);
}

try {
  const hostSmb = await new Promise<boolean>(resolveCheck => {
    const probe = createConnection({host: '127.0.0.1', port: 445});
    probe.once('connect', () => {probe.destroy(); resolveCheck(true);});
    probe.once('error', () => resolveCheck(false));
  });
  console.log('Host 127.0.0.1:445 listening:', hostSmb);
  child = spawn(qemu, args, {cwd: dirname(qemu), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  running = true;
  child.stderr?.on('data', data => {serialLog += data.toString();});
  child.on('error', error => {serialLog += `QEMU spawn failed: ${error.message}\n`;});
  child.on('close', code => {serialLog += `QEMU exited with code ${code}\n`;});
  // Passive serial log: GRUB and any serial-getty output end up as evidence.
  const serial = createConnection({host: '127.0.0.1', port: serialPort});
  serial.on('data', data => {serialLog += data.toString();});
  serial.on('error', () => {});
  for (let n = 0; n < 60; n++) { try { await qmp(qmpPort, 'query-status'); break; } catch { await Bun.sleep(1000); } }
  console.log('QEMU is up; waiting for the Debian tty1 autologin shell to settle…');
  await Bun.sleep(Number(process.env.GUEST_PROBE_BOOT_WAIT ?? 150000));
  await typeLine(`curl -s -m 5 -o /tmp/p.sh ${base}/bootstrap.sh; bash /tmp/p.sh`);
  let result = '';
  for (let n = 0; n < 60 && !result; n++) { await Bun.sleep(2000); result = await Bun.file(join(root, 'shared', 'from-guest.txt')).text().catch(() => ''); }
  assert.ok(result, '客体探测结果未通过共享通道回传');
  console.log('--- guest probe result ---');
  console.log(result.trim());
  assert.ok(result.includes('guest-reads-this.txt'), '客体未能通过通道浏览共享目录');
  assert.ok(result.includes('DOWNLOAD=channel proof from host'), '客体未能通过通道下载文件');
  const smb = result.match(/SMB445=(OPEN|CLOSED)/)?.[1];
  console.log(`Guest can reach 10.0.2.2:445 (host SMB): ${smb ?? 'unknown'}`);
  console.log('PASS: a real guest fetched, ran and reported through the token share channel.');
} finally {
  running = false; shares.shutdown();
  await qmp(qmpPort, 'quit').catch(() => child?.kill());
  await Bun.sleep(1500);
  child?.kill();
  await Bun.write(join(root, 'serial.log'), serialLog);
  console.log('Test data:', root);
}
