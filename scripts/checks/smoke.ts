import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../../server/store';
import { Lab } from '../../server/lab';
import { run, qmp } from '../../server/qemu';
import { createConnection } from 'node:net';
import assert from 'node:assert/strict';

// Runs against a new, isolated directory; never touches the user's environments.
const root = resolve('.runtime/checks', `smoke-${Date.now()}`);
const qemuPath = resolve(process.env.QEMU_TEST_DIR ?? '.runtime/tools/qemu');
await mkdir(root, {recursive: true});
const boot = new Uint8Array(512); let offset = 0;
for (const character of 'DeskLab VM boot OK') {
  boot.set([0xb4,0x0e,0xb0,character.charCodeAt(0),0xcd,0x10],offset); offset += 6;
}
boot.set([0xfa,0xf4,0xeb,0xfd],offset); boot[510]=0x55; boot[511]=0xaa;
const source = resolve(root,'boot.raw'); await Bun.write(source,boot);
const store = new Store(root); await store.init();
const lab = new Lab(store);
await lab.settings({qemuPath,accelerator: process.env.QEMU_TEST_ACCEL ?? 'whpx'});
try {
  const template = await lab.exclusive(() => lab.importTemplate({name:'Boot sector verification',family:'linux',path:source}));
  const {img} = await lab.tools(); await run(img,['resize',lab.base(template.id),'8G']); template.diskGB=8; await store.save();
  const vm = await lab.exclusive(() => lab.create({name:'Smoke VM',family:'linux',cpus:1,memory:512,diskGB:8,templateId:template.id}));
  await lab.exclusive(() => lab.start(vm.id));
  assert.equal(vm.state,'running');
  const runtime = lab.runtime.get(vm.id)!;
  const protocol = await new Promise<string>((res,rej) => {
    const socket = createConnection({host:'127.0.0.1',port:runtime.vncPort});
    socket.setTimeout(5000,()=>{socket.destroy();rej(new Error('VNC handshake timeout'));});
    socket.once('data',data=>{socket.destroy();res(data.toString());}); socket.on('error',rej);
  });
  assert.match(protocol,/RFB 003/);
  const reloadedStore=new Store(root);await reloadedStore.init();const reconnected=new Lab(reloadedStore);await reconnected.recover();
  assert.equal(reloadedStore.data.machines[0].state,'running');assert.equal(reconnected.runtime.get(vm.id)?.qmpPort,runtime.qmpPort);
  reconnected.runtime.clear();
  console.log('PASS: persisted QMP identity verified and live VM reconnected after state reload.');
  console.log('PASS: real QEMU launch, QMP status, VNC handshake. Accelerator:',store.data.settings.accelerator);
  await assert.rejects(lab.exclusive(()=>lab.reset(vm.id)),/请先关闭/);
  await lab.exclusive(()=>lab.power(vm.id,true));
  for(let i=0;i<80&&lab.runtime.has(vm.id);i++) await Bun.sleep(100);
  assert.equal(lab.runtime.has(vm.id),false,'QEMU must exit before disk writes');
  const checkpoint = await lab.exclusive(()=>lab.saveTemplate(vm.id,'Second checkpoint'));
  await assert.rejects(lab.exclusive(()=>lab.removeTemplate(template.id)),/仍被/);
  await lab.exclusive(()=>lab.reset(vm.id));
  const chain = JSON.parse(await run(img,['info','--output=json',lab.disk(vm.id)]));
  assert.equal(resolve(chain['full-backing-filename']),lab.base(checkpoint.id));
  await lab.exclusive(()=>lab.removeTemplate(template.id));
  await lab.exclusive(()=>lab.start(vm.id));
  await qmp(lab.runtime.get(vm.id)!.qmpPort,'query-status');
  await lab.exclusive(()=>lab.power(vm.id,true));
  for(let i=0;i<80&&lab.runtime.has(vm.id);i++) await Bun.sleep(100);
  await lab.exclusive(()=>lab.remove(vm.id));
  await lab.exclusive(()=>lab.removeTemplate(checkpoint.id));
  console.log('PASS: live-operation guard, template independence, backing protection, restore, reboot, delete.');
  console.log('Test data:',root);
} finally {await lab.shutdown();}
