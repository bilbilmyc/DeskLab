import {z} from 'zod';
import {mkdir,realpath,stat} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {dockerRun} from './cli';
import type {DockerService} from './service';
import type {DockerEngine,DockerProject} from '../../shared/docker';
import {storedPorts,portAvailable,managementPorts} from '../ports';

interface ComposeConfig {services:Record<string,any>;volumes?:Record<string,any>;secrets?:unknown;configs?:unknown;networks?:Record<string,any>;}
export function validateCompose(config:ComposeConfig) {
  if(!config.services||Object.keys(config.services).length===0||Object.keys(config.services).length>20)throw new Error('Compose 需要 1–20 个服务');
  if(config.secrets||config.configs)throw new Error('首版暂不支持 Compose secrets/configs');
  for(const volume of Object.values(config.volumes??{}))if(volume?.external||volume?.driver_opts)throw new Error('首版只支持由项目创建的普通命名卷');
  for(const network of Object.values(config.networks??{}))if(network?.external||network?.driver&&network.driver!=='bridge')throw new Error('首版只支持项目内部默认网络');
  const ports:Array<{service:string;hostPort:number;targetPort:number;protocol:'tcp'|'udp'}>=[];
  for(const [name,service] of Object.entries(config.services)) {
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))throw new Error('无效的 Compose 服务名');
    if(!service.image||service.build)throw new Error(`服务 ${name} 必须使用预构建镜像，暂不支持 build`);
    if(service.privileged||service.devices||service.network_mode||service.pid||service.ipc||service.container_name||service.cap_add||service.volumes_from||service.use_api_socket)throw new Error(`服务 ${name} 包含首版不支持的宿主或特权配置`);
    for(const mount of service.volumes??[])if(mount.type!=='volume'||!mount.source||!(mount.source in (config.volumes??{})))throw new Error(`服务 ${name} 仅支持命名卷，暂不支持宿主目录挂载`);
    for(const port of service.ports??[]) {
      const hostPort=Number(port.published),targetPort=Number(port.target),protocol=port.protocol??'tcp';
      if(!Number.isInteger(hostPort)||hostPort<1024||hostPort>65535||!Number.isInteger(targetPort)||targetPort<1||targetPort>65535||!['tcp','udp'].includes(protocol))throw new Error(`服务 ${name} 的发布端口须为固定单端口（宿主端口至少 1024）`);
      ports.push({service:name,hostPort,targetPort,protocol});
    }
  }
  if(new Set(ports.map(p=>`${p.protocol}:${p.hostPort}`)).size!==ports.length)throw new Error('Compose 中的宿主端口重复');
  return ports;
}
export class ComposeProjects {
  constructor(private docker:DockerService){}
  private project(id:string){const p=this.docker.projects().find(p=>p.id===id);if(!p)throw new Error('当前引擎中没有此项目');return p;}
  private async configuration(project:DockerProject,engine:DockerEngine) {
    const config=JSON.parse(await this.docker.run(engine,['compose','--project-directory',dirname(project.filePath),'-p',project.composeName,'-f',project.filePath,'config','--format','json'])) as ComposeConfig;
    const requested=validateCompose(config),existing=storedPorts(this.docker.store,`project:${project.id}`),allocated=engine.kind==='managed'?this.docker.router.guestPorts(requested.length):[];
    const ports=requested.map((p,i)=>({...p,guestPort:engine.kind==='managed'?(existing.find(old=>old.hostPort===p.hostPort&&old.protocol===p.protocol)?.guestPort??allocated[i]):undefined}));
    // Resolved default names are expected. Explicit shared names are rejected.
    for(const [name,volume] of Object.entries(config.volumes??{}))if(volume?.name&&volume.name!==`${project.composeName}_${name}`)throw new Error('不能接管项目外的数据卷');
    for(const [name,network] of Object.entries(config.networks??{}))if(network?.name&&network.name!==`${project.composeName}_${name}`)throw new Error('不能接管项目外的网络');
    const directory=join(this.docker.store.root,'docker','projects',project.id);await mkdir(directory,{recursive:true});
    const override=join(directory,'desklab.override.yaml');
    const lines=['services:'];
    for(const [name,service] of Object.entries(config.services)) {
      lines.push(`  ${name}:`,'    restart: "no"',`    mem_limit: ${JSON.stringify(service.mem_limit??'512m')}`,`    cpus: ${JSON.stringify(service.cpus??1)}`,'    labels:',`      io.desklab.installation: ${JSON.stringify(this.docker.instanceId)}`,`      io.desklab.project: ${JSON.stringify(project.id)}`);
      const bindings=ports.filter(p=>p.service===name);
      if(bindings.length)lines.push('    ports: !override',...bindings.map(p=>`      - ${JSON.stringify(`${engine.kind==='managed'?'10.0.2.15':'127.0.0.1'}:${p.guestPort??p.hostPort}:${p.targetPort}/${p.protocol}`)}`));
    }
    await Bun.write(override,lines.join('\n')+'\n');
    const args=['compose','--project-directory',dirname(project.filePath),'-p',project.composeName,'-f',project.filePath,'-f',override];
    const final=JSON.parse(await this.docker.run(engine,[...args,'config','--format','json'])) as ComposeConfig;
    validateCompose(final);
    for(const service of Object.values(final.services))for(const p of service.ports??[])if(p.host_ip!==(engine.kind==='managed'?'10.0.2.15':'127.0.0.1'))throw new Error('Compose 未能限制发布地址，请使用支持 !override 的版本');
    return {args,ports};
  }
  async import(input:unknown) {
    const request=z.object({name:z.string().trim().min(1).max(60),filePath:z.string().max(2048)}).strict().parse(input);
    if(!isAbsolute(request.filePath)||!/[.]ya?ml$/i.test(request.filePath))throw new Error('请选择 Compose YAML 文件的完整路径');
    const file=await realpath(request.filePath);if((await stat(file)).size>1024*1024)throw new Error('Compose 文件过大');
    const engine=await this.docker.checkedEngine(true),id=crypto.randomUUID();
    const project:DockerProject={id,engineId:engine.id,name:request.name,filePath:file,composeName:`desklab-${this.docker.instanceId.slice(0,8)}-${id.slice(0,8)}`,createdAt:new Date().toISOString()};
    const {ports}=await this.configuration(project,engine);
    this.docker.store.db.with(db=>db.query('INSERT INTO docker_projects(id,engine_id,name,compose_name,file_path,created_at) VALUES(?,?,?,?,?,?)').run(id,engine.id,request.name,project.composeName,file,project.createdAt));
    return {...project,ports};
  }
  control(id:string,action:string) {
    if(!['up','stop','down','delete'].includes(action))throw new Error('无效的 Compose 操作');
    const project=this.project(id);
    return this.docker.operation(`Compose ${action}`,async()=>{
      const engine=await this.docker.checkedEngine(true);if(engine.id!==project.engineId)throw new Error('当前引擎已改变，请重新操作');const {args,ports}=await this.configuration(project,engine);
      const existing=(await this.docker.containers(engine)).filter(c=>c.projectId===project.id);
      if(action==='delete'&&existing.length)throw new Error('请先移除项目容器，再删除项目记录；数据卷保留');
      if(action==='up') {
        const owner=`project:${id}`;
        for(const p of ports) {
          if(storedPorts(this.docker.store).some(x=>x.ownerId!==owner&&x.protocol===p.protocol&&x.hostPort===p.hostPort)||p.protocol==='tcp'&&managementPorts(this.docker.store).includes(p.hostPort)||this.docker.store.data.machines.some(v=>p.protocol==='tcp'&&v.sshPort===p.hostPort))throw new Error(`端口 ${p.hostPort} 已被预留`);
          const old=storedPorts(this.docker.store,owner).find(x=>x.hostPort===p.hostPort&&x.protocol===p.protocol);
          const forwarded=engine.kind==='managed'&&old?.guestPort&&await this.docker.router.contains(old);
          if(!forwarded&&!existing.some(c=>c.state==='running'&&c.ports.some(x=>x.hostPort===p.hostPort&&x.protocol===p.protocol))&&!await portAvailable(p.hostPort,p.protocol))throw new Error(`端口 ${p.hostPort} 已被占用`);
        }
        if(engine.kind==='managed')await this.docker.router.detach(owner);
        this.docker.store.db.with(db=>db.transaction(()=>{db.query('DELETE FROM port_mappings WHERE owner_id=?').run(owner);const insert=db.query('INSERT INTO port_mappings(id,owner_type,owner_id,engine_id,label,protocol,host_address,host_port,target_port,guest_port,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');for(const p of ports)insert.run(crypto.randomUUID(),'docker',owner,engine.id,`${project.name}/${p.service}`,p.protocol,'127.0.0.1',p.hostPort,p.targetPort,p.guestPort??null,new Date().toISOString());})());
        await this.docker.run(engine,[...args,'up','-d'],600000);
        if(engine.kind==='managed')await this.docker.router.apply(owner);
      }else if(action==='delete'){await this.docker.router.release(`project:${id}`);this.docker.store.db.with(db=>db.query('DELETE FROM docker_projects WHERE id=?').run(id));}
      else await this.docker.run(engine,[...args,action,'--timeout','20'],60000);
      await this.docker.snapshot(true);
    },id);
  }
}
