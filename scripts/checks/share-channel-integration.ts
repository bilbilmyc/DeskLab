import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../../server/store';
import { Lab } from '../../server/lab';
import { run } from '../../server/qemu';
import assert from 'node:assert/strict';

// Isolated one-off integration check: the share channel must be reachable in guest
// perspective (Host: 10.0.2.2) while the VM runs and closed after it shuts down.
const root = resolve('.runtime/checks', `share-channel-${Date.now()}`);
const qemuPath = resolve(process.env.QEMU_TEST_DIR ?? '.runtime/tools/qemu');
await mkdir(root, {recursive:true});
const boot = new Uint8Array(512); let offset = 0;
for (const character of 'DeskLab share OK') { boot.set([0xb4,0x0e,0xb0,character.charCodeAt(0),0xcd,0x10],offset); offset += 6; }
boot.set([0xfa,0xf4,0xeb,0xfd],offset); boot[510]=0x55; boot[511]=0xaa;
const source = resolve(root,'boot.raw'); await Bun.write(source,boot);
const shared = resolve(root,'shared'); await mkdir(shared);
await Bun.write(resolve(shared,'guest-reads-this.txt'),'channel proof');
const store = new Store(resolve(root,'data')); await store.init();
const lab = new Lab(store);
await lab.settings({qemuPath,accelerator:process.env.QEMU_TEST_ACCEL ?? 'whpx'});
try {
  const template = await lab.exclusive(() => lab.importTemplate({name:'Share channel check',family:'linux',path:source}));
  const {img} = await lab.tools(); await run(img,['resize',lab.base(template.id),'8G']); template.diskGB=8; await store.save();
  const vm = await lab.exclusive(() => lab.create({name:'Share VM',family:'linux',cpus:1,memory:512,diskGB:8,templateId:template.id}));
  await lab.exclusive(() => lab.addShare(vm.id,{name:'proof',hostPath:shared,readOnly:false}));
  await lab.exclusive(() => lab.start(vm.id));
  assert.equal(vm.state,'running');
  const channel = vm.shareChannel!;
  const headers = {Host:`10.0.2.2:${channel.port}`};
  const base = `http://127.0.0.1:${channel.port}/share/${channel.token}`;
  const listing = await (await fetch(`${base}/proof/`,{headers})).json();
  assert.ok(listing.entries.some((entry:{name:string}) => entry.name==='guest-reads-this.txt'));
  assert.equal(await (await fetch(`${base}/proof/guest-reads-this.txt`,{headers})).text(),'channel proof');
  const put = await fetch(`${base}/proof/guest-wrote-this.txt`,{method:'PUT',body:'upload proof',headers});
  assert.equal(put.status,200);
  assert.equal(await Bun.file(resolve(shared,'guest-wrote-this.txt')).text(),'upload proof');
  await lab.exclusive(() => lab.power(vm.id,true));
  for(let n=0;n<100&&lab.runtime.has(vm.id);n++)await Bun.sleep(100);
  await assert.rejects(fetch(`${base}/proof/guest-reads-this.txt`,{headers}));
  console.log('PASS: guest share channel listed, downloaded and uploaded while running; closed after shutdown.');
} finally {
  await lab.shutdown();
  console.log('Test data:',root);
}
