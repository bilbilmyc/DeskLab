import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../../server/store';
import { Lab } from '../../server/lab';
import { executable, run } from '../../server/qemu';
import { PortMappings } from '../../server/ports';
import type { Template } from '../../shared/types';

// Single-host approximation of LAN publishing: drives the real Lab flow
// (updateNetwork lanPublish -> PortMappings -> start) with the Debian template,
// then connects to the forwarded port through the host's own LAN address
// instead of loopback. This proves the 0.0.0.0 bind and slirp forwarding for
// non-loopback destinations; the Windows firewall path still needs a real
// second device on the LAN.
const templateBase = resolve('.data/templates/3628f107-3bed-4f1c-8fd8-e5c9ed182e08/base.qcow2');
const root = resolve('.runtime/checks', `lan-publish-${Date.now()}`);
const template: Template = {id: crypto.randomUUID(), name: 'debian probe', family: 'debian', diskGB: 40, createdAt: new Date().toISOString()};
await mkdir(join(root, 'data', 'templates', template.id), {recursive:true});
const store = new Store(join(root, 'data')); await store.init();
const qemu = await executable(''), imgTool = await executable('', true);
if (!qemu || !imgTool) throw new Error('未找到 QEMU 或 qemu-img');
store.data.templates.push(template); await store.save();
console.error('probe: store ready');
await run(imgTool, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', templateBase, join(root, 'data', 'templates', template.id, 'base.qcow2'), '40G']);
console.error('probe: overlay ready');
const lan = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
if (!lan) throw new Error('本机没有可用的局域网 IPv4 地址');
const lab = new Lab(store), mappings = new PortMappings(store, lab);
process.on('unhandledRejection', error => console.error('probe: unhandled rejection:', error));
let success = false;
try {
  let vm;
  try { vm = await lab.exclusive(() => lab.create({name: 'LAN publish probe', family: 'debian', memory: 2048, cpus: 2, diskGB: 40, templateId: template.id})); }
  catch (error) { console.error('probe: create failed →', error); throw error; }
  console.error('probe: vm created');
  await lab.exclusive(() => lab.updateNetwork(vm.id, {mode: 'nat', lanPublish: true}));
  console.error('probe: lanPublish set');
  const hostPort = 23222;
  await mappings.save({ownerId: vm.id, label: 'SSH LAN probe', protocol: 'tcp', hostPort, targetPort: 22});
  console.error('probe: mapping saved');
  console.log(`Host LAN address: ${lan}; mapping ${hostPort} -> 22 bound via lanPublish…`);
  await lab.exclusive(() => lab.start(vm.id));
  console.error('probe: vm started');
  const banner = (address: string) => new Promise<string>((done, fail) => {
    const socket = createConnection({host: address, port: hostPort});
    socket.setTimeout(8000, () => {socket.destroy(); fail(new Error(`${address}: banner timeout`));});
    socket.once('data', data => {socket.destroy(); done(data.toString());});
    socket.once('error', fail);
  });
  let ssh = '';
  for (let n = 0; n < 60 && !ssh; n++) { try { ssh = await banner('127.0.0.1'); } catch { await Bun.sleep(3000); } }
  assert.ok(ssh.startsWith('SSH-2.0'), '客体内 SSH 未在超时内经映射端口应答');
  console.log('loopback banner:', ssh.trim());
  const lanBanner = await banner(lan);
  assert.ok(lanBanner.startsWith('SSH-2.0'), '局域网地址未能取到 SSH banner');
  console.log(`lan banner via ${lan}:`, lanBanner.trim());
  console.log('PASS: 0.0.0.0 mapping forwards through the host LAN address. Firewall path still needs a second LAN device.');
  success = true;
} finally {
  console.error('probe: shutting down');
  await Promise.race([lab.exclusive(() => lab.shutdown()), Bun.sleep(30000).then(() => console.error('probe: shutdown timed out, forcing exit'))]).catch(() => {});
  console.error('probe: done');
  console.log('Test data:', root);
  process.exit(success ? 0 : 1);
}
