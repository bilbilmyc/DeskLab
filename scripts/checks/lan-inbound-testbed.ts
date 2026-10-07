import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { Store } from '../../server/store';
import { Lab } from '../../server/lab';
import { executable, run, qmp } from '../../server/qemu';
import { PortMappings } from '../../server/ports';
import type { Template } from '../../shared/types';

// Long-running inbound LAN test bed: a Debian VM started through the real Lab
// flow with lanPublish enabled and mapping 28080 -> guest 8080, where a
// python3 http.server runs. Any device on the LAN (e.g. the fnOS NAS browser)
// opening http://<host LAN IP>:28080 completes the cross-device verification.
// The guest keeps the server log at /tmp/http.log for later exfiltration.
const hostPort = 28080;
const templateBase = resolve('.data/templates/3628f107-3bed-4f1c-8fd8-e5c9ed182e08/base.qcow2');
const root = resolve('.runtime/checks', `lan-inbound-${Date.now()}`);
const interfaces = networkInterfaces();
// Interface aliases seen by Bun don't match the localized display name, so
// prefer the subnet where the always-on LAN NAS (192.168.5.60) lives.
const candidates = Object.values(interfaces).flat()
  .filter(address => address?.family === 'IPv4' && !address.internal)
  .map(address => address!.address);
const lan = candidates.find(address => address.startsWith('192.168.5.')) ?? candidates[0];
if (!lan) throw new Error('本机没有可用的局域网 IPv4 地址');
const template: Template = {id: crypto.randomUUID(), name: 'debian testbed', family: 'debian', diskGB: 40, createdAt: new Date().toISOString()};
await mkdir(join(root, 'data', 'templates', template.id), {recursive:true});
const store = new Store(join(root, 'data')); await store.init();
const qemu = await executable(''), imgTool = await executable('', true);
if (!qemu || !imgTool) throw new Error('未找到 QEMU 或 qemu-img');
await run(imgTool, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', templateBase, join(root, 'data', 'templates', template.id, 'base.qcow2'), '40G']);
store.data.templates.push(template); await store.save();
const lab = new Lab(store), mappings = new PortMappings(store, lab);
// lab.start() allocates the real QMP port; captured here after boot for typing.
let qmpPort = 0;
let stopping = false;
process.on('SIGINT', () => {stopping = true; console.log('testbed: stopping…'); void lab.exclusive(() => lab.shutdown()).catch(() => {}).finally(() => process.exit(0));});
const plainQcodes = new Map([[' ', 'spc'], ['-', 'minus'], ['.', 'dot'], ['/', 'slash'], [';', 'semicolon'], ['=', 'equal']]);
const shiftedQcodes = new Map([[':', 'semicolon'], ['>', 'dot'], ['&', '7'], ['(', '9'], [')', '0']]);
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
const vm = await lab.exclusive(() => lab.create({name: 'LAN inbound testbed', family: 'debian', memory: 2048, cpus: 2, diskGB: 40, templateId: template.id}));
await lab.exclusive(() => lab.updateNetwork(vm.id, {mode: 'nat', lanPublish: true}));
await mappings.save({ownerId: vm.id, label: 'LAN inbound test bed', protocol: 'tcp', hostPort, targetPort: 8080});
console.log(`testbed: mapping ${hostPort} -> 8080 with lanPublish; starting Debian…`);
await lab.exclusive(() => lab.start(vm.id));
qmpPort = vm.session!.qmpPort;
console.log('testbed: VM running; waiting for the autologin shell…');
await Bun.sleep(Number(process.env.GUEST_PROBE_BOOT_WAIT ?? 150000));
await typeLine('command -v python3');
await typeLine('cd /srv; python3 -m http.server 8080 >/tmp/http.log 2>&1 &');
await Bun.sleep(4000);
for (const address of ['127.0.0.1', lan]) {
  const response = await fetch(`http://${address}:${hostPort}/`).catch(() => undefined);
  console.log(`testbed: self-check http://${address}:${hostPort}/ -> ${response ? response.status : 'failed'}`);
}
console.log(`TEST BED READY — open http://${lan}:${hostPort}/ from any LAN device (fnOS browser, phone, another PC).`);
console.log('The guest logs requests to /tmp/http.log; this bed keeps running until stopped.');
process.on('SIGTERM', () => process.emit('SIGINT'));
setInterval(() => { if (stopping) process.exit(0); }, 1000).unref?.();
await new Promise(() => {});
