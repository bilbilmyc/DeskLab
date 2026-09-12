'use client';
import { useState } from 'react';
import { ArrowRight, Check, Download, Info, Pencil, Plus, Trash2, LoaderCircle, Monitor, Terminal, Search } from 'lucide-react';
import type { BuiltinTemplate, Family, LabSnapshot, Template } from '@/shared/types';
import { Empty, Modal, OsIcon } from './primitives';
import type { PickImage } from './image-path';
import { TemplateImport } from './template-import';
import { TemplateFields, templateFields } from './template-fields';

type TemplateDetail = {kind:'builtin'|'custom';id:string};
function TemplateCard({name,description,family,memory,cpus,diskGB,subtitle,ready,status,action,busy,open,details}: {
  name:string;description:string;family:Family;memory:number;cpus:number;diskGB:number;subtitle:string;
  ready:boolean;status:string;action:string;busy:boolean;open:()=>void;details:()=>void;
}) {
  return <article className="tpl-card">
    <div className="tpl-card-head"><OsIcon family={family}/><span className={`tpl-badge ${ready?'tpl-badge-ready':'tpl-badge-pending'}`}>{ready&&<Check size={12}/>} {status}</span></div>
    <div className="tpl-card-copy"><h3>{name}</h3><p>{description}</p></div>
    <div className="tpl-card-specs"><span>{subtitle}</span><span>{cpus} 核 · {memory/1024} GB 内存</span><span>{diskGB} GB 磁盘</span></div>
    <footer className="tpl-card-actions"><button className={`button ${ready?'primary':'secondary'}`} disabled={busy} onClick={open}>{action}<ArrowRight size={15}/></button><button className="text-button tpl-details-button" aria-label={`查看 ${name} 详情`} onClick={details}><Info size={15}/>详情</button></footer>
  </article>;
}

export function TemplateLibrary({data, create, createISO, manageImages, showMachines, remove, update, importing, importImage, pickImage, initialGroup='builtin'}: {data:LabSnapshot;create:(templateId?:string,customizing?:boolean)=>void;createISO:(path?:string,family?:Family)=>void;manageImages:()=>void;showMachines:()=>void;remove:(template:Template)=>void;update:(id:string,value:unknown)=>Promise<unknown>;importing:boolean;importImage:(value:unknown)=>Promise<unknown>;pickImage:PickImage;initialGroup?:'builtin'|'custom'}) {
  const [group,setGroup]=useState(initialGroup),[importingTemplate,setImportingTemplate]=useState<BuiltinTemplate | 'custom' | null>(null),[editing,setEditing]=useState<Template | null>(null),[error,setError]=useState('');
  const [query,setQuery]=useState(''),[readiness,setReadiness]=useState('all');
  const [detail,setDetail]=useState<TemplateDetail | null>(null);
  const allCatalogue=data.catalogue??[],allCustoms=data.templates.filter(t=>!t.builtinId);
  const matches=(name:string)=>name.toLowerCase().includes(query.trim().toLowerCase());
  const catalogue=allCatalogue.filter(t=>matches(t.name)&&(readiness==='all'||!!t.templateId)),customs=allCustoms.filter(t=>matches(t.name));
  const extra=catalogue.filter(t=>t.interface==='desktop'&&t.family!=='windows');
  const selectedBuiltin=detail?.kind==='builtin'?allCatalogue.find(t=>t.id===detail.id):undefined;
  const selectedCustom=detail?.kind==='custom'?allCustoms.find(t=>t.id===detail.id):undefined;
  const selected=selectedBuiltin ?? selectedCustom;
  const installed=selectedBuiltin?data.templates.find(t=>t.id===selectedBuiltin.templateId):selectedCustom;
  const selectedIso=data.isoLibrary?.resources.find(item=>item.id===selectedBuiltin?.id);
  const builtinAction=(t:BuiltinTemplate)=>{const iso=data.isoLibrary?.resources.find(item=>item.id===t.id);setDetail(null);if(t.templateId)create(t.templateId);else if(t.autoInstall)create(t.id);else if(iso?.isoPath)createISO(iso.isoPath,t.family);else manageImages();};
  const builtins=(items:BuiltinTemplate[])=>items.map(t=>{
    const iso=data.isoLibrary?.resources.find(item=>item.id===t.id);
    return <TemplateCard key={t.id} name={t.name} description={t.description} family={t.family} memory={t.memory} cpus={t.cpus} diskGB={data.templates.find(saved=>saved.id===t.templateId)?.diskGB??t.diskGB} subtitle={t.interface==='terminal'?'终端版':'桌面版'} ready={!!t.templateId} status={t.templateId?'已准备好':t.autoInstall?'支持自动安装':iso?.isoPath?'已有 ISO · 待安装':'待准备'} action={t.templateId?'创建环境':t.autoInstall?(iso?.isoPath?'自动安装系统':'选择 ISO 并安装'):iso?.isoPath?'启动安装':'查找或下载 ISO'} busy={importing} open={()=>builtinAction(t)} details={()=>setDetail({kind:'builtin',id:t.id})}/>;
  });
  return <section className="tpl-workspace">
    <div className="tpl-toolbar"><div className="segmented" aria-label="模板来源"><button className={group==='builtin'?'selected':''} aria-pressed={group==='builtin'} onClick={()=>{setGroup('builtin');setQuery('');setReadiness('all');}}>系统自带 <span>{allCatalogue.length}</span></button><button className={group==='custom'?'selected':''} aria-pressed={group==='custom'} onClick={()=>{setGroup('custom');setQuery('');setReadiness('all');}}>我的模板 <span>{allCustoms.length}</span></button></div><button className="button secondary" disabled={importing} onClick={()=>setImportingTemplate('custom')}><Download size={16}/>导入磁盘镜像</button></div>
    <div className="workspace-filter-bar"><label className="search"><Search size={15}/><input aria-label="搜索模板" type="search" placeholder="搜索系统或模板名称…" value={query} onChange={e=>setQuery(e.target.value)}/></label>{group==='builtin'&&<select aria-label="筛选模板状态" value={readiness} onChange={e=>setReadiness(e.target.value)}><option value="all">全部状态</option><option value="ready">已准备好</option></select>}<span>{group==='builtin'?'创建前可调整 CPU、内存和磁盘':'复用系统、软件和配置'}</span></div>
    <div className="workspace-scroll tpl-results" role="region" aria-label="模板列表" tabIndex={0}>
    {group==='builtin' ? <>
      <div className="tpl-section-heading"><h2>选一个系统，直接开始</h2><p>每次创建都是独立环境，可以放心测试。</p></div>

      {catalogue.length?<div className="tpl-grid">{builtins(catalogue.filter(t=>!extra.includes(t)))}</div>:<Empty title="没有匹配的模板" description="试试其他名称，或切换为全部状态。"><button className="text-button" onClick={()=>{setQuery('');setReadiness('all');}}>清除筛选</button></Empty>}
      {extra.length>0 && <details className="tpl-extra" open={!!query.trim()||readiness==='ready'}><summary>其他 Linux 桌面模板 <span>{extra.length}</span></summary><div className="tpl-grid">{builtins(extra)}</div></details>}
    </> : <>
      <div className="tpl-section-heading"><h2>自己的配置，随时复用</h2><p>点击“创建环境”使用模板；在“详情”中查看登录方式和修改设置。</p></div>
      {customs.length ? <div className="tpl-grid">{customs.map(t=><TemplateCard key={t.id} name={t.name} description={t.description || '保留保存时的系统、软件和文件。'} family={t.family} memory={t.memory ?? 2048} cpus={t.cpus ?? 2} diskGB={t.diskGB} subtitle="自定义模板" ready status="我的模板" action="创建环境" busy={importing} open={()=>create(t.id)} details={()=>setDetail({kind:'custom',id:t.id})}/>)}</div> : allCustoms.length?<Empty title="没有匹配的模板" description="试试其他名称。"><button className="text-button" onClick={()=>setQuery('')}>清除筛选</button></Empty>:<Empty title="还没有自己的模板" description="在环境里装好软件，正常关机后点击“保存为模板”。也可以导入已有的系统磁盘。"><button className="button primary" onClick={()=>setGroup('builtin')}><Plus size={16}/>先选一个系统</button><button className="button secondary" onClick={showMachines}>查看已有环境</button></Empty>}
      <ol className="tpl-howto"><li><span>1</span>创建环境</li><li><span>2</span>安装软件并关机</li><li><span>3</span>保存为模板</li></ol>
    </>}
      {catalogue.some(t=>!t.templateId) && <details className="workspace-guide tpl-resource-notice"><summary>模板与 ISO 有什么区别？</summary><p>已准备好的模板可直接创建环境。待准备的系统需要对应 ISO 完成安装，之后可以保存为模板复用。</p></details>}
    <div className="tpl-iso-entry"><div><strong>想从头安装一个系统？</strong><p>安装完成后，也能保存为自己的模板。</p></div><button className="text-button" disabled={importing} onClick={()=>createISO()}>从 ISO 安装 <ArrowRight size={15}/></button></div>
    </div>
    {selected && <Modal title={selected.name} description={selectedBuiltin?'系统自带模板 · 登录与使用说明':'我的模板 · 登录说明与设置'} close={()=>setDetail(null)}>
      <div className="tpl-detail-intro"><OsIcon family={selected.family}/><p>{selected.description || '保留保存时的系统、软件和文件。'}</p></div>
      <div className="tpl-detail-specs">{selectedBuiltin&&<span>{selectedBuiltin.interface==='terminal'?<Terminal size={15}/>:<Monitor size={15}/>} {selectedBuiltin.interface==='terminal'?'终端版':'桌面版'}</span>}<span>{selected.cpus ?? 2} 核处理器</span><span>{(selected.memory ?? 2048)/1024} GB 内存</span><span>{installed?.diskGB??selected.diskGB} GB 磁盘</span></div>
      <section className="tpl-detail-section"><h3>如何进入系统？</h3><p className="login-hint">{installed?.loginHint || (selectedBuiltin?.autoInstall?`自动安装完成后：${selectedBuiltin.loginHint}`:selectedBuiltin&&!selectedBuiltin.templateId?'使用 ISO 安装后，请自行设置系统账号；正常关机后可保存为自己的模板。':'使用保存模板时的系统账号登录。')}</p></section>
      <section className="tpl-detail-section"><h3>{selectedBuiltin?'想预装自己的软件？':'管理这个模板'}</h3><p>{selectedBuiltin?'创建一个副本，装好软件并正常关机，再保存为自己的模板。':'修改说明和默认资源不会影响已创建的环境。要更改软件，请先创建副本。'}</p><div className="tpl-detail-tools">
        {selectedBuiltin?.templateId && <button className="button secondary" disabled={importing} onClick={()=>{setDetail(null);create(selectedBuiltin.templateId,true);}}>基于此模板自定义 <ArrowRight size={15}/></button>}
        {selectedBuiltin&&!selectedBuiltin.templateId && <button className="button secondary" disabled={importing} onClick={()=>{setDetail(null);setImportingTemplate(selectedBuiltin);}}><Download size={15}/>导入已安装的系统磁盘</button>}
        {selectedCustom && <><button className="button secondary" disabled={importing} onClick={()=>{setDetail(null);setEditing(selectedCustom);setError('');}}><Pencil size={15}/>编辑模板信息</button><button className="text-button" disabled={importing} onClick={()=>{setDetail(null);create(selectedCustom.id,true);}}>创建副本并修改软件 <ArrowRight size={14}/></button></>}
      </div></section>
      {selectedCustom&&<button className="text-button tpl-delete" disabled={importing} onClick={()=>{setDetail(null);remove(selectedCustom);}}><Trash2 size={14}/>删除这个模板</button>}
      <footer className="modal-foot"><button className="button secondary" onClick={()=>setDetail(null)}>关闭</button><button className={`button ${installed?'primary':'secondary'}`} disabled={importing} onClick={()=>{if(selectedBuiltin)builtinAction(selectedBuiltin);else if(selectedCustom){setDetail(null);create(selectedCustom.id);}}}>{installed?'创建环境':selectedIso?.isoPath?'启动安装':'查找或下载 ISO'}<ArrowRight size={15}/></button></footer>
    </Modal>}
    {importingTemplate && <TemplateImport builtin={importingTemplate==='custom'?undefined:importingTemplate} close={()=>setImportingTemplate(null)} busy={importing} pickImage={pickImage} importImage={async value=>{await importImage(value);setGroup(importingTemplate==='custom'?'custom':'builtin');}}/>}
    {editing && <Modal title="编辑模板信息" description="更改名称、说明和下次创建环境时的默认配置。" close={()=>{if(!importing)setEditing(null);}}><form onSubmit={async e=>{e.preventDefault();setError('');try{await update(editing.id,templateFields(new FormData(e.currentTarget)));setEditing(null);}catch(e){setError(e instanceof Error?e.message:'保存失败');}}}><TemplateFields value={editing}/><p className="field-help">要增减系统里的软件，请先从这个模板创建环境，修改完成后另存为新模板。</p>{error&&<p className="form-error" role="alert">{error}</p>}<footer className="modal-foot"><button className="button secondary" type="button" disabled={importing} onClick={()=>setEditing(null)}>取消</button><button className="button primary" disabled={importing}>{importing&&<LoaderCircle size={16} className="spin"/>}保存设置</button></footer></form></Modal>}
  </section>;
}
