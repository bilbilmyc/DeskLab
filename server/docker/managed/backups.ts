import {copyFile,mkdir,cp,rename,rm,stat,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import type {Store} from '../../store';
import {executable,run} from '../../qemu';
import {storedPorts,managementPorts} from '../../ports';
import type {PortMapping} from '../../../shared/ports';
import type {ManagedEngineRecord,EngineBackup} from '../../../shared/docker-managed';
import {ManagedDocker,processAlive} from './engine';
import {fileHash,verifiedEngineAssets} from './assets';
import {relative} from 'node:path';
import {checkedDirectory} from './credentials';

type BackupManifest={version:1;id:string;engineId:string;record:ManagedEngineRecord;engine:Record<string,any>;ports:PortMapping[];projects:Record<string,any>[];files:Record<string,string>};
const items=['system.qcow2','data.qcow2','uefi.fd','credentials'] as const;
async function exists(path:string){return stat(path).then(()=>true).catch(()=>false);}
export class ManagedBackups {
 constructor(private store:Store,private managed:ManagedDocker){}
 private stopped(){const record=this.managed.record();if(!record?.initialized)throw new Error('请先完成引擎初始化');if(record.state!=='stopped'||processAlive(record.pid))throw new Error('备份或恢复前请先正常停止内置引擎');return record;}
 private path(record:ManagedEngineRecord,id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('无效备份 ID');return join(this.managed.directory(record.id),'backups',id);}
 async create(label='手动备份'){
  const record=this.stopped(),id=crypto.randomUUID(),root=this.managed.directory(record.id),directory=this.path(record,id);
  await checkedDirectory(root);
  const required=(await stat(join(root,'system.qcow2'))).size+(await stat(join(root,'data.qcow2'))).size+512*1048576,space=await statfs(root);if(space.bavail*space.bsize<required)throw new Error('剩余空间不足，无法创建完整停机备份');
  await mkdir(directory,{recursive:true});
  try {
   const img=await executable(this.store.data.settings.qemuPath,true);if(!img)throw new Error('QEMU 镜像工具缺失');
   await run(img,['convert','-O','qcow2','-c',join(root,'system.qcow2'),join(directory,'system.qcow2')],600000);
   await copyFile(join(root,'data.qcow2'),join(directory,'data.qcow2'));await copyFile(join(root,'uefi.fd'),join(directory,'uefi.fd'));await cp(join(root,'credentials'),join(directory,'credentials'),{recursive:true});
   const files:Record<string,string>={};let bytes=0;for await(const name of new Bun.Glob('**/*').scan({cwd:directory,onlyFiles:true})){files[name.replaceAll('\\','/')]=await fileHash(join(directory,name));bytes+=(await stat(join(directory,name))).size;}
   const manifest:BackupManifest={version:1,id,engineId:record.id,record,engine:this.store.db.with(db=>db.query('SELECT * FROM docker_engines WHERE id=?').get(record.id) as Record<string,any>),ports:storedPorts(this.store).filter(p=>p.engineId===record.id),projects:this.store.db.with(db=>db.query('SELECT * FROM docker_projects WHERE engine_id=?').all(record.id) as Record<string,any>[]),files};
   await Bun.write(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
   const result:EngineBackup={id,engineId:record.id,createdAt:new Date().toISOString(),bytes,label:label.slice(0,60)};
   this.store.db.with(db=>db.query('INSERT INTO engine_backups(id,engine_id,document) VALUES(?,?,?)').run(id,record.id,JSON.stringify(result)));return result;
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
 }
 private writeMetadata(manifest:BackupManifest,record:ManagedEngineRecord){this.store.db.with(db=>db.transaction(()=>{
  db.query('UPDATE managed_engines SET document=? WHERE id=?').run(JSON.stringify(record),record.id);
  db.query('UPDATE docker_engines SET server_id=? WHERE id=?').run(manifest.engine.server_id,record.id);
  db.query('DELETE FROM docker_resources WHERE engine_id=?').run(record.id);db.query('DELETE FROM port_mappings WHERE engine_id=?').run(record.id);
  const insert=db.query('INSERT INTO port_mappings(id,owner_type,owner_id,engine_id,label,protocol,host_address,host_port,target_port,guest_port,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  for(const p of manifest.ports)insert.run(p.id,'docker',p.ownerId,record.id,p.label,p.protocol,'127.0.0.1',p.hostPort,p.targetPort,p.guestPort??null,p.createdAt);
  db.query('DELETE FROM docker_projects WHERE engine_id=?').run(record.id);const project=db.query('INSERT INTO docker_projects(id,engine_id,name,compose_name,file_path,created_at) VALUES(?,?,?,?,?,?)');for(const p of manifest.projects)project.run(p.id,record.id,p.name,p.compose_name,p.file_path,p.created_at);
 })());}
 async restore(id:string){
  const current=this.stopped();if(!this.store.db.with(db=>db.query('SELECT id FROM engine_backups WHERE id=? AND engine_id=?').get(id,current.id)))throw new Error('备份不存在');
  await checkedDirectory(this.managed.directory(current.id));
  const directory=this.path(current,id),manifest=await Bun.file(join(directory,'manifest.json')).json() as BackupManifest;
  if(manifest.version!==1||manifest.id!==id||manifest.engineId!==current.id||manifest.record.id!==current.id)throw new Error('备份身份不匹配');
  for(const [name,hash]of Object.entries(manifest.files)){if(!/^(system\.qcow2|data\.qcow2|uefi\.fd|credentials\/[a-zA-Z0-9_.-]+)$/.test(name)||await fileHash(join(directory,name))!==hash)throw new Error('备份文件校验失败：'+name);}
  for(const name of ['system.qcow2','data.qcow2','uefi.fd','credentials/identity.json'])if(!manifest.files[name])throw new Error('备份文件不完整');
  const other=storedPorts(this.store).filter(p=>p.engineId!==current.id);
  for(const p of manifest.ports)if(other.some(o=>o.hostPort===p.hostPort&&o.protocol===p.protocol)||this.store.data.machines.some(m=>p.protocol==='tcp'&&m.sshPort===p.hostPort))throw new Error(`备份端口 ${p.hostPort} 已被其他资源预留，未修改数据`);
  const root=this.managed.directory(current.id),generation=crypto.randomUUID(),stage=join(root,'restore-'+generation),previous=join(stage,'previous'),replacement=join(stage,'replacement');await mkdir(previous,{recursive:true});await mkdir(replacement,{recursive:true});
  const space=await statfs(root),required=(await stat(join(directory,'system.qcow2'))).size+(await stat(join(directory,'data.qcow2'))).size+512*1048576;if(space.bavail*space.bsize<required)throw new Error('恢复所需空间不足');
  const journal=join(root,'restore.json');
  try {
   for(const name of items)await cp(join(directory,name),join(replacement,name),{recursive:true});
   await Bun.write(journal,JSON.stringify({generation}));
   for(const name of items){await rename(join(root,name),join(previous,name));await rename(join(replacement,name),join(root,name));}
   const restored={...manifest.record,imagePath:current.imagePath,managementPort:current.managementPort,pid:undefined,qmpPort:undefined,state:'stopped' as const,message:undefined,restoreGeneration:generation,updatedAt:new Date().toISOString()};
   this.writeMetadata(manifest,restored);
   await this.recoverRestore();return {ok:true};
  }catch(error){await this.recoverRestore();if(!await exists(journal))await rm(stage,{recursive:true,force:true});throw error;}
 }
 async rebuild(){
  const record=this.stopped(),assets=await verifiedEngineAssets(),backup=await this.create('引擎更新前自动备份');
  const root=this.managed.directory(record.id),journal=join(root,'upgrade.json'),imageDir=this.store.managed('engines','images',assets.manifest.id),imagePath=join(imageDir,'system.qcow2');await mkdir(imageDir,{recursive:true});
  if(!await exists(imagePath)){await copyFile(join(assets.directory,'system.qcow2'),imagePath+'.partial');if(await fileHash(imagePath+'.partial')!==assets.manifest.files['system.qcow2'])throw new Error('新版系统盘校验失败');await rename(imagePath+'.partial',imagePath);}
  const img=await executable(this.store.data.settings.qemuPath,true);if(!img)throw new Error('QEMU 镜像工具缺失');
  const next=join(root,'system.next.qcow2');await rm(next,{force:true});await run(img,['create','-f','qcow2','-F','qcow2','-b',relative(root,imagePath),next]);
  await Bun.write(journal,JSON.stringify({backupId:backup.id}));
  try {
   await rename(join(root,'system.qcow2'),join(root,'system.before-upgrade.qcow2'));await rename(next,join(root,'system.qcow2'));
   record.imageId=assets.manifest.id;record.imagePath=imagePath;record.credentialsGeneration=undefined;this.managed.save(record);
   await this.managed.start();await this.managed.checked();
   await rm(journal,{force:true});await rm(join(root,'system.before-upgrade.qcow2'),{force:true});return {ok:true};
  }catch(error){await this.recover();throw new Error('引擎更新失败，已恢复更新前备份：'+(error as Error).message);}
 }
 async recover(){
  await this.recoverRestore();const record=this.managed.record();if(!record)return;
  const root=this.managed.directory(record.id),journal=join(root,'upgrade.json');if(!await exists(journal))return;
  const {backupId}=await Bun.file(journal).json();if(typeof backupId!=='string'||!/^[a-f0-9-]{36}$/.test(backupId))throw new Error('引擎更新事务记录无效');
  await this.managed.stop();await this.restore(backupId);await rm(journal,{force:true});await rm(join(root,'system.before-upgrade.qcow2'),{force:true});
 }
 private async recoverRestore(){
  const record=this.managed.record();if(!record)return;const root=this.managed.directory(record.id),journal=join(root,'restore.json');if(!await Bun.file(journal).exists())return;
  await checkedDirectory(root);
  if(processAlive(record.pid))throw new Error('引擎恢复事务未结束，不能接管运行中的磁盘');
  const {generation}=await Bun.file(journal).json();if(typeof generation!=='string'||!/^[a-f0-9-]{36}$/.test(generation))throw new Error('恢复事务记录无效');
  const stage=join(root,'restore-'+generation),previous=join(stage,'previous');
  if(record.restoreGeneration!==generation){for(const name of items){if(await exists(join(previous,name))){await rm(join(root,name),{recursive:true,force:true});await rename(join(previous,name),join(root,name));}}}
  await rm(stage,{recursive:true,force:true});await rm(journal,{force:true});
 }
}
