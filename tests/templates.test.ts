import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Template } from '../shared/types';
import { Store } from '../server/store';
import { Lab } from '../server/lab';
import { builtinTemplates, migrateBuiltinTemplates, templateCatalogue } from '../server/catalog';
import { importInput, saveTemplateInput, updateTemplateInput } from '../server/validation';
import { executable, qmp, run } from '../server/qemu';

async function fixture() {
  await mkdir('.runtime/tests/tests', {recursive:true});
  const root = await mkdtemp(resolve('.runtime/tests/tests', 'templates-unit-'));
  const store = new Store(join(root, 'data')); await store.init();
  return {root, store, lab:new Lab(store, join(root, 'iso'))};
}

function record(id = crypto.randomUUID()): Template {
  return {id, name:'My Debian', family:'debian', diskGB:40, createdAt:new Date().toISOString()};
}

test('legacy prepared disks migrate and remain usable without an ISO directory', async () => {
  const {store, lab} = await fixture();
  store.data.templates = builtinTemplates.map(item => ({...record(item.legacyTemplateId), family:item.family}));
  const ready = store.data.templates.find(item => item.family === 'debian')!;
  await mkdir(store.managed('templates', ready.id), {recursive:true});
  await Bun.write(lab.base(ready.id), 'registered disk');
  await store.save(); await lab.recover();
  const catalogue = await lab.catalogue();
  expect(catalogue).toHaveLength(8);
  expect(catalogue.slice(0,3).every(item => item.interface === 'terminal')).toBe(true);
  expect(catalogue.filter(item => item.templateId).map(item => item.templateId)).toEqual([ready.id]);
  expect(await lab.images()).toEqual([]);
  const reloaded = new Store(store.root); await reloaded.init();
  expect(reloaded.data.templates.every(item => item.builtinId && item.memory && item.cpus)).toBe(true);
  expect(await migrateBuiltinTemplates(reloaded.data.templates)).toBe(false);
  await expect(lab.updateTemplate(ready.id, {name:'Replace built-in'})).rejects.toThrow('系统自带模板不能直接修改');
  await expect(lab.removeTemplate(ready.id)).rejects.toThrow('系统自带模板不能删除');
  expect(await Bun.file(lab.base(ready.id)).text()).toBe('registered disk');
});

test('a prepared manifest links a new resource UUID without requiring its ISO', async () => {
  const {root, store} = await fixture(), template = record();
  const iso = join(root, 'iso'); await mkdir(iso);
  await Bun.write(join(iso, 'prepared-images.json'), JSON.stringify({images:[
    {id:'debian-server', iso:'debian.iso', name:'Debian', templateId:template.id, status:'ready'},
    {id:'ubuntu-server', iso:'../outside.iso', name:'Invalid', templateId:template.id, status:'ready'},
  ]}));
  expect(await migrateBuiltinTemplates([template], iso)).toBe(true);
  expect(template.builtinId).toBe('debian-server');
  expect((await templateCatalogue([template], store.root)).every(item => !item.templateId)).toBe(true);
  await Bun.write(join(iso, 'prepared-images.json'), '{bad json');
  expect(await migrateBuiltinTemplates([record()], iso)).toBe(false);
});

test('editing a custom template changes defaults, leaving its disk and existing environments intact', async () => {
  const {store, lab} = await fixture(), template = record();
  store.data.templates.push(template);
  await mkdir(store.managed('templates', template.id), {recursive:true});
  await Bun.write(lab.base(template.id), 'unchanged system');
  const vm = {id:crypto.randomUUID(), name:'Existing VM', family:'debian' as const, diskGB:40,
    memory:1024, cpus:1, templateId:template.id, state:'stopped' as const, createdAt:new Date().toISOString()};
  store.data.machines.push(vm); await store.save();
  const result = await lab.updateTemplate(template.id, {name:'Bun development', description:'Bun and Git', memory:3072, cpus:2, loginHint:'Use my existing user'});
  expect(result).toMatchObject({name:'Bun development', description:'Bun and Git', memory:3072, cpus:2});
  expect(vm).toMatchObject({memory:1024, cpus:1});
  expect(await Bun.file(lab.base(template.id)).text()).toBe('unchanged system');
  await expect(lab.updateTemplate(template.id, {builtinId:'debian-server'})).rejects.toThrow();
  await expect(lab.updateTemplate(template.id, {family:'windows'})).rejects.toThrow();
  await lab.updateTemplate(template.id, {description:'', loginHint:''});
  expect(template.description).toBe('');
});

test('template resource defaults are bounded and names remain required on import and save', () => {
  for (const bad of [{memory:511}, {memory:65537}, {memory:1024.5}, {cpus:0}, {cpus:33}, {cpus:1.5}]) {
    expect(updateTemplateInput.safeParse(bad).success).toBe(false);
    expect(saveTemplateInput.safeParse({name:'Custom', ...bad}).success).toBe(false);
    expect(importInput.safeParse({name:'Custom', family:'debian', path:'D:/disk.qcow2', ...bad}).success).toBe(false);
  }
  expect(updateTemplateInput.safeParse({}).success).toBe(false);
  expect(saveTemplateInput.safeParse({name:' '}).success).toBe(false);
  expect(importInput.safeParse({name:'Custom', family:'debian', path:'D:/disk.qcow2', builtinId:'unknown'}).success).toBe(false);
});

const configuredQemu = process.env.QEMU_TEST_DIR ?? '';
const imageTool = await executable(configuredQemu, true);
const emulator = await executable(configuredQemu);
test.skipIf(!imageTool)('template clones honor CPU, memory and expanded disk capacity without changing the base',async()=>{
  const {root,store,lab}=await fixture();store.data.settings.qemuPath=configuredQemu;
  const source=join(root,'expandable.qcow2');await run(imageTool!,['create','-f','qcow2',source,'16G']);
  const base=await lab.importTemplate({name:'Expandable system',family:'linux',path:source});
  const before=new Bun.CryptoHasher('sha256').update(await Bun.file(lab.base(base.id)).arrayBuffer()).digest('hex');
  const vm=await lab.create({name:'Expanded copy',family:'linux',templateId:base.id,memory:3072,cpus:1,diskGB:32});
  const info=async(path:string)=>JSON.parse(await run(imageTool!,['info','--output=json',path]));
  expect(vm).toMatchObject({memory:3072,cpus:1,diskGB:32});expect((await info(lab.disk(vm.id)))['virtual-size']).toBe(32*1073741824);
  const peer=await lab.create({name:'Original capacity copy',family:'linux',templateId:base.id,memory:1024,cpus:1,diskGB:16});
  expect((await info(lab.disk(peer.id)))['virtual-size']).toBe(16*1073741824);
  await expect(lab.create({name:'Too small',family:'linux',templateId:base.id,memory:1024,cpus:1,diskGB:8})).rejects.toThrow('只能保持或扩大');
  expect(store.data.machines).toHaveLength(2);
  await lab.reset(vm.id);expect((await info(lab.disk(vm.id)))['virtual-size']).toBe(32*1073741824);expect(vm.diskGB).toBe(32);
  expect(new Bun.CryptoHasher('sha256').update(await Bun.file(lab.base(base.id)).arrayBuffer()).digest('hex')).toBe(before);
  const saved=await lab.saveTemplate(vm.id,'Expanded template');expect(saved.diskGB).toBe(32);
},30000);
test.skipIf(!imageTool)('real disk import, clone and save preserve the original while recording custom defaults', async () => {
  const {root, store, lab} = await fixture();
  store.data.settings.qemuPath = configuredQemu;
  const source = join(root, 'installed.raw');
  await run(imageTool!, ['create', '-f', 'raw', source, '8M']);
  const original = new Bun.CryptoHasher('sha256').update(await Bun.file(source).arrayBuffer()).digest('hex');
  const builtin = await lab.importTemplate({name:'Debian prepared resource', family:'debian', path:source, builtinId:'debian-server'});
  expect(builtin).toMatchObject({builtinId:'debian-server', memory:2048, cpus:2});
  expect(builtin.loginHint).toContain('导入不会修改');
  expect((await lab.catalogue()).find(item => item.id === 'debian-server')).toMatchObject({templateId:builtin.id, loginHint:builtin.loginHint});
  await expect(lab.importTemplate({name:'Duplicate', family:'debian', path:source, builtinId:'debian-server'})).rejects.toThrow('已准备好');
  const baseBefore = new Bun.CryptoHasher('sha256').update(await Bun.file(lab.base(builtin.id)).arrayBuffer()).digest('hex');
  const vm = await lab.create({name:'Customize Debian', family:'debian', memory:2048, cpus:1, diskGB:8, templateId:builtin.id});
  const saved = await lab.saveTemplate(vm.id, {name:'My tools', description:'Installed tools', memory:3072, cpus:2, loginHint:'My existing account'});
  expect(saved).toMatchObject({description:'Installed tools', memory:3072, cpus:2, loginHint:'My existing account'});
  expect(saved.builtinId).toBeUndefined();
  expect(vm).toMatchObject({memory:2048, cpus:1, backingTemplateId:builtin.id, templateId:saved.id});
  const info = JSON.parse(await run(imageTool!, ['info', '--output=json', lab.base(saved.id)]));
  expect(info['backing-filename']).toBeUndefined();
  expect(new Bun.CryptoHasher('sha256').update(await Bun.file(source).arrayBuffer()).digest('hex')).toBe(original);
  expect(new Bun.CryptoHasher('sha256').update(await Bun.file(lab.base(builtin.id)).arrayBuffer()).digest('hex')).toBe(baseBefore);
  const inherited = await lab.saveTemplate(vm.id, 'Inherited resources');
  expect(inherited).toMatchObject({memory:2048, cpus:1});
  await expect(lab.importTemplate({name:'Wrong system', family:'windows', firmware:'uefi', path:source, builtinId:'ubuntu-server'})).rejects.toThrow('必须与');
}, 30000);

test.skipIf(!imageTool)('multiple saved templates protect both the current backing disk and latest restore point', async () => {
  const {root, store, lab} = await fixture();
  store.data.settings.qemuPath = configuredQemu;
  const source = join(root, 'source.raw'); await Bun.write(source, new Uint8Array(4096));
  const original = await lab.importTemplate({name:'Original custom template', family:'linux', path:source});
  const create = (name:string, templateId:string) => lab.create({name, family:'linux', memory:512, cpus:1, diskGB:8, templateId});
  const vm = await create('Working environment', original.id);
  const previous = await lab.saveTemplate(vm.id, 'Previous restore point');
  const dependent = await create('Uses previous template', previous.id);
  const latest = await lab.saveTemplate(vm.id, 'Latest restore point');
  expect(vm).toMatchObject({backingTemplateId:original.id, templateId:latest.id});
  await expect(lab.removeTemplate(original.id)).rejects.toThrow('仍被');
  await expect(lab.removeTemplate(latest.id)).rejects.toThrow('仍被');
  await expect(lab.removeTemplate(previous.id)).rejects.toThrow('仍被');
  await lab.remove(dependent.id);
  await lab.removeTemplate(previous.id);
  expect(await Bun.file(lab.base(previous.id)).exists()).toBe(false);
  await lab.reset(vm.id);
  expect(vm).toMatchObject({backingTemplateId:latest.id, templateId:latest.id});
  const info = JSON.parse(await run(imageTool!, ['info', '--output=json', lab.disk(vm.id)]));
  expect(resolve(info['full-backing-filename'])).toBe(lab.base(latest.id));
  await lab.removeTemplate(original.id);
  expect(await Bun.file(lab.base(original.id)).exists()).toBe(false);
  await expect(lab.removeTemplate(latest.id)).rejects.toThrow('仍被');
}, 30000);

test.skipIf(!imageTool || !emulator)('saving an installed ISO environment ejects the installer and boots its original disk', async () => {
  const {root, store, lab} = await fixture();
  store.data.settings = {qemuPath:configuredQemu, accelerator:'tcg'};
  const iso = join(root, 'installer.iso'); await Bun.write(iso, 'installation medium');
  const vm = await lab.create({name:'Installed from ISO', family:'linux', memory:512, cpus:1, diskGB:8, isoPath:iso, freshInstall:true,isoTypeConfirmed:true});
  // Simulate the result of an installation with a real bootable system disk.
  const marker = 'DESKLAB SAVED DISK';
  const code = [0xfa, 0xb8, 0x00, 0xb8, 0x8e, 0xc0, 0x31, 0xff];
  for (const character of marker) code.push(0xb8, character.charCodeAt(0), 0x0f, 0xab);
  code.push(0xf4, 0xeb, 0xfd);
  const sector = new Uint8Array(512); sector.set(code); sector[510]=0x55; sector[511]=0xaa;
  const source = join(root, 'installed.raw'); await Bun.write(source, sector);
  await run(imageTool!, ['convert', '-f', 'raw', '-O', 'qcow2', source, lab.disk(vm.id)]);
  await lab.saveTemplate(vm.id, 'Installed system');
  expect(vm.isoPath).toBeUndefined();
  const reloaded = new Store(store.root); await reloaded.init();
  expect(reloaded.data.machines.find(item => item.id === vm.id)?.isoPath).toBeUndefined();
  await rename(iso, iso+'.unused');
  try {
    await lab.start(vm.id);
    let actual = '';
    for (let attempt=0; attempt<100; attempt++) {
      const memory = await qmp(vm.session!.qmpPort, 'human-monitor-command', {'command-line':`xp /${marker.length*2}bx 0xb8000`}) as string;
      const bytes = [...memory.matchAll(/0x([a-f0-9]{2})(?=\s|$)/gi)].map(match => parseInt(match[1],16));
      actual = String.fromCharCode(...bytes.filter((_, index) => index%2===0));
      if (actual===marker) break;
      await Bun.sleep(100);
    }
    expect(actual).toBe(marker);
  } finally { await lab.shutdown(); }
}, 30000);
