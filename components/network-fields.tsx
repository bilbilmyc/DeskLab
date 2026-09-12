'use client';
import type {MachineNetwork} from '@/shared/network';
export function NetworkFields({value,change,disabled=false}: {value:MachineNetwork;change:(value:MachineNetwork)=>void;disabled?:boolean}) {
  return <fieldset className="network-fields"><legend>网络连接</legend>
    <label>连接方式<select aria-label="网络类型" value={value.mode} disabled={disabled} onChange={()=>change({mode:'nat'})}>
      {value.mode==='bridged'&&<option value="bridged" disabled>旧网络配置 · 请切换 NAT</option>}
      <option value="nat">NAT · 内网，通过宿主机上网</option>
    </select></label>
    <p className="field-help">无需安装网络驱动或管理员授权。实例通过宿主机上网，SSH 使用本机 127.0.0.1 和独立端口连接。</p>
    {value.mode==='bridged'&&<p className="notice">当前版本仅支持 NAT，请先正常关机，再切换并保存网络配置。</p>}
  </fieldset>;
}
