import { test, expect } from 'bun:test';
import { mkdir, mkdtemp, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store, type Journal } from '../server/store';
import type { Machine } from '../shared/types';
import { Lab } from '../server/lab';
import { freePort } from '../server/qemu';
async function fixture() {
  await mkdir('.runtime/tests/tests',{recursive:true});
  const root=await mkdtemp(resolve('.runtime/tests/tests','recovery-'));
  const store=new Store(root);await store.init();
  const vm: Machine={id:crypto.randomUUID(),name:'recovery',family:'linux',memory:512,cpus:1,diskGB:8,createdAt:new Date().toISOString(),state:'stopped'};
  store.data.machines.push(vm);await mkdir(store.managed('machines',vm.id),{recursive:true});
  await Bun.write(store.managed('machines',vm.id,'disk.qcow2'),'original');await store.save();
  return {store,vm};
}
test('an interrupted reset restores the previous disk before the next startup',async()=>{
  const {store,vm}=await fixture();
  const record:Journal={id:vm.id,type:'reset',kind:'machines',transaction:crypto.randomUUID()};
  await store.journal(record);
  await Bun.write(store.managed('machines',vm.id,'reset.qcow2'),'new disk');
  await rename(store.managed('machines',vm.id,'disk.qcow2'),store.managed('machines',vm.id,'previous.qcow2'));
  const restarted=new Store(store.root);await restarted.init();
  expect(await Bun.file(restarted.managed('machines',vm.id,'disk.qcow2')).text()).toBe('original');
});
test('committed reset keeps new disk and cleans rollback copy',async()=>{
  const {store,vm}=await fixture();const record:Journal={id:vm.id,type:'reset',kind:'machines',transaction:crypto.randomUUID()};
  await store.journal(record);await rename(store.managed('machines',vm.id,'disk.qcow2'),store.managed('machines',vm.id,'previous.qcow2'));
  await Bun.write(store.managed('machines',vm.id,'disk.qcow2'),'new disk');vm.diskGeneration=record.transaction;await store.save();
  const restarted=new Store(store.root);await restarted.init();
  expect(await Bun.file(restarted.managed('machines',vm.id,'disk.qcow2')).text()).toBe('new disk');
  expect(await Bun.file(restarted.managed('machines',vm.id,'previous.qcow2')).exists()).toBe(false);
});
test('uncommitted deletion is restored from its staging directory',async()=>{
  const {store,vm}=await fixture();const record:Journal={id:vm.id,type:'delete',kind:'machines',transaction:crypto.randomUUID()};
  await mkdir(store.managed('trash'),{recursive:true});await store.journal(record);
  await rename(store.managed('machines',vm.id),store.managed('trash',record.transaction));
  const restarted=new Store(store.root);await restarted.init();
  expect(restarted.data.machines).toHaveLength(1);
  expect(await Bun.file(restarted.managed('machines',vm.id,'disk.qcow2')).text()).toBe('original');
});
test('metadata save failure rolls in-memory state back to the last commit',async()=>{
  const {store}=await fixture();store.db.with(db=>db.exec("CREATE TRIGGER reject_save BEFORE DELETE ON machines BEGIN SELECT RAISE(ABORT,'test storage failure'); END"));
  store.data.machines=[];
  await expect(store.save()).rejects.toThrow();
  expect(store.data.machines).toHaveLength(1);
});
test('an interrupted launch without a persisted PID stays protected',async()=>{
  const {store,vm}=await fixture();vm.session={qmpPort:await freePort(),vncPort:await freePort()};await store.save();
  const lab=new Lab(store);await lab.recover();
  expect(store.data.machines[0].state).toBe('error');
  expect(()=>lab.requireStopped(vm.id)).toThrow('请先关闭');
});
test('unknown backing dependencies prevent template deletion',async()=>{
  const {store}=await fixture();const lab=new Lab(store);
  await expect(lab.removeTemplate(crypto.randomUUID())).rejects.toThrow('磁盘依赖未确认');
});
