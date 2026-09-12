import {Database as SQLite} from 'bun:sqlite';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import type {Machine,Settings,Template} from '../shared/types';

export interface LabData {version:1;settings:Settings;machines:Machine[];templates:Template[];}
// Connections are scoped to synchronous transactions. No open file handle survives
// a request, and callers never hold a SQLite transaction while awaiting QEMU/Docker.
export class MetadataDatabase {
  readonly path:string;
  constructor(readonly root:string){this.path=join(root,'desklab.sqlite');}
  with<T>(fn:(db:SQLite)=>T):T {
    const db=new SQLite(this.path,{create:true,strict:true});
    try {for(const statement of ['PRAGMA busy_timeout=5000','PRAGMA foreign_keys=ON','PRAGMA synchronous=FULL'])db.query(statement).run();return fn(db);}
    finally {db.close();}
  }
  async init(fallback:LabData) {
    await mkdir(this.root,{recursive:true});
    await mkdir(join(this.root,'backups'),{recursive:true});
    this.with(db=>{
      const version=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
      if(version>2)throw new Error('数据库版本高于当前程序，请使用更新版本的 DeskLab');
      db.query('PRAGMA journal_mode=WAL').get();
      const schema=`
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS machines(id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS docker_engines(id TEXT PRIMARY KEY,context TEXT NOT NULL UNIQUE,name TEXT NOT NULL,endpoint TEXT NOT NULL,server_id TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS docker_projects(id TEXT PRIMARY KEY,engine_id TEXT NOT NULL REFERENCES docker_engines(id),name TEXT NOT NULL,compose_name TEXT NOT NULL UNIQUE,file_path TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS docker_resources(engine_id TEXT NOT NULL REFERENCES docker_engines(id),id TEXT NOT NULL,name TEXT NOT NULL,image TEXT NOT NULL,state TEXT NOT NULL,owned INTEGER NOT NULL,project_id TEXT,document TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(engine_id,id));
        CREATE TABLE IF NOT EXISTS port_mappings(id TEXT PRIMARY KEY,owner_type TEXT NOT NULL CHECK(owner_type IN ('vm','docker')),owner_id TEXT NOT NULL,engine_id TEXT,label TEXT NOT NULL,protocol TEXT NOT NULL CHECK(protocol IN ('tcp','udp')),host_address TEXT NOT NULL DEFAULT '127.0.0.1',host_port INTEGER NOT NULL CHECK(host_port BETWEEN 1024 AND 65535),target_port INTEGER NOT NULL CHECK(target_port BETWEEN 1 AND 65535),created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS port_endpoint ON port_mappings(protocol,host_address,host_port);
        CREATE INDEX IF NOT EXISTS mappings_owner ON port_mappings(owner_type,owner_id);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,resource_id TEXT,state TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        `;
      db.transaction(()=>{for(const statement of schema.split(';').map(s=>s.trim()).filter(Boolean))db.query(statement).run();})();
      if(version<2) {
        // SQLite's online backup API produces a coherent snapshot even with WAL.
        if(version===1)db.query('VACUUM INTO ?').run(join(this.root,'backups','before-managed-v2-'+Date.now()+'.sqlite'));
        db.transaction(()=>{
          db.query("ALTER TABLE docker_engines ADD COLUMN kind TEXT NOT NULL DEFAULT 'external'").run();
          db.query('ALTER TABLE port_mappings ADD COLUMN guest_port INTEGER').run();
          db.query("ALTER TABLE port_mappings ADD COLUMN applied_state TEXT NOT NULL DEFAULT 'pending'").run();
          db.query('ALTER TABLE port_mappings ADD COLUMN last_error TEXT').run();
          db.query('CREATE UNIQUE INDEX guest_endpoint ON port_mappings(engine_id,protocol,guest_port) WHERE guest_port IS NOT NULL').run();
          db.query('CREATE TABLE managed_engines(id TEXT PRIMARY KEY REFERENCES docker_engines(id),document TEXT NOT NULL)').run();
          db.query('CREATE TABLE engine_backups(id TEXT PRIMARY KEY,engine_id TEXT NOT NULL,document TEXT NOT NULL)').run();
          db.query('PRAGMA user_version=2').run();
        })();
      }
    });
    if(!this.get('initialized')) {
      let initial=fallback,legacy:string|undefined;
      try {legacy=await readFile(join(this.root,'lab.json'),'utf8');initial=JSON.parse(legacy);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(initial.version!==1||!Array.isArray(initial.machines)||!Array.isArray(initial.templates)||!initial.settings)throw new Error('不支持的数据格式');
      if(legacy!==undefined) {
        await mkdir(join(this.root,'backups'),{recursive:true});
        try {await copyFile(join(this.root,'lab.json'),join(this.root,'backups','lab.pre-sqlite.json'),constants.COPYFILE_EXCL);}
        catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      }
      this.with(db=>db.transaction(()=>{
        this.writeData(db,initial);
        db.query('INSERT INTO metadata(key,value) VALUES(?,?)').run('installationId',crypto.randomUUID());
        db.query('INSERT INTO metadata(key,value) VALUES(?,?)').run('initialized','1');
      })());
    }
    // Older executables must fail clearly instead of using a stale JSON snapshot.
    await writeFile(join(this.root,'lab.json'),JSON.stringify({version:2,database:'desklab.sqlite',note:'Metadata migrated to SQLite. Original JSON is in backups/lab.pre-sqlite.json.'},null,2));
    return this.load();
  }
  private writeData(db:SQLite,data:LabData) {
    db.query('INSERT OR REPLACE INTO settings(id,document) VALUES(1,?)').run(JSON.stringify(data.settings));
    db.query('DELETE FROM machines').run();db.query('DELETE FROM templates').run();
    const machine=db.query('INSERT INTO machines(id,name,state,created_at,document) VALUES(?,?,?,?,?)');
    for(const row of data.machines)machine.run(row.id,row.name,row.state,row.createdAt,JSON.stringify(row));
    const template=db.query('INSERT INTO templates(id,name,created_at,document) VALUES(?,?,?,?)');
    for(const row of data.templates)template.run(row.id,row.name,row.createdAt,JSON.stringify(row));
    db.query("DELETE FROM port_mappings WHERE owner_type='vm' AND owner_id NOT IN (SELECT id FROM machines)").run();
  }
  save(data:LabData){this.with(db=>db.transaction(()=>this.writeData(db,data))());}
  load():LabData {
    return this.with(db=>({version:1,settings:JSON.parse((db.query('SELECT document FROM settings WHERE id=1').get() as {document:string}).document),machines:(db.query('SELECT document FROM machines ORDER BY rowid').all() as {document:string}[]).map(x=>JSON.parse(x.document)),templates:(db.query('SELECT document FROM templates ORDER BY rowid').all() as {document:string}[]).map(x=>JSON.parse(x.document))}));
  }
  get(key:string){return this.with(db=>(db.query('SELECT value FROM metadata WHERE key=?').get(key) as {value:string}|null)?.value);}
  set(key:string,value:string){this.with(db=>db.query('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value));}
}
