import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Store} from '../server/store';
test('SQLite migration preserves JSON backup, disk paths, identities and ignores stale legacy metadata',async()=>{
  await mkdir('.runtime/tests',{recursive:true});const root=await mkdtemp(resolve('.runtime/tests/sqlite-'));
  const id=crypto.randomUUID(),legacy={version:1,settings:{qemuPath:'custom-engine',accelerator:'tcg'},machines:[{id,name:'已有 Ubuntu',family:'ubuntu',memory:2048,cpus:2,diskGB:20,state:'stopped',sshPort:2222,createdAt:'2026-09-12T00:00:00Z'}],templates:[]};
  const text=JSON.stringify(legacy);await Bun.write(join(root,'lab.json'),text);await Bun.write(join(root,'machines',id,'disk.qcow2'),'unchanged disk bytes');
  const store=new Store(root);await store.init();expect(store.data.machines[0].id).toBe(id);
  expect(await readFile(join(root,'backups','lab.pre-sqlite.json'),'utf8')).toBe(text);
  expect(await readFile(join(root,'machines',id,'disk.qcow2'),'utf8')).toBe('unchanged disk bytes');
  expect((await Bun.file(join(root,'lab.json')).json()).version).toBe(2);
  const identity=store.db.get('installationId');store.data.machines[0].name='updated';await store.save();
  await Bun.write(join(root,'lab.json'),text);const reloaded=new Store(root);await reloaded.init();
  expect(reloaded.data.machines[0].name).toBe('updated');expect(reloaded.db.get('installationId')).toBe(identity);
  expect(reloaded.db.with(db=>db.query('PRAGMA quick_check').get())).toEqual({quick_check:'ok'});
});
test('port reservations enforce protocol/endpoint uniqueness in the database',async()=>{
  const root=await mkdtemp(resolve('.runtime/tests/sqlite-ports-')),store=new Store(root);await store.init();
  const insert=()=>store.db.with(db=>db.query("INSERT INTO port_mappings(id,owner_type,owner_id,label,protocol,host_address,host_port,target_port,created_at) VALUES(?,'vm','fixture','test','tcp','127.0.0.1',18080,80,'now')").run(crypto.randomUUID()));
  insert();expect(insert).toThrow();expect(store.db.with(db=>db.query('SELECT COUNT(*) AS count FROM port_mappings').get())).toEqual({count:1});
});
