'use client';
import {useState} from 'react';
import {Monitor,Play,Power,RotateCcw,Trash2,Layers,Disc3,Square,LoaderCircle,MoreHorizontal,ArrowUpRight} from 'lucide-react';
import type {Machine} from '@/shared/types';
import {Modal,OsIcon,Status} from './primitives';

export function MachineList({machines,busy,invoke,confirm,open,connect}:{machines:Machine[];connect:(vm:Machine)=>void;busy:string;invoke:(id:string,operation:string)=>void;confirm:(vm:Machine,operation:string)=>void;open:(vm:Machine)=>void}) {
  const [toolsId,setToolsId]=useState('');
  const tools=machines.find(vm=>vm.id===toolsId);
  const live=(vm:Machine)=>Boolean(vm.session)||['running','starting','stopping'].includes(vm.state);
  const request=(vm:Machine,operation:string)=>{setToolsId('');confirm(vm,operation);};
  return <><div className="machine-list">{machines.map(vm=>{
    const isLive=live(vm),pending=busy.includes(vm.id),installing=!!vm.installation&&vm.installation.phase!=='ready';
    return <article className={`machine-card ${isLive?'is-live':''}`} key={vm.id}>
      <OsIcon family={vm.family}/><div className="machine-identity"><div className="machine-name-line"><h3>{vm.name}</h3><Status state={vm.state}/></div><div className="machine-attributes"><span>{vm.cpus} 核</span><span>{vm.memory/1024} GB 内存</span><span>{vm.diskGB} GB 磁盘</span><span>{vm.templateId?'来自模板':'ISO 安装'}</span></div><small>{vm.network?.mode==='bridged'?'桥接 · 局域网':'NAT · 本机连接'}{vm.session?.sshPort&&<> · <code>127.0.0.1:{vm.session.sshPort}</code></>}</small></div>
      <div className="machine-row-actions"><button className="button secondary compact" onClick={()=>connect(vm)}>连接与网络<ArrowUpRight size={14}/></button>{isLive?<><button className="button primary compact" disabled={vm.state!=='running'||!!busy} onClick={()=>open(vm)}><Monitor size={15}/>打开系统</button><button className="icon-button" disabled={!!busy||vm.state!=='running'} title="正常关机" aria-label={`关闭 ${vm.name}`} onClick={()=>request(vm,'stop')}><Power size={17}/></button></>:<button className="button primary compact" disabled={!!busy} onClick={()=>invoke(vm.id,'start')}>{pending?<LoaderCircle size={15} className="spin"/>:<Play size={15}/>}启动环境</button>}<button className="icon-button" title="更多操作" aria-label={`${vm.name} 更多操作`} onClick={()=>setToolsId(vm.id)}><MoreHorizontal size={19}/></button></div>
      {installing&&<div className="notice machine-inline-message" role="status">{isLive&&<LoaderCircle size={14} className="spin"/>} {vm.installation!.message}</div>}
      {vm.error&&<details className="vm-error machine-inline-message"><summary>查看启动错误</summary><pre>{vm.error}</pre></details>}
    </article>;
  })}</div>{tools&&<Modal title={`${tools.name} · 更多操作`} close={()=>setToolsId('')}><p className="field-help">{live(tools)?'保存模板、恢复和删除前，请先正常关机。':'环境已关闭，可以保存为模板或管理磁盘。'}</p><div className="machine-maintenance">
    <button className="button secondary" disabled={live(tools)||!!busy} onClick={()=>request(tools,'template')}><Layers size={17}/>保存为模板</button>
    <button className="button secondary" disabled={live(tools)||!tools.templateId||!!busy} onClick={()=>request(tools,'reset')}><RotateCcw size={17}/>恢复初始状态</button>
    {tools.isoPath&&<button className="button secondary" disabled={live(tools)||!!busy} onClick={()=>{invoke(tools.id,'eject');setToolsId('');}}><Disc3 size={17}/>弹出 ISO</button>}
    {live(tools)&&<button className="button danger" disabled={!!busy} onClick={()=>request(tools,'force-stop')}><Square size={17}/>强制关闭</button>}
    <button className="button danger" disabled={live(tools)||!!busy} onClick={()=>request(tools,'delete')}><Trash2 size={17}/>删除环境</button>
  </div><p className="machine-id">实例 ID：{tools.id}</p></Modal>}</>;
}
