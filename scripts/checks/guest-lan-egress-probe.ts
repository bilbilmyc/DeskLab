import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../../server/store';
import { Shares } from '../../server/shares';
import { executable, run, freePort, qmp } from '../../server/qemu';
import type { Machine } from '../../shared/types';

// Guest egress to the real LAN: boots the Debian template and, from inside the
// guest, reaches the fnOS NAS (192.168.5.60:5666 web UI), the default gateway,
// and the NAS SMB port over the physical LAN. Proves NAT egress through the
// host's real adapter. Inbound (NAS -> host 0.0.0.0 mapping) is a separate
// direction; the host firewall already allows the dev QEMU binary inbound.
const target = '192.168.5.60';
const templateBase = resolve('.data/templates/3628f107-3bed-4f1c-8fd8-e5c9ed182e08/base.qcow2');
const root = resolve('.runtime/checks', `guest-lan-${Date.now()}`);
await mkdir(join(root, 'data'), {recursive:true});
await mkdir(join(root, 'shared'), {recursive:true});
const store = new Store(join(root, 'data')); await store.init();
const vm: Machine = {id: crypto.randomUUID(), name: 'lan egress probe', family: 'debian', firmware: 'bios', memory: 2048, cpus: 2, diskGB: 40,
  state: 'stopped', backingResolved: true, createdAt: new Date().toISOString(),
  shares: [{id: crypto.randomUUID(), name: 'probe', hostPath: join(root, 'shared'), readOnly: false, createdAt: new Date().toISOString()}]};
store.data.machines.push(vm); await store.save();
let running = false;
const shares = new Shares(store, () => running);
const channel = shares.ensure(vm)!;
const base = `http://10.0.2.2:${channel.port}/share/${channel.token}/probe`;
await Bun.write(join(root, 'shared', 'bootstrap.sh'), [
  '#!/bin/sh',
  '{',
  '  GW=$(ip route | awk \'/default/ {print $3}\')',
  '  echo "GATEWAY=$GW"',
  "  echo \"PING_GW=$(ping -c 1 -W 3 \"$GW\" >/dev/null 2>&1 && echo OK || echo FAIL)\"",
  `  echo "PING_NAS=$(ping -c 2 -W 3 ${target} 2>/dev/null | tail -2 | head -1)"`,
  `  code=$(curl -s -o /tmp/nas.html -w '%{http_code}' -m 10 http://${target}:5666/ 2>/dev/null)`,
  '  echo "NAS_HTTP=$code"',
  '  echo "NAS_TITLE=$(grep -o -m1 "<title>[^<]*" /tmp/nas.html 2>/dev/null | head -1)"',
  `  echo "NAS_SMB445=$(timeout 3 bash -c 'echo > /dev/tcp/${target}/445' 2>/dev/null && echo OPEN || echo CLOSED)"`,
  '} > /tmp/lan-probe.txt 2>&1',
  `curl -s -m 10 -X PUT --data-binary @/tmp/lan-probe.txt ${base}/from-guest.txt`,
  '', ''].join('\n'));
const qemu = await executable(''), imgTool = await executable('', true);
if (!qemu || !imgTool) throw new Error('未找到 QEMU 或 qemu-img');
const disk = join(root, 'disk.qcow2');
await run(imgTool, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', templateBase, disk, '40G']);
const vncPort = await freePort(), qmpPort = await freePort(), serialPort = await freePort();
let child: ChildProcess | undefined;
const args = ['-name', 'DeskLab-lan-probe', '-machine', 'pc', '-accel', process.env.QEMU_TEST_ACCEL ?? 'whpx', '-cpu', 'max', '-m', '2048', '-smp', '2',
  '-drive', `file=${disk.replaceAll(',', ',,')},format=qcow2,if=ide`, '-nic', 'user,model=e1000',
  '-vga', 'std', '-display', 'none', '-vnc', `127.0.0.1:${vncPort - 5900}`, '-qmp', `tcp:127.0.0.1:${qmpPort},server=on,wait=off`,
  '-serial', `tcp:127.0.0.1:${serialPort},server=on,wait=off`, '-pidfile', join(root, 'qemu.pid'),
  '-usb', '-device', 'usb-tablet', '-boot', 'order=c,menu=on'];
let serialLog = '';
const plainQcodes = new Map([[' ', 'spc'], ['-', 'minus'], ['.', 'dot'], ['/', 'slash'], [';', 'semicolon']]);
const shiftedQcodes = new Map([[':', 'semicolon']]);
async function press(keys: {type:'qcode';data:string}[], hold = 60) { await qmp(qmpPort, 'send-key', {keys, 'hold-time': hold}); }
async function typeLine(line: string) {
  for (const character of line) {
    const keys = shiftedQcodes.has(character) ? [{type:'qcode' as const,data:'shift'},{type:'qcode' as const,data:shiftedQcodes.get(character)!}]
      : plainQcodes.has(character) ? [{type:'qcode' as const,data:plainQcodes.get(character)!}]
      : /[a-z0-9]/.test(character) ? [{type:'qcode' as const,data:character}]
      : null;
    if (!keys) throw new Error(`无法输入字符 ${character}`);
    await press(keys, 30);
    await Bun.sleep(40);
  }
  await press([{type:'qcode',data:'ret'}]);
  await Bun.sleep(400);
}
try {
  child = spawn(qemu, args, {cwd: dirname(qemu), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  running = true;
  child.stderr?.on('data', data => {serialLog += data.toString();});
  child.on('error', error => {serialLog += `QEMU spawn failed: ${error.message}\n`;});
  child.on('close', code => {serialLog += `QEMU exited with code ${code}\n`;});
  const serial = createConnection({host: '127.0.0.1', port: serialPort});
  serial.on('data', data => {serialLog += data.toString();});
  serial.on('error', () => {});
  for (let n = 0; n < 60; n++) { try { await qmp(qmpPort, 'query-status'); break; } catch { await Bun.sleep(1000); } }
  const bootWait = Number(process.env.GUEST_PROBE_BOOT_WAIT ?? 150000);
  console.log(`QEMU is up; waiting ${bootWait / 1000}s for the Debian autologin shell…`);
  await Bun.sleep(bootWait);
  await typeLine(`curl -s -m 5 -o /tmp/p.sh ${base}/bootstrap.sh; sh /tmp/p.sh`);
  let result = '';
  for (let n = 0; n < 60 && !result; n++) { await Bun.sleep(3000); result = await Bun.file(join(root, 'shared', 'from-guest.txt')).text().catch(() => ''); }
  assert.ok(result, '客体探测结果未通过共享通道回传');
  console.log('--- guest lan egress result ---');
  console.log(result.trim());
  const http = result.match(/NAS_HTTP=(\d{3})/)?.[1];
  assert.ok(http && http !== '000', '客体未能通过 HTTP 访问局域网 NAS');
  console.log(`PASS: guest reached the real LAN (NAS HTTP ${http}) through the host's physical adapter.`);
} finally {
  running = false; shares.shutdown();
  await qmp(qmpPort, 'quit').catch(() => child?.kill());
  await Bun.sleep(1500);
  child?.kill();
  await Bun.write(join(root, 'serial.log'), serialLog);
  console.log('Test data:', root);
}
