import {test,expect} from 'bun:test';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Store} from '../../server/store';
import {DockerService} from '../../server/docker/service';
async function fixture(){await mkdir('.runtime/tests/docker-managed',{recursive:true});const store=new Store(await mkdtemp(resolve('.runtime/tests/docker-managed/selection-')));await store.init();const id=crypto.randomUUID();store.db.with(db=>db.query('INSERT INTO docker_engines(id,context,name,endpoint,server_id,created_at,kind) VALUES(?,?,?,?,?,?,?)').run(id,'fixture','fixture','','original','now','managed'));store.db.set('docker.selected',id);const docker=new DockerService(store);docker.managed.save({id,imageId:'fixture',imagePath:'fixture',dataId:crypto.randomUUID(),cpus:2,memoryMB:2048,diskGB:64,state:'stopped',initialized:true,createdAt:'now',updatedAt:'now'});return {store,docker,id};}
test('an engine operation retains its original engine when selection changes while starting',async()=>{
 const {store,docker,id}=await fixture(),other=crypto.randomUUID();store.db.with(db=>db.query('INSERT INTO docker_engines(id,context,name,endpoint,server_id,created_at) VALUES(?,?,?,?,?,?)').run(other,'other','other','npipe:///other','other','now'));
 docker.managed.start=async()=>{store.db.set('docker.selected',other);return docker.managed.record()!;};docker.managed.checked=async()=>({ID:'original'});
 expect((await docker.checkedEngine(true)).id).toBe(id);expect(docker.engine()?.id).toBe(other);
});
test('stopped engine mappings never advertise cached containers as running',async()=>{
 const {store,docker,id}=await fixture();store.db.with(db=>db.query('INSERT INTO docker_resources(engine_id,id,name,image,state,owned,document,observed_at) VALUES(?,?,?,?,?,?,?,?)').run(id,'container','web','nginx','running',1,JSON.stringify({id:'container',name:'web',state:'running',createdAt:'now',ports:[{hostAddress:'127.0.0.1',hostPort:8080,targetPort:80,guestPort:20000,protocol:'tcp'}]}),new Date().toISOString()));expect(docker.mappings()[0].status).toBe('stopped');const record=docker.managed.record()!;record.state='error';docker.managed.save(record);expect(docker.mappings()[0].status).toBe('unknown');
});
