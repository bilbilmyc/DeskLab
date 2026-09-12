import {spawn,type ChildProcess} from 'node:child_process';
import {cpus,freemem} from 'node:os';
import {mkdir,copyFile,stat,rm,readFile,rename,open,statfs} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {z} from 'zod';
import type {Store} from '../../store';
import {executable,freePort,qmp,run} from '../../qemu';
import {uefiDrives} from '../../firmware';
import {qemuValue} from '../../validation';
import {portAvailable,storedPorts} from '../../ports';
import {dockerRun} from '../cli';
import {ensureCredentials,privateDirectory,checkedDirectory} from './credentials';
import {processAlive} from '../../process-lock';
import {createEngineSeed} from './seed';
import {findEngineAssets,verifiedEngineAssets,fileHash} from './assets';
import type {ManagedEngineRecord,ManagedAvailability,EngineBackup} from '../../../shared/docker-managed';
import {guestFilesystems} from './guest-agent';

export const managedInput=z.object({memoryMB:z.number().int().min(1024).max(32768).default(2048),cpus:z.number().int().min(1).max(32).default(2),diskGB:z.number().int().min(16).max(1024).default(64)}).strict();
export {processAlive};
export class ManagedDocker {
 private pending?:Promise<ManagedEngineRecord>;
 private child?:ChildProcess;
 private diskReading?:Promise<number|undefined>;
 private diskStats?:{at:number;free?:number};
 private lastRecovery=0;
 constructor(readonly store:Store){}
 record():ManagedEngineRecord|undefined{return this.store.db.with(db=>{const row=db.query('SELECT document FROM managed_engines LIMIT 1').get() as {document:string}|null;return row?JSON.parse(row.document):undefined;});}
 save(record:ManagedEngineRecord){record.updatedAt=new Date().toISOString();this.store.db.with(db=>db.query('INSERT INTO managed_engines(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(record.id,JSON.stringify(record)));}
 directory(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('无效的引擎 ID');return this.store.managed('engines',id);}
 async status():Promise<ManagedAvailability>{
  let assets;try{assets=await findEngineAssets();}catch(error){return {available:false,error:(error as Error).message,backups:[]};}
  let record=this.record();
  if(record?.state==='error'&&processAlive(record.pid)&&!this.pending&&Date.now()-this.lastRecovery>10000){this.lastRecovery=Date.now();await this.recover();record=this.record();}
  if(record?.pid&&!processAlive(record.pid)){record.pid=undefined;record.qmpPort=undefined;record.state=record.state==='stopping'?'stopped':'error';record.message=record.state==='error'?'引擎进程已退出，可以检查日志后重新启动':undefined;this.save(record);}
  const backups=this.store.db.with(db=>(db.query('SELECT document FROM engine_backups ORDER BY rowid DESC').all() as {document:string}[]).map(r=>JSON.parse(r.document) as EngineBackup));
  let diskFreeBytes:number|undefined;
  if(record?.state==='running'&&record.agentPort){if(!this.diskStats||Date.now()-this.diskStats.at>10000){this.diskReading??=guestFilesystems(record.agentPort).then(rows=>{const fs=rows.find(r=>r.mountpoint==='/mnt/desklab-data');return fs&&fs['total-bytes']!==undefined&&fs['used-bytes']!==undefined?fs['total-bytes']-fs['used-bytes']:undefined;}).catch(()=>undefined).finally(()=>{this.diskReading=undefined;});this.diskStats={at:Date.now(),free:await this.diskReading};}diskFreeBytes=this.diskStats.free;}
  return {available:!!assets,imageId:assets?.manifest.id,engine:record?{...record,directory:this.directory(record.id),diskFreeBytes,imageAvailable:await Bun.file(record.imagePath).exists(),diskBytes:await stat(join(this.directory(record.id),'data.qcow2')).then(s=>s.size).catch(()=>undefined)}:undefined,backups};
 }
 async verifyProcess(record:ManagedEngineRecord){
  if(!processAlive(record.pid)||!record.qmpPort)throw new Error('独立引擎没有运行');
  const name=await qmp(record.qmpPort,'query-name') as {name?:string};if(name.name!==`DeskLab-Engine-${record.id}`)throw new Error('独立引擎进程身份不符，已停止操作');
 }
 async raw(args:string[],timeout=30000,includeStderr=false){
  const record=this.record();if(!record?.managementPort)throw new Error('请先初始化独立引擎');
  const assets=await findEngineAssets();if(!assets)throw new Error('独立 Docker 客户端组件缺失');
  const directory=this.directory(record.id),credentials=join(directory,'credentials'),config=join(directory,'client');await mkdir(config,{recursive:true});
  await Bun.write(join(config,'config.json'),JSON.stringify({cliPluginsExtraDirs:[join(assets.directory,'tools','cli-plugins')]}));
  return dockerRun(['--config',config,'--host',`tcp://127.0.0.1:${record.managementPort}`,'--tlsverify','--tlscacert',join(credentials,'ca.pem'),'--tlscert',join(credentials,'client.pem'),'--tlskey',join(credentials,'client-key.pem'),...args],timeout,includeStderr,{executable:join(assets.directory,'tools','docker.exe'),env:{DOCKER_CONFIG:config}});
 }
 async checked(){
  const record=this.record();if(!record||record.state!=='running')throw new Error('独立引擎已停止，请先启动');await this.verifyProcess(record);
  const info=JSON.parse(await this.raw(['info','--format','{{json .}}']));
  if(info.OSType!=='linux'||!info.Labels?.includes(`io.desklab.engine=${record.id}`)||!info.Labels?.includes(`io.desklab.data=${record.dataId}`))throw new Error('独立引擎或数据盘身份不符');return info;
 }
 async prepare(input:unknown){
  const previous=this.record();if(previous){if(previous.initialized||processAlive(previous.pid))throw new Error('独立引擎已经初始化');await verifiedEngineAssets();await this.prepareDisks(previous);return previous;}
  const values=managedInput.parse(input),assets=await verifiedEngineAssets();
  if(values.cpus>cpus().length)throw new Error('分配 CPU 超过本机核心数');
  const space=await statfs(this.store.root);if(space.bavail*space.bsize<4*1024**3)throw new Error('数据目录剩余空间不足 4 GB');
  const id=crypto.randomUUID(),directory=this.directory(id),createdAt=new Date().toISOString();await privateDirectory(directory);
  const imageDir=this.store.managed('engines','images',assets.manifest.id);await mkdir(imageDir,{recursive:true});const imagePath=join(imageDir,'system.qcow2');
  if(!await Bun.file(imagePath).exists()){await copyFile(join(assets.directory,'system.qcow2'),imagePath+'.partial');if(await fileHash(imagePath+'.partial')!==assets.manifest.files['system.qcow2'])throw new Error('引擎系统盘复制校验失败');await rename(imagePath+'.partial',imagePath);}
  const record:ManagedEngineRecord={id,imageId:assets.manifest.id,imagePath,...values,dataId:crypto.randomUUID(),state:'preparing',initialized:false,createdAt,updatedAt:createdAt};
  this.store.db.with(db=>db.transaction(()=>{db.query('INSERT INTO docker_engines(id,context,name,endpoint,server_id,created_at,kind) VALUES(?,?,?,?,?,?,?)').run(id,'desklab-managed-'+id,'DeskLab 内置引擎','','',createdAt,'managed');db.query('INSERT INTO managed_engines(id,document) VALUES(?,?)').run(id,JSON.stringify(record));})());
  try {
   await this.prepareDisks(record);return record;
  }catch(error){record.state='error';record.message=(error as Error).message;this.save(record);throw error;}
 }
 private async prepareDisks(record:ManagedEngineRecord){
  const img=await executable(this.store.data.settings.qemuPath,true);if(!img)throw new Error('QEMU 镜像工具缺失');const directory=this.directory(record.id);
  await checkedDirectory(directory);
  if(!await Bun.file(join(directory,'system.qcow2')).exists())await run(img,['create','-f','qcow2','-F','qcow2','-b',relative(directory,record.imagePath),join(directory,'system.qcow2')]);
  if(!await Bun.file(join(directory,'data.qcow2')).exists())await run(img,['create','-f','qcow2',join(directory,'data.qcow2'),`${record.diskGB}G`]);
  await ensureCredentials(join(directory,'credentials'),record.id);record.state='stopped';record.message=undefined;this.save(record);this.store.db.set('docker.selected',record.id);
 }
 configure(input:unknown){const record=this.record();if(!record||record.state!=='stopped'||processAlive(record.pid))throw new Error('调整资源前请先正常停止引擎');const values=z.object({cpus:z.number().int().min(1).max(Math.min(cpus().length,32)),memoryMB:z.number().int().min(1024).max(32768)}).strict().parse(input);Object.assign(record,values);this.save(record);return record;}
 async start(){if(this.pending)return this.pending;this.pending=this.startOnce().finally(()=>{this.pending=undefined;});return this.pending;}
 private async startOnce(){
  let record=this.record();if(!record)throw new Error('请先启用独立引擎');
  if(!record.pid&&record.qmpPort){await this.recover();record=this.record()!;}
  if(processAlive(record.pid)){await this.verifyProcess(record);if(record.state==='running'){await this.checked();return record;}throw new Error('引擎仍在运行或等待恢复，请先停止后重试');}
  if(record.pid){record.pid=undefined;record.qmpPort=undefined;}
  const directory=this.directory(record.id),qemu=await executable(this.store.data.settings.qemuPath);if(!qemu)throw new Error('QEMU 引擎缺失');
  await checkedDirectory(directory);
  if(this.store.data.settings.accelerator!=='whpx')throw new Error('独立 Docker 引擎需要启用 Windows WHPX 硬件加速');
  if(record.memoryMB*1048576>freemem()*0.85)throw new Error('本机当前可用内存不足，请先释放内存');
  if(!await Bun.file(join(directory,'data.qcow2')).exists()||!await Bun.file(join(directory,'system.qcow2')).exists())throw new Error('独立引擎磁盘缺失，请恢复备份');
  const assets=await verifiedEngineAssets();
  const credentials=await ensureCredentials(join(directory,'credentials'),record.id);
  const bindings=storedPorts(this.store).filter(p=>p.engineId===record!.id&&p.ownerType==='docker');
  for(const p of bindings){if(!Number.isInteger(p.guestPort)||p.guestPort!<1024||p.guestPort!>65535)throw new Error('引擎中转端口记录无效');if(!await portAvailable(p.hostPort,p.protocol))throw new Error(`映射端口 ${p.hostPort} 已被占用`);}
  if(record.managementPort&&!await portAvailable(record.managementPort,'tcp'))throw new Error('独立引擎的本机管理端口被占用');
  const reserved=new Set([...storedPorts(this.store).filter(p=>p.protocol==='tcp').map(p=>p.hostPort),...this.store.data.machines.flatMap(m=>m.sshPort?[m.sshPort]:[])]);
  const allocate=async()=>{for(let i=0;i<50;i++){const p=await freePort();if(!reserved.has(p)){reserved.add(p);return p;}}throw new Error('无法分配引擎管理端口');};
  record.managementPort??=await allocate();reserved.add(record.managementPort);record.qmpPort=await allocate();record.agentPort=await allocate();
  const seed=join(directory,'credentials','seed.iso'),needsSeed=!record.initialized||record.credentialsGeneration!==credentials.generation;
  if(needsSeed){await rm(seed,{force:true});await createEngineSeed(seed,record.id,record.dataId,credentials,!record.initialized);}
  record.credentialsGeneration=credentials.generation;record.certificateFingerprint=credentials.fingerprint;record.certificateExpiresAt=credentials.expiresAt;record.state='starting';record.message='正在启动专属 Linux 和 Docker';this.save(record);
  this.store.db.with(db=>db.query('UPDATE docker_engines SET endpoint=? WHERE id=?').run(`tcp://127.0.0.1:${record!.managementPort}`,record!.id));
  const network=`user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${record.managementPort}-:2376${bindings.map(p=>`,hostfwd=${p.protocol}:127.0.0.1:${p.hostPort}-:${p.guestPort??p.hostPort}`).join('')}`;
  const serial=join(directory,'serial.log'),errorLog=join(directory,'qemu.log');for(const file of [serial,errorLog])if(await Bun.file(file).exists())await rename(file,file+'.previous').catch(()=>{});
  const args=['-name',`DeskLab-Engine-${record.id}`,'-machine','q35','-accel','whpx','-cpu','max','-m',String(record.memoryMB),'-smp',String(record.cpus),...await uefiDrives(qemu,join(directory,'uefi.fd')),
   '-drive',`file=${qemuValue(join(directory,'system.qcow2'))},format=qcow2,if=virtio`,
   '-drive',`file=${qemuValue(join(directory,'data.qcow2'))},format=qcow2,if=none,id=engine-data`,'-device','virtio-blk-pci,drive=engine-data,serial=desklab-data',
   '-nic',network,'-display','none','-serial',`file:${serial}`,'-qmp',`tcp:127.0.0.1:${record.qmpPort},server=on,wait=off`,'-pidfile',join(directory,'qemu.pid'),'-S',
   '-chardev',`socket,host=127.0.0.1,port=${record.agentPort},server=on,wait=off,id=qga`,'-device','virtio-serial','-device','virtserialport,chardev=qga,name=org.qemu.guest_agent.0'];
  if(needsSeed)args.push('-drive',`file=${qemuValue(seed)},format=raw,if=virtio,readonly=on`,'-smbios','type=1,serial=ds=nocloud');
  const logFd=openSync(errorLog,'a');let child:ChildProcess;try{child=spawn(qemu,args,{cwd:dirname(qemu),windowsHide:true,stdio:['ignore',logFd,logFd]});}finally{closeSync(logFd);}
  this.child=child;record.pid=child.pid;
  let spawnError:Error|undefined;child.on('error',e=>{spawnError=e;});
  // Guest CPUs remain paused until the PID is committed. A failed metadata write
  // can safely discard this unstarted process without interrupting a guest write.
  try{this.save(record);}catch(error){await qmp(record.qmpPort!,'quit').catch(()=>child.kill());throw error;}
  child.on('close',()=>{const current=this.record();if(!current||current.pid!==child.pid)return;current.pid=undefined;current.qmpPort=undefined;current.state=current.state==='stopping'?'stopped':'error';current.message=current.state==='error'?'独立引擎进程已退出，请检查引擎日志':undefined;this.save(current);});
  try {
   let monitorReady=false;for(let i=0;i<50;i++){if(spawnError)throw spawnError;try{await this.verifyProcess(record);monitorReady=true;break;}catch{}await Bun.sleep(100);}if(!monitorReady)throw new Error('独立引擎 QMP 启动失败');await qmp(record.qmpPort!,'cont');
   const deadline=Date.now()+180000;
   while(Date.now()<deadline){
    if(spawnError)throw spawnError;if(child.exitCode!==null)throw new Error('独立引擎启动失败：'+await this.logs());
    try{
     await this.verifyProcess(record);const info=JSON.parse(await this.raw(['info','--format','{{json .}}'],5000));
     if(info.OSType==='linux'&&info.Labels?.includes(`io.desklab.engine=${record.id}`)&&info.Labels?.includes(`io.desklab.data=${record.dataId}`)){
      record.state='running';record.message=undefined;record.initialized=true;this.save(record);this.store.db.with(db=>db.transaction(()=>{db.query('UPDATE docker_engines SET server_id=? WHERE id=?').run(info.ID,record!.id);db.query("UPDATE port_mappings SET applied_state='applied',last_error=NULL WHERE engine_id=?").run(record!.id);})());return record;
     }
    }catch{}
    await Bun.sleep(1000);
   }
   throw new Error('Linux/Docker 启动超时，请检查引擎日志；数据盘会保留');
  }catch(error){const current=this.record()!;current.state='error';current.message=(error as Error).message;this.save(current);throw error;}
 }
 async stop(){
  const record=this.record();if(!record)return;if(this.pending)throw new Error('引擎仍在启动，请等待启动结束');
  if(!processAlive(record.pid)){record.state='stopped';record.pid=undefined;record.qmpPort=undefined;record.message=undefined;this.save(record);return;}
  await this.verifyProcess(record);record.state='stopping';record.message='正在停止容器并正常关闭专属 Linux';this.save(record);
  try {
   // This VM is exclusively owned by DeskLab; stop all of its workloads before ACPI.
   let ids:string[]=[];
   try{ids=(await this.raw(['ps','-q'],10000)).split(/\s+/).filter(Boolean);}catch{}
   if(ids.length)await this.raw(['stop','--time','20',...ids],60000);
   await qmp(record.qmpPort!,'system_powerdown');
   for(let i=0;i<120&&processAlive(record.pid);i++)await Bun.sleep(1000);
   if(processAlive(record.pid))throw new Error('引擎仍在等待正常关机，请继续等待或查看日志');
   record.state='stopped';record.pid=undefined;record.qmpPort=undefined;record.message=undefined;this.save(record);if(record.initialized)await rm(join(this.directory(record.id),'credentials','seed.iso'),{force:true});
  }catch(error){record.state='error';record.message=(error as Error).message;this.save(record);throw error;}
 }
 async forceStop(){const record=this.record();if(!record?.pid)return;if(this.pending)throw new Error('请等待启动操作结束');await this.verifyProcess(record);record.state='stopping';this.save(record);await qmp(record.qmpPort!,'quit').catch(()=>{});for(let i=0;i<50&&processAlive(record.pid);i++)await Bun.sleep(100);if(processAlive(record.pid))throw new Error('引擎未退出，已保留进程记录');record.pid=undefined;record.qmpPort=undefined;record.state='stopped';record.message='上次使用了强制停止，建议检查容器数据';this.save(record);}
 async recover(){
  const record=this.record();if(!record)return;
  if(!record.pid&&record.qmpPort){const candidate=Number(await readFile(join(this.directory(record.id),'qemu.pid'),'utf8').catch(()=>''));if(Number.isInteger(candidate)&&candidate>0)record.pid=candidate;}
  if(!processAlive(record.pid)){record.pid=undefined;record.qmpPort=undefined;if(record.state!=='stopped'){record.state='error';record.message='上次运行被中断，可以检查数据后重新启动';}this.save(record);return;}
  try{await this.verifyProcess(record);const status=await qmp(record.qmpPort!,'query-status') as {status:string};if(status.status==='prelaunch'){this.save(record);await qmp(record.qmpPort!,'cont');}record.state='running';this.save(record);await this.checked();record.initialized=true;record.message=undefined;this.save(record);}catch(error){record.state='error';record.message=(error as Error).message;this.save(record);}
 }
 async logs(){const record=this.record();if(!record)return '尚未初始化引擎';const chunks:string[]=[];for(const name of ['qemu.log','serial.log']){const path=join(this.directory(record.id),name);try{const fd=await open(path,'r');try{const s=await fd.stat(),buf=Buffer.alloc(Math.min(s.size,24000));await fd.read(buf,0,buf.length,Math.max(0,s.size-buf.length));chunks.push(name+'\n'+buf.toString());}finally{await fd.close();}}catch{}}return chunks.join('\n');}
}
