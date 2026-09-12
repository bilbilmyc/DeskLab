import type {BridgeAdapter,MachineNetwork,NetworkCapabilities} from '../shared/network';

export async function networkCapabilities(_refresh=false):Promise<NetworkCapabilities> {
  return {adapters:[],message:'当前版本仅支持 NAT，无需安装网络驱动。'};
}
export function networkArguments(network:MachineNetwork|undefined,sshPort?:number,_adapter?:BridgeAdapter,mac?:string,ports:Array<{protocol:'tcp'|'udp';hostPort:number;targetPort:number}>=[]) {
  if(network?.mode==='bridged')throw new Error('桥接功能已停用，请先在连接与网络中切换为 NAT');
  if(mac&&!/^02(?::[a-f0-9]{2}){5}$/.test(mac))throw new Error('无效的虚拟网卡地址');
  const hardware=`model=e1000${mac?`,mac=${mac}`:''}`;
  for(const p of ports)if(!['tcp','udp'].includes(p.protocol)||!Number.isInteger(p.hostPort)||p.hostPort<1024||p.hostPort>65535||!Number.isInteger(p.targetPort)||p.targetPort<1||p.targetPort>65535)throw new Error('无效的端口映射');
  return ['-nic',`user,${hardware}${sshPort?`,hostfwd=tcp:127.0.0.1:${sshPort}-:22`:''}${ports.map(p=>`,hostfwd=${p.protocol}:127.0.0.1:${p.hostPort}-:${p.targetPort}`).join('')}`];
}
