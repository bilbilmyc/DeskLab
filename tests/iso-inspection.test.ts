import {expect,test} from 'bun:test';
import {mkdir,mkdtemp,readdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createConfigIso} from '../server/install-media';
import {inspectIso,validateSelectedIso,verifyAutomaticIso} from '../server/iso-inspection';
import {Store} from '../server/store';
import {Lab} from '../server/lab';
import type {IsoSource} from '../server/iso-sources';
async function fixture(label='Rocky-9-8-x86_64',name='ubuntu.iso'){
  await mkdir('.runtime/tests',{recursive:true});const root=await mkdtemp(resolve('.runtime/tests/iso-inspection-')),path=join(root,name);
  await createConfigIso(path,label,{'marker':'test only'});return {root,path};
}
test('detects internal Rocky label even when filename says Ubuntu and file is outside ISO library',async()=>{
  const {path}=await fixture();const result=await inspectIso({path,family:'ubuntu',recipeId:'ubuntu-server'});
  expect(result.status).toBe('mismatch');expect(result.detectedFamily).toBe('rocky');expect(result.message).toContain('Rocky Linux');
  expect((await inspectIso({path,family:'rocky'})).status).toBe('match');
  await expect(validateSelectedIso(path,'ubuntu',undefined,true)).rejects.toThrow('Rocky Linux');
});
test('same family with wrong version or size cannot use automatic installation',async()=>{
  const {path}=await fixture('Ubuntu-Server-22-04');
  const result=await inspectIso({path,family:'ubuntu',recipeId:'ubuntu-server'});
  expect(result.status).toBe('mismatch');expect(result.message).toContain('ubuntu-24.04.5');
  await expect(validateSelectedIso(path,'ubuntu','ubuntu-server',true)).rejects.toThrow('大小不匹配');
});
test('unknown custom media requires explicit manual confirmation, never inferred from filename',async()=>{
  const {path}=await fixture('CUSTOM_SYSTEM');const result=await inspectIso({path,family:'ubuntu'});
  expect(result.status).toBe('unknown');expect(result.detectedFamily).toBeUndefined();expect(result.requiresConfirmation).toBe(true);
  await expect(validateSelectedIso(path,'ubuntu')).rejects.toThrow('无法');
  await validateSelectedIso(path,'ubuntu',undefined,true);
});
test('rejects missing files, relative paths and unknown recipes',async()=>{
  const {path}=await fixture();
  await expect(inspectIso({path:'ubuntu.iso',family:'ubuntu'})).rejects.toThrow('完整路径');
  await expect(inspectIso({path:path+'-missing.iso',family:'ubuntu'})).rejects.toThrow();
  await expect(inspectIso({path,family:'ubuntu',recipeId:'invalid'})).rejects.toThrow('模板不存在');
});
test('full verification distinguishes files with identical names and sizes',async()=>{
  const {path}=await fixture('Ubuntu');const original=await Bun.file(path).bytes();
  const source:IsoSource={id:'fixture',name:'fixture',file:'ubuntu.iso',family:'ubuntu',firmware:'bios',bytes:(await stat(path)).size,sha256:new Bun.CryptoHasher('sha256').update(original).digest('hex'),sourcePage:'fixture'};
  await verifyAutomaticIso(path,source);
  const changed=original.slice();changed[changed.length-1]^=1;await Bun.write(path,changed);
  await expect(verifyAutomaticIso(path,source)).rejects.toThrow('完整性校验失败');
});
test('server refuses bad ISO before creating records, disks or SSH keys',async()=>{
  const {root,path}=await fixture(),store=new Store(join(root,'data'));await store.init();const lab=new Lab(store,join(root,'library'));
  const before=await readdir(store.root),input={name:'Wrong ISO',family:'ubuntu',firmware:'bios',memory:2048,cpus:1,diskGB:40,isoPath:path,recipeId:'ubuntu-server'};
  await expect(lab.create(input)).rejects.toThrow('Rocky Linux');
  expect(store.data.machines).toHaveLength(0);expect(await readdir(store.root)).toEqual(before);
  const reloaded=new Store(store.root);await reloaded.init();expect(reloaded.data.machines).toHaveLength(0);
});
