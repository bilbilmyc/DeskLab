import {z} from 'zod';
import {join} from 'node:path';
import {dockerExecutable,dockerRun,jsonLines} from './cli';
import type {Store} from '../store';
import {portAvailable,storedPorts,managementPorts} from '../ports';
import type {DockerContainer,DockerContext,DockerEngine,DockerImage,DockerProject,DockerSnapshot,Operation} from '../../shared/docker';
import type {PortView} from '../../shared/ports';
import {ManagedDocker} from './managed/engine';
import {PortRouter} from './port-router';
import {ManagedBackups} from './managed/backups';

const ownerLabel='io.desklab.installation';
const imageInput=z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/,'请输入有效的镜像名称');
const published=z.object({hostPort:z.number().int().min(1024).max(65535),targetPort:z.number().int().min(1).max(65535),protocol:z.enum(['tcp','udp']).default('tcp')}).strict();
export const containerInput=z.object({name:z.string().min(1).max(63).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),image:imageInput,ports:z.array(published).max(20).default([]),memoryMB:z.number().int().min(64).max(32768).default(512),cpus:z.number().min(0.1).max(32).default(1),environment:z.array(z.string().max(4096).regex(/^[A-Za-z_][A-Za-z0-9_]*=[^\x00\r\n]*$/)).max(50).default([]),command:z.array(z.string().max(2048).refine(s=>!s.includes('\0'))).max(30).default([])}).strict();
const inspectFormat=`{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"createdAt":{{json .Created}},"owner":{{json (index .Config.Labels "${ownerLabel}")}},"projectId":{{json (index .Config.Labels "io.desklab.project")}},"ports":{{json .HostConfig.PortBindings}}}`;
const engineSelect='id,name,context,endpoint,server_id AS serverId,kind';
const projectSelect='id,engine_id AS engineId,name,compose_name AS composeName,file_path AS filePath,created_at AS createdAt';
export class DockerService {
  private busy=false;
  private cache?:{at:number;snapshot:DockerSnapshot};
  readonly instanceId:string;
  readonly managed:ManagedDocker;
  readonly router:PortRouter;
  readonly backups:ManagedBackups;
  constructor(readonly store:Store) {
    this.managed=new ManagedDocker(store);this.router=new PortRouter(store,this.managed);this.backups=new ManagedBackups(store,this.managed);
    this.instanceId=store.db.get('installationId')!;
    store.db.with(db=>db.query("UPDATE operations SET state='failed',message='程序重启打断了操作，请检查引擎实际状态后重试',updated_at=? WHERE state='running'").run(new Date().toISOString()));
  }
  engine():DockerEngine|undefined {const id=this.store.db.get('docker.selected');return id?this.store.db.with(db=>db.query(`SELECT ${engineSelect} FROM docker_engines WHERE id=?`).get(id) as DockerEngine|null)??undefined:undefined;}
  run(engine:DockerEngine,args:string[],timeout=30000,includeStderr=false){return engine.kind==='managed'?this.managed.raw(args,timeout,includeStderr):dockerRun(['--context',engine.context,...args],timeout,includeStderr);}
  managedAction(action:string,input:unknown={}){
    if(!['enable','start','stop','force-stop','select','backup','restore','rebuild','configure'].includes(action))throw new Error('未知的独立引擎操作');
    return this.operation('独立引擎 '+action,async()=>{
      if(action==='enable'){await this.managed.prepare(input);await this.managed.start();}
      else if(action==='start')await this.managed.start();
      else if(action==='stop')await this.managed.stop();
      else if(action==='force-stop'){z.object({confirm:z.literal(true)}).strict().parse(input);await this.managed.forceStop();}
      else if(action==='backup'){const {label}=z.object({label:z.string().max(60).default('手动备份')}).strict().parse(input);await this.backups.create(label);}
      else if(action==='restore'){const {id}=z.object({id:z.string().uuid()}).strict().parse(input);await this.backups.restore(id);}
      else if(action==='rebuild')await this.backups.rebuild();
      else if(action==='configure')this.managed.configure(input);
      if(['enable','start','select'].includes(action)){const record=this.managed.record();if(!record)throw new Error('请先启用独立引擎');this.store.db.set('docker.selected',record.id);}
      await this.snapshot(true);
    });
  }
  operations():Operation[]{return this.store.db.with(db=>db.query('SELECT id,kind,resource_id AS resourceId,state,message,created_at AS createdAt,updated_at AS updatedAt FROM operations ORDER BY created_at DESC LIMIT 30').all() as Operation[]);}
  projects():DockerProject[]{const engine=this.engine();return engine?this.store.db.with(db=>db.query(`SELECT ${projectSelect} FROM docker_projects WHERE engine_id=? ORDER BY created_at`).all(engine.id) as DockerProject[]):[];}
  async contexts():Promise<DockerContext[]> {
    if(!dockerExecutable())return [];
    return jsonLines<{Name:string;DockerEndpoint:string;Current:boolean}>(await dockerRun(['context','ls','--format','{{json .}}'])).map(x=>({name:x.Name,endpoint:x.DockerEndpoint,current:x.Current}));
  }
  async connect(input:unknown) {
    if(this.busy)throw new Error('请等待当前 Docker 操作完成');
    const {context}=z.object({context:z.string().min(1).max(128)}).strict().parse(input);
    const selected=(await this.contexts()).find(x=>x.name===context);if(!selected)throw new Error('Docker context 不存在');
    const info=JSON.parse(await dockerRun(['context','inspect',context,'--format','{{json .Endpoints.docker}}']));
    if(typeof info.Host!=='string'||!info.Host.startsWith('npipe://'))throw new Error('首版仅支持这台 Windows 上的 Docker named pipe 引擎');
    const server=JSON.parse(await dockerRun(['--context',context,'info','--format','{"id":{{json .ID}},"name":{{json .Name}},"os":{{json .OSType}},"version":{{json .ServerVersion}}}']));
    if(server.os!=='linux')throw new Error('请将 Docker Desktop 切换到 Linux containers');
    let old=this.store.db.with(db=>db.query(`SELECT ${engineSelect} FROM docker_engines WHERE context=?`).get(context) as DockerEngine|null);
    if(old&&old.serverId!==server.id)throw new Error('该 context 指向的引擎身份已改变，请使用新的 context 名称重新连接');
    old??=this.store.db.with(db=>db.query(`SELECT ${engineSelect} FROM docker_engines WHERE server_id=?`).get(server.id) as DockerEngine|null);
    const engine:DockerEngine={id:old?.id??crypto.randomUUID(),name:server.name,context,endpoint:info.Host,serverId:server.id,version:server.version};
    this.store.db.with(db=>db.query('INSERT INTO docker_engines(id,context,name,endpoint,server_id,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET context=excluded.context,name=excluded.name,endpoint=excluded.endpoint').run(engine.id,context,engine.name,engine.endpoint,engine.serverId,new Date().toISOString()));
    this.store.db.set('docker.selected',engine.id);this.cache=undefined;return this.snapshot(true);
  }
  async checkedEngine(startManaged=false,engine=this.engine()) {
    if(!engine)throw new Error('请先连接 Docker 引擎');
    if(engine.kind==='managed'){if(startManaged)await this.managed.start();const info=await this.managed.checked();if(engine.serverId&&engine.serverId!==info.ID)throw new Error('独立 Docker 身份改变，请检查恢复状态');return this.store.db.with(db=>db.query(`SELECT ${engineSelect} FROM docker_engines WHERE id=?`).get(engine.id) as DockerEngine);}
    const endpoint=JSON.parse(await dockerRun(['context','inspect',engine.context,'--format','{{json .Endpoints.docker}}']));
    if(endpoint.Host!==engine.endpoint)throw new Error('Docker context 的地址已改变，请重新连接');
    const info=JSON.parse(await dockerRun(['--context',engine.context,'info','--format','{"id":{{json .ID}},"os":{{json .OSType}}}']));
    if(info.id!==engine.serverId||info.os!=='linux')throw new Error('Docker 引擎身份或类型改变，已停止操作');
    return engine;
  }
  async containers(engine:DockerEngine):Promise<DockerContainer[]> {
    const ids=(await this.run(engine,['ps','-aq','--no-trunc'])).split(/\s+/).filter(Boolean);
    if(ids.length>1000)throw new Error('容器数量超过首版显示上限（1000）');
    const rows:any[]=[];
    for(let i=0;i<ids.length;i+=50)rows.push(...jsonLines<any>(await this.run(engine,['inspect','--format',inspectFormat,...ids.slice(i,i+50)])));
    const reservations=engine.kind==='managed'?storedPorts(this.store).filter(p=>p.engineId===engine.id):[];
    return rows.map(row=>({id:row.id,name:row.name.replace(/^\//,''),image:row.image,state:row.state,owned:row.owner===this.instanceId,projectId:row.projectId||undefined,createdAt:row.createdAt,ports:Object.entries(row.ports??{}).flatMap(([key,bindings])=>(bindings as any[]??[]).flatMap(binding=>{const protocol=key.endsWith('/udp')?'udp' as const:'tcp' as const,guestPort=Number(binding.HostPort),reservation=reservations.find(p=>p.guestPort===guestPort&&p.protocol===protocol);if(engine.kind==='managed'&&!reservation)return [];return [{hostAddress:reservation?'127.0.0.1':binding.HostIp||'0.0.0.0',hostPort:reservation?.hostPort??guestPort,guestPort:reservation?guestPort:undefined,targetPort:Number(key.split('/')[0]),protocol,active:row.state==='running'}];}))}));
  }
  private record(engine:DockerEngine,containers:DockerContainer[]) {
    this.store.db.with(db=>db.transaction(()=>{
      db.query('DELETE FROM docker_resources WHERE engine_id=?').run(engine.id);
      const save=db.query('INSERT INTO docker_resources(engine_id,id,name,image,state,owned,project_id,document,observed_at) VALUES(?,?,?,?,?,?,?,?,?)');
      for(const c of containers)save.run(engine.id,c.id,c.name,c.image,c.state,c.owned?1:0,c.projectId??null,JSON.stringify(c),new Date().toISOString());
    })());
  }
  async snapshot(refresh=false):Promise<DockerSnapshot> {
    if(!refresh&&this.cache&&Date.now()-this.cache.at<2000)return {...this.cache.snapshot,operations:this.operations()};
    const managed=await this.managed.status();
    const result:DockerSnapshot={available:!!dockerExecutable()||managed.available,contexts:[],engine:this.engine(),containers:[],images:[],projects:this.projects(),operations:this.operations(),managed};
    try {
      result.contexts=await this.contexts();
      if(result.engine){
        if(result.engine.kind==='managed'&&managed.engine?.state!=='running'){
          result.containers=this.store.db.with(db=>(db.query('SELECT document FROM docker_resources WHERE engine_id=?').all(result.engine!.id) as {document:string}[]).map(r=>({...JSON.parse(r.document),state:'engine-stopped'})));
        }else{const engine=await this.checkedEngine(false,result.engine);result.containers=await this.containers(engine);this.record(engine,result.containers);result.images=jsonLines<any>(await this.run(engine,['image','ls','--format','{{json .}}'])).map(i=>({id:i.ID,name:`${i.Repository}:${i.Tag}`,size:i.Size}));}
      }
    }catch(e){result.error=(e as Error).message;}
    this.cache={at:Date.now(),snapshot:result};return result;
  }
  mappings():PortView[] {
    const engine=this.engine();if(!engine)return [];
    const rows=this.store.db.with(db=>db.query('SELECT document,observed_at AS observedAt FROM docker_resources WHERE engine_id=?').all(engine.id) as {document:string;observedAt:string}[]);
    const managedState=engine.kind==='managed'?this.managed.record()?.state:undefined,reservations=storedPorts(this.store).filter(p=>p.engineId===engine.id);
    const observed:PortView[]=rows.flatMap(row=>{const c=JSON.parse(row.document) as DockerContainer;return c.ports.map((p,i)=>{const saved=reservations.find(r=>r.hostPort===p.hostPort&&r.protocol===p.protocol);const status:PortView['status']=managedState&&managedState!=='running'?(managedState==='stopped'?'stopped':'unknown'):saved?.lastError||Date.now()-Date.parse(row.observedAt)>15000?'unknown':c.state==='running'?'running':'stopped';return {id:`docker:${c.id}:${i}`,ownerType:'docker',ownerId:c.id,engineId:engine.id,ownerName:c.name,label:saved?.lastError?'端口转发失败：'+saved.lastError:'容器发布端口',protocol:p.protocol,hostAddress:p.hostAddress,hostPort:p.hostPort,targetPort:p.targetPort,guestPort:p.guestPort,createdAt:c.createdAt,source:'docker',status,editable:false};});});
    const planned=storedPorts(this.store).filter(p=>p.ownerType==='docker'&&p.engineId===engine.id&&!observed.some(o=>o.protocol===p.protocol&&o.hostPort===p.hostPort)).map(p=>({...p,ownerName:p.label,label:'预留端口（资源未运行）',source:'docker' as const,status:'stopped' as const,editable:false}));
    return [...observed,...planned];
  }
  operation(kind:string,work:(id:string)=>Promise<unknown>,resourceId?:string) {
    if(this.busy)throw new Error('请等待当前 Docker 操作完成');
    const id=crypto.randomUUID(),now=new Date().toISOString();
    this.store.db.with(db=>db.query('INSERT INTO operations(id,kind,resource_id,state,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,kind,resourceId??null,'running','正在执行',now,now));
    this.busy=true;
    void work(id).then(result=>this.finish(id,'succeeded',typeof result==='string'?result:'操作完成')).catch(e=>this.finish(id,'failed',(e as Error).message)).finally(()=>{this.busy=false;this.cache=undefined;});
    return {id};
  }
  private finish(id:string,state:string,message:string){this.store.db.with(db=>db.query('UPDATE operations SET state=?,message=?,updated_at=? WHERE id=?').run(state,message.slice(0,16000),new Date().toISOString(),id));}
  pull(input:unknown){const {image}=z.object({image:imageInput}).strict().parse(input);return this.operation('拉取镜像',async()=>{const engine=await this.checkedEngine(true);await this.run(engine,['pull',image],600000);});}
  create(input:unknown) {
    const value=containerInput.parse(input);
    return this.operation('创建容器',async operationId=>{
      const engine=await this.checkedEngine(true);
      for(const p of value.ports){if(storedPorts(this.store).some(x=>x.protocol===p.protocol&&x.hostPort===p.hostPort)||p.protocol==='tcp'&&managementPorts(this.store).includes(p.hostPort)||this.store.data.machines.some(vm=>p.protocol==='tcp'&&vm.sshPort===p.hostPort))throw new Error(`端口 ${p.hostPort} 已被 DeskLab 预留`);if(!await portAvailable(p.hostPort,p.protocol))throw new Error(`端口 ${p.hostPort} 已被占用`);}
      const guestPorts=engine.kind==='managed'?this.router.guestPorts(value.ports.length):[];
      this.store.db.with(db=>db.transaction(()=>{const insert=db.query('INSERT INTO port_mappings(id,owner_type,owner_id,engine_id,label,protocol,host_address,host_port,target_port,guest_port,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');value.ports.forEach((p,i)=>insert.run(crypto.randomUUID(),'docker',operationId,engine.id,value.name,p.protocol,'127.0.0.1',p.hostPort,p.targetPort,guestPorts[i]??null,new Date().toISOString()));})());
      let containerId:string|undefined;
      try {
        const args=['container','create','--name',value.name,'--label',`${ownerLabel}=${this.instanceId}`,'--label',`io.desklab.operation=${operationId}`,'--memory',`${value.memoryMB}m`,'--cpus',String(value.cpus),'--restart','no',...value.ports.flatMap((p,i)=>['--publish',`${engine.kind==='managed'?'10.0.2.15':'127.0.0.1'}:${guestPorts[i]??p.hostPort}:${p.targetPort}/${p.protocol}`]),...value.environment.flatMap(e=>['--env',e]),value.image,...value.command];
        containerId=(await this.run(engine,args,600000)).trim();if(!/^[a-f0-9]{64}$/.test(containerId))throw new Error('Docker 未返回有效容器 ID');
        this.store.db.with(db=>db.query('UPDATE port_mappings SET owner_id=? WHERE owner_id=?').run(containerId!,operationId));
        await this.run(engine,['start',containerId]);if(engine.kind==='managed')await this.router.apply(containerId);
      }catch(error){if(!containerId)this.store.db.with(db=>db.query('DELETE FROM port_mappings WHERE owner_id=?').run(operationId));throw error;}
      finally{this.cache=undefined;await this.snapshot(true);}
    });
  }
  private async owned(id:string,start=false) {
    if(!/^[a-f0-9]{64}$/.test(id))throw new Error('无效的容器 ID');
    const engine=await this.checkedEngine(start),container=(await this.containers(engine)).find(c=>c.id===id);
    if(!container?.owned)throw new Error('只允许操作此 DeskLab 创建的容器，已有容器保持只读');
    return {engine,container};
  }
  control(id:string,action:string) {
    if(!['start','stop','restart','delete'].includes(action))throw new Error('不支持的容器操作');
    return this.operation(`容器 ${action}`,async()=>{
      const {engine,container}=await this.owned(id,true);if(container.projectId)throw new Error('此容器由 Compose 管理，请操作对应项目');
      if(action==='delete'&&container.state==='running')throw new Error('请先停止容器，再删除；数据卷会保留');
      await this.run(engine,[action==='delete'?'rm':action,...(action==='stop'||action==='restart'?['--time','20']:[]),id],45000);
      if(action==='delete')await this.router.release(id);
      else if(engine.kind==='managed'&&action!=='stop')await this.router.apply(id);
      this.cache=undefined;await this.snapshot(true);
    },id);
  }
  async logs(id:string){const {engine}=await this.owned(id);return {text:await this.run(engine,['logs','--tail','200',id],30000,true)};}
  exec(id:string,input:unknown){const {command}=z.object({command:z.string().min(1).max(4096)}).strict().parse(input);return this.operation('执行容器命令',async()=>{const {engine}=await this.owned(id);return await this.run(engine,['exec',id,'sh','-lc',command],60000,true)||'命令执行完成';},id);}
  async shutdown() {
    if(this.busy)throw new Error('Docker 操作尚未完成，请等待后再退出');
    this.busy=true;
    try {
      await this.managed.stop();
      if(!this.engine()||this.engine()?.kind==='managed')return;
      let engine:DockerEngine;
      try {engine=await this.checkedEngine();}catch(error){
        const known=this.store.db.with(db=>db.query("SELECT id FROM docker_resources WHERE engine_id=? AND owned=1 AND state IN ('running','paused','restarting') LIMIT 1").get(this.engine()!.id));
        if(known)throw error;return;
      }
      const running=(await this.containers(engine)).filter(c=>c.owned&&['running','paused','restarting'].includes(c.state));
      for(const c of running.filter(c=>c.state==='paused'))await this.run(engine,['unpause',c.id]);
      if(running.length)await this.run(engine,['stop','--time','20',...running.map(c=>c.id)],60000);
      this.record(engine,await this.containers(engine));
    }finally{this.busy=false;this.cache=undefined;}
  }
}
