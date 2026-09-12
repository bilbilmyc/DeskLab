import type {Store} from '../store';
import {qmp} from '../qemu';
import {storedPorts} from '../ports';
import type {ManagedDocker} from './managed/engine';
import type {PortMapping} from '../../shared/ports';
export class PortRouter {
 constructor(private store:Store,private managed:ManagedDocker){}
 guestPorts(count:number){const used=new Set(storedPorts(this.store).filter(p=>p.engineId===this.managed.record()?.id).map(p=>p.guestPort));const result:number[]=[];for(let p=20000;p<=60000&&result.length<count;p++){if(!used.has(p)){used.add(p);result.push(p);}}if(result.length<count)throw new Error('引擎中转端口不足');return result;}
 async contains(p:PortMapping){const record=this.managed.record()!;const info=String(await qmp(record.qmpPort!,'human-monitor-command',{'command-line':'info usernet'}));return info.split('\n').some(line=>{const m=line.match(/^\s*(TCP|UDP)\[HOST_FORWARD\]\s+[0-9a-fA-F]+\s+127\.0\.0\.1\s+(\d+)\s+\S+\s+(\d+)\s/);return m&&m[1].toLowerCase()===p.protocol&&Number(m[2])===p.hostPort&&Number(m[3])===p.guestPort;});}
 async apply(ownerId:string){
  const record=this.managed.record();if(!record||record.state!=='running')throw new Error('独立引擎未运行');await this.managed.verifyProcess(record);
  for(const p of storedPorts(this.store,ownerId).filter(p=>p.engineId===record.id&&p.guestPort)){
   try{
    if(!await this.contains(p)){const reply=await qmp(record.qmpPort!,'human-monitor-command',{'command-line':`hostfwd_add ${p.protocol}:127.0.0.1:${p.hostPort}-:${p.guestPort}`});if(String(reply).trim()||!await this.contains(p))throw new Error('NAT 转发未生效：'+String(reply));}
    this.store.db.with(db=>db.query("UPDATE port_mappings SET applied_state='applied',last_error=NULL WHERE id=?").run(p.id));
   }catch(error){this.store.db.with(db=>db.query("UPDATE port_mappings SET applied_state='error',last_error=? WHERE id=?").run((error as Error).message,p.id));throw error;}
  }
 }
 async detach(ownerId:string){
  const record=this.managed.record();
  const ports=storedPorts(this.store,ownerId).filter(p=>p.engineId===record?.id&&p.guestPort);
  if(record?.pid&&ports.length){await this.managed.verifyProcess(record);for(const p of ports)if(await this.contains(p)){await qmp(record.qmpPort!,'human-monitor-command',{'command-line':`hostfwd_remove ${p.protocol}:127.0.0.1:${p.hostPort}`});if(await this.contains(p))throw new Error('NAT 转发删除未生效，预留已保留');}}
 }
 async release(ownerId:string){
  await this.detach(ownerId);
  this.store.db.with(db=>db.query("DELETE FROM port_mappings WHERE owner_type='docker' AND owner_id=?").run(ownerId));
 }
}
