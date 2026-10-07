import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { executable, run, freePort, qmp } from '../../server/qemu';

// Final SMB verification: the host admin has created a scoped share
// (desklabprobe, CHANGE for the desklabprobe user only). Boot the real Debian
// template and mount //10.0.2.2/desklabprobe with the valid credentials: read
// the host file, write a guest file, then cross-check both sides.
const templateBase = resolve('.data/templates/3628f107-3bed-4f1c-8fd8-e5c9ed182e08/base.qcow2');
const credentials = (await Bun.file(resolve('.runtime/checks/smb-credentials.txt')).text()).split(/\r?\n/);
const [smbUser, smbPassword] = [credentials[0]?.trim(), credentials[1]?.trim()];
if (!smbUser || !smbPassword) throw new Error('缺少 SMB 测试凭据(smb-credentials.txt)');
const root = resolve('.runtime/checks', `guest-smb-final-${Date.now()}`);
await mkdir(join(root), {recursive:true});
const qemu = await executable(''), imgTool = await executable('', true);
if (!qemu || !imgTool) throw new Error('未找到 QEMU 或 qemu-img');
const disk = join(root, 'disk.qcow2');
await run(imgTool, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', templateBase, disk, '40G']);
const vncPort = await freePort(), qmpPort = await freePort(), serialPort = await freePort(), servePort = await freePort();
const bootstrap = ['#!/bin/sh',
  '{',
  '  mkdir -p /mnt/smb',
  `  mount -t cifs //10.0.2.2/desklabprobe /mnt/smb -o username=${smbUser},password=${smbPassword},vers=3.0`,
  '  rc=$?',
  '  echo "MOUNT_RC=$rc"',
  '  echo "--- dmesg ---"; dmesg | grep -i -E "cifs|smb" | tail -8',
  '  if [ "$rc" = 0 ]; then',
  '    echo "READ=$(cat /mnt/smb/from-host.txt 2>&1)"',
  '    echo "guest-write-$(date +%s)" > /mnt/smb/guest-wrote.txt && echo "WRITE=OK" || echo "WRITE=FAIL"',
  '    echo "--- listing ---"; ls -l /mnt/smb 2>&1',
  '    umount /mnt/smb',
  '  fi',
  '} > /tmp/smb-final.txt 2>&1',
  `curl -s -m 8 --data-binary @/tmp/smb-final.txt http://10.0.2.2:${servePort}/result`,
  '', ''].join('\n');
const results: string[] = [];
const server = Bun.serve({hostname: '127.0.0.1', port: servePort, fetch: async request => {
  const url = new URL(request.url);
  if (url.pathname === '/bootstrap.sh') return new Response(bootstrap, {headers: {'Content-Type': 'text/plain'}});
  if (url.pathname === '/result') { results.push(await request.text()); return new Response('ok'); }
  return new Response('Not found', {status: 404});
}});
let child: ChildProcess | undefined;
const args = ['-name', 'DeskLab-smb-final', '-machine', 'pc', '-accel', process.env.QEMU_TEST_ACCEL ?? 'whpx', '-cpu', 'max', '-m', '2048', '-smp', '2',
  '-drive', `file=${disk.replaceAll(',', ',,')},format=qcow2,if=ide`, '-nic', 'user,model=e1000',
  '-vga', 'std', '-display', 'none', '-vnc', `127.0.0.1:${vncPort - 5900}`, '-qmp', `tcp:127.0.0.1:${qmpPort},server=on,wait=off`,
  '-serial', `tcp:127.0.0.1:${serialPort},server=on,wait=off`, '-pidfile', join(root, 'qemu.pid'),
  '-usb', '-device', 'usb-tablet', '-boot', 'order=c,menu=on'];
let serialLog = '';
const plainQcodes = new Map([[' ', 'spc'], ['-', 'minus'], ['.', 'dot'], ['/', 'slash'], [';', 'semicolon'], ['=', 'equal']]);
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
  const serial = createConnection({host: '127.0.0.1', port: serialPort});
  serial.on('data', data => {serialLog += data.toString();});
  serial.on('error', () => {});
  child = spawn(qemu, args, {cwd: dirname(qemu), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  child.stderr?.on('data', data => {serialLog += data.toString();});
  child.on('close', code => {serialLog += `QEMU exited with code ${code}\n`;});
  for (let n = 0; n < 60; n++) { try { await qmp(qmpPort, 'query-status'); break; } catch { await Bun.sleep(1000); } }
  const bootWait = Number(process.env.GUEST_PROBE_BOOT_WAIT ?? 150000);
  console.log(`QEMU is up; waiting ${bootWait / 1000}s for the Debian autologin shell…`);
  await Bun.sleep(bootWait);
  await typeLine(`curl -s -m 8 -o /tmp/p.sh http://10.0.2.2:${servePort}/bootstrap.sh; sh /tmp/p.sh`);
  let result = '';
  for (let n = 0; n < 30 && !result; n++) { await Bun.sleep(3000); result = results[0] ?? ''; }
  assert.ok(result, '客体挂载结果未回传');
  console.log('--- guest smb mount result ---');
  console.log(result.trim());
  assert.ok(result.includes('MOUNT_RC=0'), '客体挂载失败');
  assert.ok(result.includes('READ=smb host proof'), '客体未能读取宿主文件');
  assert.ok(result.includes('WRITE=OK'), '客体未能写入共享');
  const hostSide = await Bun.file(resolve('.runtime/checks/smb-share/guest-wrote.txt')).text().catch(() => '');
  assert.ok(hostSide.startsWith('guest-write-'), '宿主侧未看到客体写入的文件');
  console.log('host side sees guest file:', hostSide.trim());
  console.log('PASS: real guest mounted the host SMB3 share with valid credentials; read and write verified on both sides.');
} finally {
  server.stop(true);
  await qmp(qmpPort, 'quit').catch(() => child?.kill());
  await Bun.sleep(1500);
  child?.kill();
  await Bun.write(join(root, 'serial.log'), serialLog);
  console.log('Test data:', root);
}
