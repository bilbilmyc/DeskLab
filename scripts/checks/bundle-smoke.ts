import { mkdir, cp } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../../server/store';
import { Lab } from '../../server/lab';
import { run } from '../../server/qemu';

const root=resolve('.runtime/checks',`bundle-smoke-${Date.now()}`), iso=join(root,'iso');
await mkdir(iso,{recursive:true});
const store=new Store(join(root,'.data'));await store.init();
const lab=new Lab(store,iso);
await lab.settings({qemuPath:resolve('.runtime/tools/qemu'),accelerator:'whpx'});
const boot=new Uint8Array(512);boot.set([0xfa,0xf4,0xeb,0xfd]);boot[510]=0x55;boot[511]=0xaa;
const raw=join(root,'boot.raw');await Bun.write(raw,boot);
const {img}=await lab.tools();
try {
  const template=await lab.importTemplate({name:'Paired system',family:'linux',path:raw});
  await run(img,['resize',lab.base(template.id),'8G']);template.diskGB=8;await store.save();
  const sourceIso=join(iso,'test.iso');await Bun.write(sourceIso,'installation media');
  await Bun.write(join(iso,'prepared-images.json'),JSON.stringify({images:[{iso:'test.iso',name:'Paired system',status:'ready',templateId:template.id}]}));
  const request={name:'Load paired ISO',family:'windows',isoPath:sourceIso,firmware:'uefi',cpus:1,memory:512,diskGB:8};
  const vm=await lab.create(request);
  assert.equal(vm.templateId,template.id);assert.equal(vm.isoPath,undefined);assert.equal(vm.family,'linux');assert.equal(vm.firmware,'bios');
  const fresh=await lab.create({...request,name:'Explicit reinstall',freshInstall:true});
  assert.equal(fresh.templateId,undefined);assert.equal(fresh.isoPath,sourceIso);
  await lab.start(vm.id);await lab.power(vm.id,true);
  for(let i=0;i<80&&lab.runtime.has(vm.id);i++)await Bun.sleep(100);
  assert.equal(vm.state,'stopped');
  await lab.reset(vm.id);
  const originalInfo=JSON.parse(await run(img,['info','--output=json',lab.disk(vm.id)]));
  assert.equal(isAbsolute(originalInfo['backing-filename']),false);
  const copiedRoot=join(root,'copied-data');await cp(store.root,copiedRoot,{recursive:true});
  const copiedStore=new Store(copiedRoot);await copiedStore.init();const copiedLab=new Lab(copiedStore);
  const copiedInfo=JSON.parse(await run(img,['info','--output=json',copiedLab.disk(vm.id)]));
  assert.equal(resolve(copiedInfo['full-backing-filename']),copiedLab.base(template.id));
  try {await copiedLab.start(vm.id);assert.equal(copiedLab.get(vm.id).state,'running');}
  finally {await copiedLab.shutdown();}
  console.log('PASS: ISO pairing, explicit reinstall, inherited firmware, relative backing, reset, relocated clone QEMU boot.');
} finally {await lab.shutdown();}
