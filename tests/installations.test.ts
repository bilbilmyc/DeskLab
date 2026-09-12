import { expect, spyOn, test } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, rename, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import type { Machine, Template } from '../shared/types';
import { Store } from '../server/store';
import { Lab } from '../server/lab';
import { Installations } from '../server/installations';
import { installationRecipe } from '../server/install-recipes';
import { isoSources } from '../server/iso-sources';
import { freePort } from '../server/qemu';

async function fixture() {
  await mkdir('.runtime/tests/tests',{recursive:true});
  const root=await mkdtemp(resolve('.runtime/tests/tests','installation-unit-')),store=new Store(join(root,'data'));await store.init();
  const vm:Machine={id:crypto.randomUUID(),name:'isolated installer',family:'ubuntu',firmware:'bios',memory:1024,cpus:1,diskGB:20,state:'running',backingResolved:true,createdAt:new Date().toISOString(),installation:{recipeId:'ubuntu-server',phase:'installing',message:'installing',startedAt:new Date().toISOString()}};
  store.data.machines.push(vm);await store.save();
  const install=store.managed('machines',vm.id,'install'),generation=crypto.randomUUID(),directory=join(install,generation),token='ab'.repeat(32),port=await freePort(),source=isoSources.find(item=>item.id==='ubuntu-server')!;
  await mkdir(directory,{recursive:true});
  const recipe=installationRecipe(source.id,{baseUrl:`http://10.0.2.2:${port}/install/${token}`,hostname:`desk-${vm.id.slice(0,8)}`});
  for(const [name,body] of Object.entries(recipe.files))await Bun.write(join(directory,name),body);
  for(const name of ['kernel','original-initrd','seed.iso'])await Bun.write(join(directory,name),'fixture resource');
  const manifest={version:1,recipeId:source.id,token,port,generation,size:source.bytes,mtimeMs:0,sha256:source.sha256!,files:Object.keys(recipe.files),kernel:'kernel',initrd:'original-initrd',seed:'seed.iso',append:recipe.append};
  const manifestPath=join(install,'prepared.json');await Bun.write(manifestPath,JSON.stringify(manifest));
  const reports:{id:string;event:string;body:string}[]=[];
  const manager=new Installations(store,async(id,event,body)=>{reports.push({id,event,body});});
  return {root,store,vm,manager,reports,manifest,manifestPath,install,directory,base:`http://127.0.0.1:${port}/install/${token}`,async rewrite(changes:Record<string,unknown>){await Bun.write(manifestPath,JSON.stringify({...manifest,...changes}));},close(){manager.shutdown();}};
}

test('guest HTTP exposes only allowlisted files and scoped callbacks, never the app API',async()=>{
  const f=await fixture();
  try {
    await f.manager.recover(f.vm);
    const normal=await fetch(`${f.base}/finish.sh`);expect(normal.status).toBe(200);expect(await normal.text()).toContain('root:DeskLab0987');
    const host=await fetch(`${f.base}/meta-data`,{headers:{Host:`10.0.2.2:${f.manifest.port}`}});expect(host.status).toBe(200);
    for(const request of [
      new Request(`${f.base}/prepared.json`),new Request(`${f.base}/kernel`),new Request(`${f.base}/seed.iso`),new Request(`${f.base}/%2e%2e%2flab.json`),
      new Request(f.base.replace(f.manifest.token,'cd'.repeat(32))+'/finish.sh'),new Request(`${f.base}/finish.sh`,{method:'DELETE'}),
      new Request(`${f.base}/finish.sh`,{headers:{Origin:'https://outside.example'}}),new Request(`${f.base}/finish.sh`,{headers:{Host:`outside.example:${f.manifest.port}`}}),
      new Request(`http://127.0.0.1:${f.manifest.port}/api/state`),
    ])expect((await fetch(request)).status).toBe(404);
    const body=JSON.stringify({event:'installed',user:'root',automaticLogin:true});
    expect((await fetch(`${f.base}/installed`,{method:'POST',body})).status).toBe(200);
    expect(f.reports).toEqual([{id:f.vm.id,event:'installed',body}]);
    f.vm.installation!.phase='ready';
    expect((await fetch(`${f.base}/finish.sh`)).status).toBe(404);
    expect((await fetch(`${f.base}/installed`,{method:'POST',body})).status).toBe(404);
  }finally{f.close();}
});

test('recovery rejects a different recipe, escaping boot resources and malformed capability fields',async()=>{
  const f=await fixture();
  try {
    for(const mutation of [{recipeId:'debian-server'},{generation:'-'.repeat(36)},{token:'short'},{port:80},{kernel:'../../lab.json'},{seed:'C:\\Windows\\win.ini'},{files:['..']},{sha256:'not-a-hash'},{size:1},{append:'init=/bin/sh'}]){
      await f.rewrite(mutation);await expect(f.manager.recover(f.vm)).rejects.toThrow();
    }
    await f.rewrite({});await f.manager.recover(f.vm);
    expect((await fetch(`${f.base}/finish.sh`)).status).toBe(200);
  }finally{f.close();}
});

test('recovery refuses missing boot resources and linked generation directories',async()=>{
  const f=await fixture();
  try {
    await rename(join(f.directory,'original-initrd'),join(f.directory,'original-initrd.backup'));
    await expect(f.manager.recover(f.vm)).rejects.toThrow();
    await rename(join(f.directory,'original-initrd.backup'),join(f.directory,'original-initrd'));
    const outside=join(f.root,'outside');await rename(f.directory,outside);
    await symlink(outside,f.directory,process.platform==='win32'?'junction':'dir');
    await expect(f.manager.recover(f.vm)).rejects.toThrow(/目录|路径/);
  }finally{f.close();}
});

test('a file replaced by a hard link after recovery cannot expose another host file',async()=>{
  const f=await fixture();
  try {
    await f.manager.recover(f.vm);
    const outside=join(f.root,'private-host-fixture.txt');await Bun.write(outside,'private host bytes');
    const target=join(f.directory,'finish.sh');await unlink(target);await link(outside,target);
    const response=await fetch(`${f.base}/finish.sh`);expect(response.status).toBe(404);expect(await response.text()).not.toContain('private host bytes');
  }finally{f.close();}
});

test('a generation replaced by a junction after recovery is denied on every GET',async()=>{
  const f=await fixture();
  try {
    await f.manager.recover(f.vm);
    const outside=join(f.root,'replacement');await rename(f.directory,outside);await Bun.write(join(outside,'finish.sh'),'private fixture');
    await symlink(outside,f.directory,process.platform==='win32'?'junction':'dir');
    expect((await fetch(`${f.base}/finish.sh`)).status).toBe(404);
  }finally{f.close();}
});

test('installed callback alone is not sufficient to cache a disk after interrupted recovery',async()=>{
  const f=await fixture(),lab=new Lab(f.store,join(f.root,'iso'));
  type Conversion={convertTemplate:(...args:unknown[])=>Promise<Template>};
  const conversion=spyOn(lab as unknown as Conversion,'convertTemplate').mockImplementation(async()=>{const template:Template={id:crypto.randomUUID(),name:'unexpected cache',family:'ubuntu',diskGB:20,createdAt:new Date().toISOString()};f.store.data.templates.push(template);return template;});
  const start=spyOn(lab,'start').mockImplementation(async()=>f.vm);
  try {
    f.vm.installation!.phase='installed';f.vm.state='stopped';await f.store.save();
    await lab.recover();
    expect(conversion).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();
    expect(lab.get(f.vm.id).installation?.phase).not.toBe('ready');expect(f.store.data.templates).toHaveLength(0);
  }finally{start.mockRestore();conversion.mockRestore();await lab.shutdown();f.close();}
});

test('a persisted confirmed guest shutdown permits caching once during recovery',async()=>{
  const f=await fixture(),lab=new Lab(f.store,join(f.root,'iso'));
  type Conversion={convertTemplate:(...args:unknown[])=>Promise<Template>};
  const conversion=spyOn(lab as unknown as Conversion,'convertTemplate').mockImplementation(async()=>{const template:Template={id:crypto.randomUUID(),name:'confirmed cache',family:'ubuntu',diskGB:20,createdAt:new Date().toISOString()};f.store.data.templates.push(template);return template;});
  const start=spyOn(lab,'start').mockImplementation(async()=>f.vm);
  try {
    f.vm.installation=Object.assign(f.vm.installation!,{phase:'installed' as const,shutdownConfirmed:true});f.vm.state='stopped';await f.store.save();
    await lab.recover();
    expect(conversion).toHaveBeenCalledTimes(1);expect(start).toHaveBeenCalledTimes(1);expect(lab.get(f.vm.id).installation?.phase).toBe('ready');
    expect(lab.get(f.vm.id).isoPath).toBeUndefined();expect(lab.get(f.vm.id).templateId).toBe(f.store.data.templates[0].id);
    const saved=f.store.db.load();expect(saved.machines[0].installation!.shutdownConfirmed).toBe(true);
  }finally{start.mockRestore();conversion.mockRestore();await lab.shutdown();f.close();}
});

test('one broken installation record does not prevent recovery or tracking its live QEMU process',async()=>{
  const f=await fixture(),lab=new Lab(f.store,join(f.root,'iso')),sockets=new Set<Socket>();
  const server=createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    socket.write(JSON.stringify({QMP:{version:{qemu:{major:11,minor:0,micro:0},package:''},capabilities:[]}})+'\n');
    let buffer='';
    socket.on('data',data=>{buffer+=data.toString();let end:number;while((end=buffer.indexOf('\n'))>=0){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);socket.write(JSON.stringify({return:request.execute==='query-name'?{name:`DeskLab-${f.vm.id}`}:request.execute==='query-status'?{running:true,status:'running'}:{},id:request.id})+'\n');}});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    f.vm.session={pid:process.pid,qmpPort:(server.address() as {port:number}).port,vncPort:5900};
    const other:Machine={...f.vm,id:crypto.randomUUID(),name:'unrelated stopped environment',state:'stopped',installation:undefined,session:undefined};f.store.data.machines.push(other);
    await f.rewrite({token:'corrupt'});await f.store.save();
    await lab.recover();
    expect(lab.runtime.has(f.vm.id)).toBe(true);expect(lab.get(f.vm.id).installation?.phase).toBe('failed');
    expect(()=>lab.requireStopped(f.vm.id)).toThrow('请先关闭环境');expect(lab.get(other.id).state).toBe('stopped');
  }finally{lab.runtime.clear();await lab.shutdown();f.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
