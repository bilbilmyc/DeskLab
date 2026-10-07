'use client';
import type {MachineNetwork} from '@/shared/network';
export function NetworkFields({value,change,disabled=false}: {value:MachineNetwork;change:(value:MachineNetwork)=>void;disabled?:boolean}) {
  return <fieldset className="network-fields"><legend>网络连接</legend>
    <label>连接方式<select aria-label="网络类型" value={value.mode} disabled={disabled} onChange={()=>change({mode:'nat'})}>
      {value.mode==='bridged'&&<option value="bridged" disabled>旧网络配置 · 请切换 NAT</option>}
      <option value="nat">NAT · 内网，通过宿主机上网</option>
    </select></label>
    {value.mode!=='bridged'&&<label className="lan-publish"><input type="checkbox" disabled={disabled} checked={value.lanPublish===true} onChange={e=>change({...value,mode:'nat',lanPublish:e.target.checked})}/>允许局域网访问端口映射</label>}
    <p className="field-help">无需安装网络驱动或管理员授权。实例通过宿主机上网，SSH 使用本机 127.0.0.1 和独立端口连接。</p>
    {value.lanPublish&&<p className="notice">此实例的自定义端口映射将绑定 0.0.0.0，局域网设备可直接访问映射的服务；SSH 连接仍仅限本机。首次启动监听时，Windows 可能弹出防火墙提示，选择“允许”或由管理员为虚拟化程序放行。变更此开关需先正常关机。</p>}
    {value.mode==='bridged'&&<p className="notice">当前版本仅支持 NAT，请先正常关机，再切换并保存网络配置。</p>}
  </fieldset>;
}
