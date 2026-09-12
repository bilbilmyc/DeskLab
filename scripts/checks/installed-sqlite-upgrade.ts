import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {readFile} from 'node:fs/promises';
const origin='http://127.0.0.1:43210',root='D:/apps/DeskLab/data';
const health=await(await fetch(origin+'/api/health')).json();assert.equal(health.version,'0.2.0');
const previous=JSON.parse(await readFile('.runtime/backups/before-sqlite-upgrade/lab.stopped.json','utf8'));
const state=await(await fetch(origin+'/api/state')).json();
assert.deepEqual(state.machines.map((v:any)=>v.id),previous.machines.map((v:any)=>v.id));
const db=new Database(root+'/desklab.sqlite',{readonly:true});
try {
 assert.equal((db.query('PRAGMA quick_check').get() as any).quick_check,'ok');
 assert.equal((db.query('SELECT count(*) AS count FROM templates').get() as any).count,previous.templates.length);
 for(const vm of previous.machines){const saved=JSON.parse((db.query('SELECT document FROM machines WHERE id=?').get(vm.id) as any).document);assert.equal(saved.templateId,vm.templateId);assert.equal(saved.sshPort,vm.sshPort);assert.ok(await Bun.file(root+'/machines/'+vm.id+'/disk.qcow2').exists());}
 assert.equal(await Bun.file(root+'/backups/lab.pre-sqlite.json').text(),await Bun.file('.runtime/backups/before-sqlite-upgrade/lab.stopped.json').text());
 console.log(JSON.stringify({version:health.version,database:root+'/desklab.sqlite',integrity:'ok',machines:state.machines.length,templates:previous.templates.length,backup:'byte-identical',pid:health.pid}));
}finally{db.close();}
