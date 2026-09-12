import {test,expect} from 'bun:test';
import {mkdir,mkdtemp,readFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Database} from 'bun:sqlite';
import {Store} from '../../server/store';
import {ManagedDocker} from '../../server/docker/managed/engine';
import {ManagedBackups} from '../../server/docker/managed/backups';
async function root(){await mkdir('.runtime/tests/docker-managed',{recursive:true});return mkdtemp(resolve('.runtime/tests/docker-managed/test-'));}
test('v1 database migrates in place, preserves external engines, and writes one coherent backup',async()=>{
 const directory=await root(),store=new Store(directory);await store.init();const id=crypto.randomUUID();
 store.db.with(db=>{for(const q of ['DROP TABLE managed_engines','DROP TABLE engine_backups','DROP INDEX guest_endpoint','ALTER TABLE docker_engines DROP COLUMN kind','ALTER TABLE port_mappings DROP COLUMN guest_port','ALTER TABLE port_mappings DROP COLUMN applied_state','ALTER TABLE port_mappings DROP COLUMN last_error','PRAGMA user_version=1'])db.query(q).run();db.query('INSERT INTO docker_engines(id,context,name,endpoint,server_id,created_at) VALUES(?,?,?,?,?,?)').run(id,'fixture','fixture','npipe:///fixture','server','now');});
 const reloaded=new Store(directory);await reloaded.init();expect(reloaded.db.with(db=>db.query('SELECT id,kind FROM docker_engines').get())).toEqual({id,kind:'external'});
 const copies=Array.from(new Bun.Glob('before-managed-v2-*.sqlite').scanSync({cwd:join(directory,'backups')}));expect(copies).toHaveLength(1);const backup=new Database(join(directory,'backups',copies[0]),{readonly:true});try{expect(backup.query('PRAGMA user_version').get()).toEqual({user_version:1});expect(backup.query('SELECT id FROM docker_engines').get()).toEqual({id});}finally{backup.close();}
 await new Store(directory).init();expect(Array.from(new Bun.Glob('before-managed-v2-*.sqlite').scanSync({cwd:join(directory,'backups')}))).toHaveLength(1);
});
for(const committed of [false,true])test(`interrupted restore ${committed?'keeps committed replacement':'rolls file swaps back before database commit'}`,async()=>{
 const directory=await root(),store=new Store(directory);await store.init();const id=crypto.randomUUID(),generation=crypto.randomUUID(),managed=new ManagedDocker(store),backups=new ManagedBackups(store,managed),home=managed.directory(id),previous=join(home,'restore-'+generation,'previous');await mkdir(previous,{recursive:true});
 store.db.with(db=>db.query('INSERT INTO docker_engines(id,context,name,endpoint,server_id,created_at,kind) VALUES(?,?,?,?,?,?,?)').run(id,'fixture','fixture','','','now','managed'));
 managed.save({id,imageId:'fixture',imagePath:'fixture',memoryMB:2048,cpus:2,diskGB:64,dataId:crypto.randomUUID(),state:'stopped',initialized:true,createdAt:'now',updatedAt:'now',restoreGeneration:committed?generation:undefined});
 await Bun.write(join(home,'system.qcow2'),'new-system');await Bun.write(join(previous,'system.qcow2'),'old-system');await Bun.write(join(home,'data.qcow2'),'unchanged-data');await Bun.write(join(home,'restore.json'),JSON.stringify({generation}));
 await backups.recover();expect(await readFile(join(home,'system.qcow2'),'utf8')).toBe(committed?'new-system':'old-system');expect(await readFile(join(home,'data.qcow2'),'utf8')).toBe('unchanged-data');expect(await Bun.file(join(home,'restore.json')).exists()).toBe(false);
});
