import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../../server/store';
import {Lab} from '../../server/lab';
import {run,qmp} from '../../server/qemu';
const root=resolve('.runtime/checks',`reboot-smoke-${Date.now()}`);await mkdir(root,{recursive:true});
// A real guest requests an x86 keyboard-controller reset after a keypress.
const boot=new Uint8Array(512);boot.set([0x31,0xc0,0xcd,0x16,0xb0,0xfe,0xe6,0x64,0xfa,0xf4,0xeb,0xfd]);boot[510]=0x55;boot[511]=0xaa;
const source=join(root,'boot.raw');await Bun.write(source,boot);
const store=new Store(root);await store.init();const lab=new Lab(store);
let active=lab;
await lab.settings({qemuPath:resolve(process.env.QEMU_TEST_DIR??'.runtime/tools/qemu'),accelerator:'whpx'});
try{
 const template=await lab.importTemplate({name:'Guest restart fixture',family:'windows',firmware:'bios',path:source});
 const {img}=await lab.tools();await run(img,['resize',lab.base(template.id),'8G']);template.diskGB=8;await store.save();
 let vm=await lab.create({name:'Guest restart fixture',family:'windows',cpus:1,memory:512,diskGB:8,templateId:template.id});
 await lab.exclusive(()=>lab.start(vm.id));
 for(let cycle=0;cycle<2;cycle++){
  const previous=lab.runtime.get(vm.id)!;await Bun.sleep(8000);
  await qmp(previous.qmpPort,'screendump',{filename:join(root,`before-${cycle}.png`),format:'png'});
  await qmp(previous.qmpPort,'human-monitor-command',{'command-line':'sendkey r'});
  for(let n=0;n<160;n++){await Bun.sleep(100);if(vm.state==='running'&&vm.session?.pid!==previous.pid)break;}
  if(vm.session?.pid===previous.pid){console.log(await qmp(previous.qmpPort,'query-status'));await qmp(previous.qmpPort,'screendump',{filename:join(root,'failed.png'),format:'png'});console.log('Fixture evidence:',root);}
  assert.notEqual(vm.session?.pid,previous.pid,'Guest reset must start a fresh WHPX process instead of resetting its partition');
  assert.equal(vm.state,'running');assert.ok(vm.session?.pid);
 }
 console.log('PASS: two real guest resets restart WHPX and retain the same disk.');
 const previous=lab.runtime.get(vm.id)!;previous.closeEvents?.();lab.runtime.clear();
 const restored=new Store(root);await restored.init();active=new Lab(restored);await active.recover();vm=active.get(vm.id);
 await Bun.sleep(8000);await qmp(previous.qmpPort,'human-monitor-command',{'command-line':'sendkey r'});
 for(let n=0;n<160;n++){await Bun.sleep(100);if(vm.state==='running'&&vm.session?.pid!==previous.pid)break;}
 assert.notEqual(vm.session?.pid,previous.pid,'Recovered application must observe guest restarts');
 console.log('PASS: recovered process reconnects its event monitor and handles guest restart.');
 await qmp(active.runtime.get(vm.id)!.qmpPort,'stop');await active.refreshRecovered();assert.equal(vm.state,'error');assert.ok(vm.session,'Paused disks must remain protected');
 await active.exclusive(()=>active.power(vm.id,true));
 for(let n=0;n<100&&active.runtime.has(vm.id);n++)await Bun.sleep(100);
 assert.equal(active.runtime.has(vm.id),false,'Host stop must never trigger automatic restart');
 assert.equal(vm.state,'stopped');
 console.log('PASS: host stop stays stopped.');
}finally{await active.shutdown();}
