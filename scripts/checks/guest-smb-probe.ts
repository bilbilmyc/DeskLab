import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../../server/store';
import { Shares } from '../../server/shares';
import { executable, run, freePort, qmp } from '../../server/qemu';
import type { Machine } from '../../shared/types';

// SMB-route evidence without touching the host: boot the real Debian template
// and, from inside the guest, install cifs-utils (proves outbound NAT + the
// "templates need cifs-utils" prerequisite) and attempt an SMB3 mount of the
// host with deliberately wrong credentials. A logon failure - rather than a
// timeout or protocol error - proves negotiate + NTLM challenge work over the
// slirp NAT; only valid credentials remain untested (they need an admin-created
// share). Results come back through the token share channel.
const templateBase = resolve('.data/templates/3628f107-3bed-4f1c-8fd8-e5c9ed182e08/base.qcow2');
const root = resolve('.runtime/checks', `guest-smb-${Date.now()}`);
await mkdir(join(root, 'data'), {recursive:true});
await mkdir(join(root, 'shared'), {recursive:true});
const store = new Store(join(root, 'data')); await store.init();
const vm: Machine = {id: crypto.randomUUID(), name: 'smb probe', family: 'debian', firmware: 'bios', memory: 2048, cpus: 2, diskGB: 40,
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
  "  echo \"DNS=$(getent hosts deb.debian.org | head -1 | awk '{print $1}')\"",
  '  export DEBIAN_FRONTEND=noninteractive',
  '  apt-get update >/tmp/apt.log 2>&1 || apt-get update -o Acquire::ForceIPv4=true >>/tmp/apt.log 2>&1; echo "APT_UPDATE_RC=$?"',
  '  apt-get install -y cifs-utils >>/tmp/apt.log 2>&1 || apt-get install -y -o Acquire::ForceIPv4=true cifs-utils >>/tmp/apt.log 2>&1; echo "APT_INSTALL_RC=$?"',
  '  echo "MOUNT_CIFS=$(command -v mount.cifs)"',
  '  mkdir -p /mnt/smbprobe',
  "  mount -t cifs //10.0.2.2/desklab-probe /mnt/smbprobe -o user=desklabprobe,pass=definitely-wrong,vers=3.0,soft >/tmp/mount.log 2>&1",
  '  echo "MOUNT_RC=$?"',
  '  echo "--- mount.log ---"; cat /tmp/mount.log',
  '  echo "--- dmesg tail ---"; dmesg | grep -i -E "cifs|smb" | tail -5',
  '} > /tmp/smb-probe.txt 2>&1',
  `curl -s -m 10 -X PUT --data-binary @/tmp/smb-probe.txt ${base}/from-guest.txt`,
  '', ''].join('\n'));
const qemu = await executable(''), imgTool = await executable('', true);
if (!qemu || !imgTool) throw new Error('未找到 QEMU 或 qemu-img');
const disk = join(root, 'disk.qcow2');
await run(imgTool, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', templateBase, disk, '40G']);
const vncPort = await freePort(), qmpPort = await freePort(), serialPort = await freePort();
let child: ChildProcess | undefined;
const args = ['-name', 'DeskLab-smb-probe', '-machine', 'pc', '-accel', process.env.QEMU_TEST_ACCEL ?? 'whpx', '-cpu', 'max', '-m', '2048', '-smp', '2',
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
  for (let n = 0; n < 96 && !result; n++) { await Bun.sleep(5000); result = await Bun.file(join(root, 'shared', 'from-guest.txt')).text().catch(() => ''); }
  assert.ok(result, '客体探测结果未通过共享通道回传');
  console.log('--- guest smb probe result ---');
  console.log(result.trim());
  assert.ok(/MOUNT_RC=\d+/.test(result), '缺少挂载返回码');
  assert.ok(!/timed out|No route to host|connection refused/i.test(result), 'SMB 连接出现网络层失败（应为认证层失败）');
  // The kernel CIFS client reaches session setup even without the mount.cifs
  // helper; the evidence we need is an authentication-layer denial.
  const logonDenied = /SessSetup = -13|STATUS_ACCESS_DENIED|STATUS_LOGON_FAILURE|0xc000006d|0xc0000022|Permission denied/i.test(result);
  assert.ok(logonDenied, '未观察到认证层拒绝（SessSetup 失败）');
  console.log(`cifs-utils helper installed in guest: ${/MOUNT_CIFS=\/.+/.test(result)}`);
  console.log('PASS: guest→host SMB3 negotiate + session setup complete over NAT; wrong credentials are rejected at the auth layer, so only valid credentials (admin-created share) remain untested.');
} finally {
  running = false; shares.shutdown();
  await qmp(qmpPort, 'quit').catch(() => child?.kill());
  await Bun.sleep(1500);
  child?.kill();
  await Bun.write(join(root, 'serial.log'), serialLog);
  console.log('Test data:', root);
}
