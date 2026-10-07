import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../../server/store';
import { Shares } from '../../server/shares';
import { executable, run, freePort, qmp } from '../../server/qemu';
import { uefiDrives } from '../../server/firmware';
import type { Machine } from '../../shared/types';

// Windows twin of guest-network-probe.ts: boots the real Windows 10 template
// (read-only backing chain, UEFI like production), opens a command prompt via
// Win+R on the autologin desktop, and has the guest pull a PowerShell probe
// from the host share channel. Verifies curl.exe reachability, listing,
// download and upload over the real slirp NAT, plus host SMB 445.
const templateBase = resolve('.data/templates/ce1c86d8-0a40-4023-8e60-726b1c8ad5cd/base.qcow2');
const root = resolve('.runtime/checks', `guest-probe-win-${Date.now()}`);
await mkdir(join(root, 'data'), {recursive:true});
await mkdir(join(root, 'shared'), {recursive:true});
const store = new Store(join(root, 'data')); await store.init();
const vm: Machine = {id: crypto.randomUUID(), name: 'windows probe', family: 'windows', firmware: 'uefi', memory: 4096, cpus: 2, diskGB: 64,
  state: 'stopped', backingResolved: true, createdAt: new Date().toISOString(),
  shares: [{id: crypto.randomUUID(), name: 'probe', hostPath: join(root, 'shared'), readOnly: false, createdAt: new Date().toISOString()}]};
store.data.machines.push(vm); await store.save();
let running = false;
const shares = new Shares(store, () => running);
const channel = shares.ensure(vm)!;
const base = `http://10.0.2.2:${channel.port}/share/${channel.token}/probe`;
await Bun.write(join(root, 'shared', 'guest-reads-this.txt'), 'channel proof from host');
await Bun.write(join(root, 'shared', 'bootstrap.ps1'), [
  "$base = 'REPLACE_BASE'",
  "$smb = 'CLOSED'",
  "try { $client = New-Object Net.Sockets.TcpClient; $client.Connect('10.0.2.2', 445); $smb = 'OPEN'; $client.Close() } catch {}",
  '$listing = & curl.exe -s -m 5 "$base/"',
  '$download = & curl.exe -s -m 5 "$base/guest-reads-this.txt"',
  '$report = "SMB445=$smb LISTING=$listing DOWNLOAD=$download"',
  'Set-Content -Path from-guest.txt -Value $report -Encoding ascii',
  '& curl.exe -s -m 10 -T from-guest.txt "$base/from-guest.txt"',
  '', ''].join('\n').replaceAll('REPLACE_BASE', base));
const qemu = await executable(''), imgTool = await executable('', true);
if (!qemu || !imgTool) throw new Error('未找到 QEMU 或 qemu-img');
const disk = join(root, 'disk.qcow2');
await run(imgTool, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', templateBase, disk, '64G']);
const vncPort = await freePort(), qmpPort = await freePort(), serialPort = await freePort();
let child: ChildProcess | undefined;
const args = ['-name', 'DeskLab-win-probe', '-machine', 'q35,pic=off', '-accel', process.env.QEMU_TEST_ACCEL ?? 'whpx', '-cpu', 'Westmere', '-m', '4096', '-smp', '2',
  '-drive', `file=${disk.replaceAll(',', ',,')},format=qcow2,if=ide`, '-nic', 'user,model=e1000',
  '-vga', 'std', '-display', 'none', '-vnc', `127.0.0.1:${vncPort - 5900}`, '-qmp', `tcp:127.0.0.1:${qmpPort},server=on,wait=off`,
  '-serial', `tcp:127.0.0.1:${serialPort},server=on,wait=off`, '-pidfile', join(root, 'qemu.pid'),
  '-usb', '-device', 'usb-tablet', '-rtc', 'base=localtime', '-boot', 'order=c,menu=on'];
let serialLog = '';

const plainQcodes = new Map([[' ', 'spc'], ['-', 'minus'], ['.', 'dot'], ['/', 'slash'], [';', 'semicolon']]);
const shiftedQcodes = new Map([[':', 'semicolon']]);
async function press(keys: {type:'qcode';data:string}[], hold = 60) { await qmp(qmpPort, 'send-key', {keys, 'hold-time': hold}); }
async function typeLine(line: string) {
  for (const character of line) {
    const keys = shiftedQcodes.has(character) ? [{type:'qcode' as const,data:'shift'},{type:'qcode' as const,data:shiftedQcodes.get(character)!}]
      : plainQcodes.has(character) ? [{type:'qcode' as const,data:plainQcodes.get(character)!}]
      : /[a-z0-9]/i.test(character) ? [{type:'qcode' as const,data:character.toLowerCase()}]
      : null;
    if (!keys) throw new Error(`无法输入字符 ${character}`);
    await press(keys, 30);
    await Bun.sleep(40);
  }
  await press([{type:'qcode',data:'ret'}]);
  await Bun.sleep(400);
}
async function windowsRunCombo() {
  try { await press([{type:'qcode',data:'meta_l'},{type:'qcode',data:'r'}], 120); }
  catch { await press([{type:'qcode',data:'meta'},{type:'qcode',data:'r'}], 120); }
}

try {
  const hostSmb = await new Promise<boolean>(resolveCheck => {
    const probe = createConnection({host: '127.0.0.1', port: 445});
    probe.once('connect', () => {probe.destroy(); resolveCheck(true);});
    probe.once('error', () => resolveCheck(false));
  });
  console.log('Host 127.0.0.1:445 listening:', hostSmb);
  child = spawn(qemu, [...args, ...await uefiDrives(qemu, join(root, 'uefi-vars.fd'))], {cwd: dirname(qemu), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  running = true;
  child.stderr?.on('data', data => {serialLog += data.toString();});
  child.on('error', error => {serialLog += `QEMU spawn failed: ${error.message}\n`;});
  child.on('close', code => {serialLog += `QEMU exited with code ${code}\n`;});
  const serial = createConnection({host: '127.0.0.1', port: serialPort});
  serial.on('data', data => {serialLog += data.toString();});
  serial.on('error', () => {});
  for (let n = 0; n < 60; n++) { try { await qmp(qmpPort, 'query-status'); break; } catch { await Bun.sleep(1000); } }
  const bootWait = Number(process.env.GUEST_PROBE_BOOT_WAIT ?? 300000);
  console.log(`QEMU is up; waiting ${bootWait / 1000}s for the Windows autologin desktop…`);
  await Bun.sleep(bootWait);
  await windowsRunCombo();
  await Bun.sleep(2000);
  await typeLine('cmd');
  await Bun.sleep(4000);
  await typeLine(`curl.exe -s -m 10 -o p.ps1 ${base}/bootstrap.ps1`);
  await Bun.sleep(15000);
  await typeLine('powershell -ExecutionPolicy Bypass -File p.ps1');
  let result = '';
  for (let n = 0; n < 48 && !result; n++) { await Bun.sleep(5000); result = await Bun.file(join(root, 'shared', 'from-guest.txt')).text().catch(() => ''); }
  assert.ok(result, '客体探测结果未通过共享通道回传');
  console.log('--- windows guest probe result ---');
  console.log(result.trim());
  assert.ok(result.includes('guest-reads-this.txt'), '客体未能通过通道浏览共享目录');
  assert.ok(result.includes('DOWNLOAD=channel proof from host'), '客体未能通过通道下载文件');
  const smb = result.match(/SMB445=(OPEN|CLOSED)/)?.[1];
  console.log(`Windows guest can reach 10.0.2.2:445 (host SMB): ${smb ?? 'unknown'}`);
  console.log('PASS: a real Windows guest fetched, ran and reported through the token share channel.');
} finally {
  running = false; shares.shutdown();
  await qmp(qmpPort, 'quit').catch(() => child?.kill());
  await Bun.sleep(2000);
  child?.kill();
  await Bun.write(join(root, 'serial.log'), serialLog);
  console.log('Test data:', root);
}
