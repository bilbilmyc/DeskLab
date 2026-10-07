import {z} from 'zod';
import {createSocket} from 'node:dgram';
import {createServer} from 'node:net';
import type {PortMapping,PortView} from '../shared/ports';
import type {Store} from './store';
import type {Lab} from './lab';
import {qmp} from './qemu';
import {sshPortAvailable} from './ssh-network';

export const mappingInput=z.object({ownerId:z.string().uuid(),label:z.string().trim().min(1).max(60),protocol:z.enum(['tcp','udp']).default('tcp'),hostPort:z.number().int().min(1024).max(65535),targetPort:z.number().int().min(1).max(65535)}).strict();
export const portSelect='id,owner_type AS ownerType,owner_id AS ownerId,engine_id AS engineId,label,protocol,host_address AS hostAddress,host_port AS hostPort,target_port AS targetPort,guest_port AS guestPort,applied_state AS appliedState,last_error AS lastError,created_at AS createdAt';
export function storedPorts(store:Store,ownerId?:string):PortMapping[]{return store.db.with(db=>db.query(`SELECT ${portSelect} FROM port_mappings${ownerId?' WHERE owner_id=?':''} ORDER BY created_at`).all(...(ownerId?[ownerId]:[])) as PortMapping[]);}
export function managementPorts(store:Store):number[]{return store.db.with(db=>(db.query('SELECT document FROM managed_engines').all() as {document:string}[]).flatMap(r=>{const v=JSON.parse(r.document);return [v.managementPort,v.qmpPort,v.agentPort].filter((p:unknown)=>typeof p==='number');}));}
// The bind address follows the machine's current lanPublish setting so saved
// mappings keep working after the switch is toggled between launches.
function bindFor(vm?:{network?:{lanPublish?:boolean}}) { return vm?.network?.lanPublish ? '0.0.0.0' : '127.0.0.1'; }
async function hasForward(qmpPort:number,mapping:{protocol:'tcp'|'udp';hostAddress:string;hostPort:number;targetPort:number}) {
  const info=await qmp(qmpPort,'human-monitor-command',{'command-line':'info usernet'});
  if(typeof info!=='string')throw new Error('无法核对虚拟机端口映射');
  return info.split('\n').some(line=>{const match=line.match(/^\s*(TCP|UDP)\[HOST_FORWARD\]\s+[0-9a-fA-F]+\s+(\S+)\s+(\d+)\s+\S+\s+(\d+)\s/);return match&&match[1].toLowerCase()===mapping.protocol&&match[2]===mapping.hostAddress&&Number(match[3])===mapping.hostPort&&Number(match[4])===mapping.targetPort;});
}
export async function portAvailable(port:number,protocol:'tcp'|'udp',lan=false) {
  if(protocol==='tcp'){
    if(!await sshPortAvailable(port))return false;
    // A wildcard bind also conflicts with services bound to a specific address,
    // so LAN-facing mappings must additionally reserve 0.0.0.0.
    if(!lan)return true;
    return new Promise<boolean>(resolve=>{const probe=createServer();probe.once('error',()=>resolve(false));probe.listen(port,'0.0.0.0',()=>probe.close(()=>resolve(true)));});
  }
  return new Promise<boolean>(resolve=>{const socket=createSocket('udp4');socket.once('error',()=>{socket.close();resolve(false);});socket.bind(port,'127.0.0.1',()=>socket.close(()=>resolve(true)));});
}
export class PortMappings {
  constructor(private store:Store,private lab:Lab){}
  list():PortView[] {
    const custom=storedPorts(this.store).filter(p=>p.ownerType==='vm').map(p=>{
      const vm=this.store.data.machines.find(v=>v.id===p.ownerId);
      return {...p,hostAddress:bindFor(vm),ownerName:vm?.name??'未知实例',source:'vm' as const,status:vm?.state==='running'?'running' as const:vm?.state==='stopped'?'stopped' as const:'unknown' as const,editable:true};
    });
    const ssh=this.store.data.machines.filter(vm=>!!vm.sshPort).map(vm=>({id:`ssh:${vm.id}`,ownerType:'vm' as const,ownerId:vm.id,ownerName:vm.name,label:'SSH',protocol:'tcp' as const,hostAddress:'127.0.0.1',hostPort:vm.session?.sshPort??vm.sshPort!,targetPort:22,source:'ssh' as const,status:vm.state==='running'&&vm.session?.sshPort?'running' as const:vm.state==='stopped'?'stopped' as const:'unknown' as const,editable:false,createdAt:vm.createdAt}));
    return [...ssh,...custom];
  }
  async save(input:unknown,id?:string) {
    const value=mappingInput.parse(input),vm=this.store.data.machines.find(vm=>vm.id===value.ownerId);
    if(!vm)throw new Error('实例不存在');
    if(vm.network?.mode==='bridged')throw new Error('请先切换 NAT');
    const old=id?storedPorts(this.store).find(p=>p.id===id&&p.ownerType==='vm'):undefined;
    if(id&&!old)throw new Error('映射不存在');
    if(old&&old.ownerId!==value.ownerId)throw new Error('不能变更映射所属实例');
    // Editing a running endpoint is not atomic in QEMU; require a stopped guest.
    if(id)this.lab.requireStopped(vm.id);
    if(['starting','stopping'].includes(vm.state))throw new Error('请等待实例状态稳定后操作');
    const occupied=storedPorts(this.store).some(p=>p.id!==id&&p.hostPort===value.hostPort&&p.protocol===value.protocol);
    if(occupied||value.protocol==='tcp'&&managementPorts(this.store).includes(value.hostPort)||this.store.data.machines.some(m=>value.protocol==='tcp'&&m.sshPort===value.hostPort))throw new Error('该宿主机端口已被其他映射预留');
    const lan=vm.network?.lanPublish===true;
    if(!await portAvailable(value.hostPort,value.protocol,lan))throw new Error('该宿主机端口正在被其他程序使用');
    const mapping:PortMapping={id:id??crypto.randomUUID(),ownerType:'vm',...value,hostAddress:bindFor(vm),createdAt:old?.createdAt??new Date().toISOString()};
    const runtime=this.lab.runtime.get(vm.id);
    if(runtime){await this.lab.checkedRuntime(vm.id);const reply=await qmp(runtime.qmpPort,'human-monitor-command',{'command-line':`hostfwd_add ${value.protocol}:${mapping.hostAddress}:${value.hostPort}-:${value.targetPort}`});if(String(reply).trim()||!await hasForward(runtime.qmpPort,mapping))throw new Error(`添加端口映射失败：${reply}`);}
    try {
      this.store.db.with(db=>db.query('INSERT INTO port_mappings(id,owner_type,owner_id,label,protocol,host_address,host_port,target_port,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,protocol=excluded.protocol,host_port=excluded.host_port,target_port=excluded.target_port').run(mapping.id,'vm',vm.id,value.label,value.protocol,'127.0.0.1',value.hostPort,value.targetPort,mapping.createdAt));
    }catch(error){if(runtime)await qmp(runtime.qmpPort,'human-monitor-command',{'command-line':`hostfwd_remove ${value.protocol}:${mapping.hostAddress}:${value.hostPort}`});throw error;}
    return mapping;
  }
  async remove(id:string) {
    const mapping=storedPorts(this.store).find(p=>p.id===id&&p.ownerType==='vm');if(!mapping)throw new Error('映射不存在或由系统管理');
    const vm=this.store.data.machines.find(v=>v.id===mapping.ownerId);
    if(vm&&['starting','stopping'].includes(vm.state))throw new Error('请等待实例状态稳定后操作');
    const bind=bindFor(vm);
    const runtime=this.lab.runtime.get(mapping.ownerId);
    if(runtime){await this.lab.checkedRuntime(mapping.ownerId);const reply=await qmp(runtime.qmpPort,'human-monitor-command',{'command-line':`hostfwd_remove ${mapping.protocol}:${bind}:${mapping.hostPort}`});if(await hasForward(runtime.qmpPort,{...mapping,hostAddress:bind}))throw new Error(`移除端口映射失败：${reply}`);}
    try{this.store.db.with(db=>db.query('DELETE FROM port_mappings WHERE id=?').run(id));}
    catch(error){if(runtime)await qmp(runtime.qmpPort,'human-monitor-command',{'command-line':`hostfwd_add ${mapping.protocol}:${bind}:${mapping.hostPort}-${mapping.targetPort}`});throw error;}
    return {ok:true};
  }
}
