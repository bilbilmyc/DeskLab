import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { executable, run, freePort, qmp } from '../../server/qemu';

// Acceptance step 2: real QEMU layer-2 traffic through the Windows bridge.
// The bridge (10.99.0.1/24) joins two isolated TAPs; the Debian guest attaches
// to TAP-A via QEMU's tap backend (its second NIC stays on slirp for the
// management channel). The guest configures 10.99.0.2 on the TAP NIC and pings
// the host's bridge address; the host pings back.
const l2info = await Bun.file(resolve('.runtime/checks/l2-info.json')).json() as {tapA: {name: string}};
const templateBase = resolve('.data/templates/3628f107-3bed-4f1c-8fd8-e5c9ed182e08/base.qcow2');
const root = resolve('.runtime/checks', `guest-l2-${Date.now()}`);
await mkdir(root, {recursive:true});
const qemu = await executable(''), imgTool = await executable('', true);
if (!qemu || !imgTool) throw new Error('未找到 QEMU 或 qemu-img');
const disk = join(root, 'disk.qcow2');
await run(imgTool, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', templateBase, disk, '40G']);
const vncPort = await freePort(), qmpPort = await freePort(), serialPort = await freePort(), servePort = await freePort();
const bootstrap = ['#!/bin/sh',
  '{',
  '  DEV=',
  '  for i in $(ls /sys/class/net); do',
  "    [ \"$i\" = lo ] && continue",
  "    ip -4 addr show dev \"$i\" | grep -q 10.0.2.15 || DEV=\"$i\"",
  '  done',
  '  echo "TAP_DEV=$DEV"',
  "  ip link show >/dev/null 2>&1; ip -o link",
  "  ip addr add 10.99.0.2/24 dev \"$DEV\" 2>&1",
  "  ip link set \"$DEV\" up",
  '  sleep 2',
  '  ping -c 3 -W 2 10.99.0.1 2>&1 | tail -3',
  '  echo "ARP_AFTER=$(ip neigh show dev $DEV 2>/dev/null)"',
  '} > /tmp/l2.txt 2>&1',
  `curl -s -m 8 --data-binary @/tmp/l2.txt http://10.0.2.2:${servePort}/result`,
  '', ''].join('\n');
const results: string[] = [];
const server = Bun.serve({hostname: '127.0.0.1', port: servePort, fetch: async request => {
  const url = new URL(request.url);
  if (url.pathname === '/bootstrap.sh') return new Response(bootstrap, {headers: {'Content-Type': 'text/plain'}});
  if (url.pathname === '/result') { results.push(await request.text()); return new Response('ok'); }
  return new Response('Not found', {status: 404});
}});
let child: ChildProcess | undefined;
const args = ['-name', 'DeskLab-l2-probe', '-machine', 'pc', '-accel', process.env.QEMU_TEST_ACCEL ?? 'whpx', '-cpu', 'max', '-m', '2048', '-smp', '2',
  '-drive', `file=${disk.replaceAll(',', ',,')},format=qcow2,if=ide`,
  '-nic', 'user,model=e1000',
  '-netdev', `tap,id=ntap,ifname=${l2info.tapA.name}`, '-device', 'e1000,netdev=ntap',
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
  const bootWait = Number(process.env.GUEST_PROBE_BOOT_WAIT ?? 210000);
  console.log(`QEMU is up on TAP ${l2info.tapA.name}; waiting ${bootWait / 1000}s for the Debian shell (extra time for the tap NIC DHCP timeout)…`);
  await Bun.sleep(bootWait);
  await typeLine(`curl -s -m 8 -o /tmp/p.sh http://10.0.2.2:${servePort}/bootstrap.sh; sh /tmp/p.sh`);
  let result = '';
  for (let n = 0; n < 30 && !result; n++) { await Bun.sleep(3000); result = results[0] ?? ''; }
  assert.ok(result, '客体二层测试结果未回传');
  console.log('--- guest l2 result ---');
  console.log(result.trim());
  assert.ok(/TAP_DEV=\S+/.test(result), '客体未能识别 TAP 网卡');
  assert.ok(!/100% packet loss/.test(result) && /0% packet loss|3 received/.test(result), '客体经网桥 ping 宿主失败');
  console.log('guest→host bridge ping ok; trying host→guest…');
  const hostPing = await new Promise<string>(resolvePing => {
    const probe = spawn('ping', ['-n', '3', '-w', '2000', '10.99.0.2'], {windowsHide: true});
    let output = '';
    probe.stdout?.on('data', data => {output += data.toString();});
    probe.on('close', () => resolvePing(output.split('\n').slice(-3).join(' ').trim()));
  });
  console.log('host ping 10.99.0.2:', hostPing);
  // Localized ping output cannot be matched by ASCII phrases; a round-trip
  // summary in ms with no 100%/66% loss line means replies were received.
  assert.ok(/ms/.test(hostPing) && !/(100|67|66)%/.test(hostPing), '宿主经网桥 ping 客体失败');
  console.log('PASS: bidirectional layer-2 traffic through the Windows bridge with a real QEMU guest.');
} finally {
  server.stop(true);
  await qmp(qmpPort, 'quit').catch(() => child?.kill());
  await Bun.sleep(1500);
  child?.kill();
  await Bun.write(join(root, 'serial.log'), serialLog);
  console.log('Test data:', root);
}
