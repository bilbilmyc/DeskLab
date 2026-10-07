import { expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Machine } from '../shared/types';
import { Store } from '../server/store';
import { Lab } from '../server/lab';
import { Shares, resolveShareTarget } from '../server/shares';
import { freePort } from '../server/qemu';

test('share targets reject every segment that could escape or break Windows hosts',()=>{
  const root=resolve('/host/base');
  expect(resolveShareTarget(root,'')).toBe(root);
  expect(resolveShareTarget(root,'file.txt')).toBe(join(root,'file.txt'));
  expect(resolveShareTarget(root,'nested/dir/file.bin')).toBe(join(root,'nested','dir','file.bin'));
  expect(resolveShareTarget(root,'中文文件.txt')).toBe(join(root,'中文文件.txt'));
  for (const bad of ['.','..','a/..','a/.','../b','a//b','/abs','a\\b','a/b\x01c','trailing.','trailing ','CON','com1.txt','aux.tar.gz','nul.log',
    `long-${'x'.repeat(250)}.txt`])
    expect(resolveShareTarget(root,bad),bad).toBeUndefined();
});

async function fixture(running:(id:string)=>boolean=()=>true) {
  await mkdir('.runtime/tests/tests',{recursive:true});
  const root=await mkdtemp(resolve('.runtime/tests/tests','shares-unit-')),store=new Store(join(root,'data'));await store.init();
  const shared=join(root,'shared');await mkdir(join(shared,'sub'),{recursive:true});
  await Bun.write(join(shared,'hello.txt'),'host bytes');
  await Bun.write(join(root,'secret.txt'),'private host bytes');
  const port=await freePort(),token='ab'.repeat(32);
  const vm:Machine={id:crypto.randomUUID(),name:'share host',family:'ubuntu',firmware:'bios',memory:512,cpus:1,diskGB:8,state:'running',backingResolved:true,createdAt:new Date().toISOString(),
    shares:[{id:crypto.randomUUID(),name:'data',hostPath:shared,readOnly:false,createdAt:new Date().toISOString()}],
    shareChannel:{port,token}};
  store.data.machines.push(vm);await store.save();
  const manager=new Shares(store,running);
  manager.ensure(vm);
  const channel=vm.shareChannel!;
  return {root,store,vm,manager,shared,channel,base:`http://127.0.0.1:${channel.port}/share/${token}`,close(){manager.shutdown();}};
}

test('the guest share channel lists, downloads and accepts flat uploads inside the share',async()=>{
  const f=await fixture();
  try {
    const index=await (await fetch(`${f.base}/`,{headers:{Host:`10.0.2.2:${f.channel.port}`}})).json();
    expect(index).toEqual({shares:[{name:'data',readOnly:false}]});
    const listing=await (await fetch(`${f.base}/data/`)).json();
    expect(listing.entries).toContainEqual({name:'hello.txt',directory:false,size:10});
    expect(listing.entries).toContainEqual({name:'sub',directory:true});
    expect(await (await fetch(`${f.base}/data/hello.txt`)).text()).toBe('host bytes');
    expect(await (await fetch(`${f.base}/data/sub`)).json()).toEqual({path:'sub',entries:[],truncated:false});
    const put=await fetch(`${f.base}/data/upload.txt`,{method:'PUT',body:'guest bytes'});
    expect(put.status).toBe(200);expect(await put.json()).toEqual({written:'upload.txt'});
    expect(await (await fetch(`${f.base}/data/upload.txt`)).text()).toBe('guest bytes');
    expect(await Bun.file(join(f.shared,'upload.txt')).text()).toBe('guest bytes');
    expect((await fetch(`${f.base}/data/sub`,{method:'PUT',body:'x'})).status).toBe(409);
    f.vm.shares!.push({id:crypto.randomUUID(),name:'readonly',hostPath:f.shared,readOnly:true,createdAt:new Date().toISOString()});
    expect((await fetch(`${f.base}/readonly/upload.txt`,{method:'PUT',body:'x'})).status).toBe(403);
    for (const request of [
      new Request(`${f.base}/data/sub/x.txt`,{method:'PUT',body:'x'}),
      new Request(`${f.base}/data/trailing.dot.`,{method:'PUT',body:'x'}),
      new Request(`${f.base}/data/CON`,{method:'PUT',body:'x'}),
    ])expect((await fetch(request)).status,request.url).toBe(400);
    for (const request of [
      new Request(`${f.base}/data/hello.txt`,{method:'POST'}),
      new Request(`${f.base}/data/hello.txt`,{method:'DELETE'}),
    ])expect((await fetch(request)).status,request.url).toBe(405);
    for (const request of [
      new Request(`${f.base}/data/%2e%2e/secret.txt`),
      new Request(`${f.base}/data/%2e%2e%2fsecret.txt`),
      new Request(`${f.base}/data/hello.txt`,{headers:{Origin:'https://outside.example'}}),
      new Request(`${f.base}/data/hello.txt`,{headers:{Host:`outside.example:${f.channel.port}`}}),
      new Request(f.base.replace(f.channel.token,'cd'.repeat(32))+'/data/hello.txt'),
      new Request(`http://127.0.0.1:${f.channel.port}/api/state`),
      new Request(`http://127.0.0.1:${f.channel.port}/share/`),
    ])expect((await fetch(request)).status,request.url).toBe(404);
    await expect(fetch(`${f.base}/data/hello.txt`,{method:'PUT',body:'overwritten'}).then(r=>r.text())).resolves.toBe('{"written":"hello.txt"}');
    expect(await Bun.file(join(f.shared,'hello.txt')).text()).toBe('overwritten');
  }finally{f.close();}
});

test('the channel only answers while its machine runs and stops with it',async()=>{
  const stopped=await fixture(()=>false);
  try { expect((await fetch(`${stopped.base}/data/hello.txt`)).status).toBe(404); }
  finally{stopped.close();}
  const f=await fixture();
  try {
    f.manager.stop(f.vm.id);
    await expect(fetch(`${f.base}/data/hello.txt`)).rejects.toThrow();
  }finally{f.close();}
});

test('share management validates folders, rejects duplicates and the data directory',async()=>{
  const f=await fixture(),lab=new Lab(f.store,join(f.root,'iso'));
  try {
    await lab.addShare(f.vm.id,{name:'extra',hostPath:f.root});
    expect(lab.get(f.vm.id).shares).toHaveLength(2);
    await expect(lab.addShare(f.vm.id,{name:'DATA',hostPath:f.root})).rejects.toThrow('同名');
    await expect(lab.addShare(f.vm.id,{name:'inside',hostPath:join(f.root,'data')})).rejects.toThrow('数据目录');
    await expect(lab.addShare(f.vm.id,{name:'relative',hostPath:'shared'})).rejects.toThrow('完整路径');
    await expect(lab.addShare(f.vm.id,{name:'missing',hostPath:join(f.root,'no-such-folder')})).rejects.toThrow('不存在');
    await expect(lab.removeShare(f.vm.id,crypto.randomUUID())).rejects.toThrow('不存在');
    await lab.removeShare(f.vm.id,lab.get(f.vm.id).shares![1].id);
    expect(lab.get(f.vm.id).shares).toHaveLength(1);
  }finally{await lab.shutdown();f.close();}
});
