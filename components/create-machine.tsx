'use client';
import { useState } from 'react';
import { ArrowLeft, ArrowRight, Disc3, Layers, LoaderCircle } from 'lucide-react';
import { families, type Family, type LabSnapshot } from '@/shared/types';
import { Empty, Modal } from './primitives';
import { ImagePath, type PickImage } from './image-path';
import { TemplateChoices } from './template-choices';
import {NetworkFields} from './network-fields';
import type {MachineNetwork} from '@/shared/network';
import {useIsoInspection,type InspectIso} from './use-iso-inspection';

export function CreateMachine({data, initialFamily, initialTemplateId, initialIso = false, initialIsoPath, customizing = false, close, create, busy, pickImage, manageImages, inspectIso}: {data:LabSnapshot; initialFamily?:Family; initialTemplateId?:string; initialIso?:boolean; initialIsoPath?:string; customizing?:boolean; close:()=>void; create:(body:unknown,launch?:boolean)=>Promise<unknown>; busy:boolean; pickImage:PickImage; manageImages:()=>void; inspectIso:InspectIso}) {
  const catalogue=data.catalogue ?? [], customs=data.templates.filter(t=>!t.builtinId);
  const initialBuiltin=catalogue.find(t=>t.id===initialTemplateId || (initialTemplateId && t.templateId===initialTemplateId));
  const first=catalogue.find(t=>(!initialFamily || t.family===initialFamily) && t.templateId) ?? catalogue.find(t=>!initialFamily || t.family===initialFamily);
  const [mode,setMode]=useState<'builtin'|'custom'|'iso'>(initialIso?'iso':initialTemplateId&&!initialBuiltin?'custom':'builtin');
  const [step,setStep]=useState(initialTemplateId||initialIso?2:1), [builtinId,setBuiltinId]=useState(initialBuiltin?.id ?? first?.id ?? '');
  const [customId,setCustomId]=useState(customs.find(t=>t.id===initialTemplateId)?.id ?? customs[0]?.id ?? ''), [family,setFamily]=useState<Family>(initialFamily ?? 'ubuntu');
  const [error,setError]=useState('');
  const [network,setNetwork]=useState<MachineNetwork>({mode:'nat'});
  const [isoChoice,setIsoChoice]=useState(initialIsoPath ?? (initialIso?'':data.isoLibrary?.resources.find(item=>item.id===(initialBuiltin?.id??first?.id))?.isoPath) ?? '');
  const [manualInstall,setManualInstall]=useState(false),[confirmedKey,setConfirmedKey]=useState('');
  const [isoRecipeId,setIsoRecipeId]=useState<string>();
  const builtin=catalogue.find(t=>t.id===builtinId), template=mode==='iso'?undefined:mode==='custom'?customs.find(t=>t.id===customId):data.templates.find(t=>t.id===builtin?.templateId);
  const selected=mode==='iso'?undefined:mode==='builtin'?builtin:template, ready=mode==='iso'||!!template||(mode==='builtin'&&!!builtin?.autoInstall);
  const localIso=data.isoLibrary?.resources.find(item=>item.id===builtinId)?.isoPath;
  const isoResource=data.isoLibrary?.resources.find(item=>item.isoPath===isoChoice);
  const recipe=mode==='builtin'&&!template&&builtin?.autoInstall?builtin:mode==='iso'&&!manualInstall?catalogue.find(item=>item.autoInstall&&item.id===(isoRecipeId??isoResource?.id)&&item.family===family):undefined;
  const fromIso=mode==='iso'||!!recipe;
  const selectionKey=`${mode}-${selected?.id ?? family}-${recipe?.id??''}`;
  const inspection=useIsoInspection(isoChoice,recipe?.family??(mode==='iso'?family:selected?.family??family),recipe?.id,step===2&&fromIso,inspectIso);
  const confirmed=confirmedKey===inspection.key;
  const suggested=catalogue.find(item=>item.autoInstall&&item.id===inspection.result?.suggestedRecipeId&&item.id!==recipe?.id);
  const isoBlocked=fromIso&&!!isoChoice.trim()&&(inspection.loading||!!inspection.error||inspection.result?.status==='mismatch'||!!inspection.result?.requiresConfirmation&&!confirmed);
  const selectBuiltin=(id:string)=>{setBuiltinId(id);setIsoChoice(data.isoLibrary?.resources.find(item=>item.id===id)?.isoPath??'');setError('');};
  const manual=(target:Family)=>{setMode('iso');setFamily(target);setManualInstall(true);setError('');};
  const cpuDefault=Math.max(1,Math.min(selected?.cpus ?? recipe?.cpus ?? 2,data.host.threads,32));
  const memoryLimit=Math.max(512,Math.min(65536,Math.floor(data.host.totalMemory/1048576)));
  const memoryDefault=Math.min(selected?.memory ?? recipe?.memory ?? (family==='windows'?4096:2048),memoryLimit);
  const switchMode=(next:typeof mode)=>{setMode(next);setStep(1);setError('');};
  const linux=(recipe?.family??selected?.family??family)!=='windows';
  return <Modal className="create-dialog" title={customizing?'创建自己的定制环境':'创建环境'} close={()=>{if(!busy)close();}}>
    <ol className="creation-steps" aria-label="创建步骤"><li aria-current={step===1?'step':undefined}><span>1</span>选择系统</li><li aria-current={step===2?'step':undefined}><span>2</span>配置并启动</li></ol>
    {step===1 ? <><div className="create-dialog-body">
      <div className="segmented" aria-label="模板来源"><button type="button" aria-pressed={mode==='builtin'} className={mode==='builtin'?'selected':''} onClick={()=>switchMode('builtin')}>系统自带</button><button type="button" aria-pressed={mode==='custom'} className={mode==='custom'?'selected':''} onClick={()=>switchMode('custom')}>我的模板 <span>{customs.length}</span></button></div>
      {mode==='builtin' ? <><p className="field-help">首次使用配合原版 ISO 自动安装，以后直接创建。Linux Server 打开终端，Windows 打开桌面。</p><TemplateChoices items={catalogue} selected={builtinId} select={selectBuiltin}/></> : mode==='custom' ? customs.length ? <TemplateChoices items={customs} selected={customId} select={setCustomId}/> : <Empty title="把配置好的环境保存成模板" description="先从系统自带创建一个环境。安装好需要的软件，关机后点击“保存为模板”，下次就能直接复用。"><button className="button secondary" onClick={()=>switchMode('builtin')}>选择系统自带模板</button></Empty> : <p className="notice">支持的原版 ISO 可自动安装。其他 ISO 需要按系统安装向导操作。</p>}
      {selected && mode!=='iso' && <p className="selection-description">{selected.description}{!ready && ' 还没有安装好的系统；可从本地 ISO 安装，或在线下载 ISO。'}</p>}
      <button type="button" className="text-button iso-entry" onClick={()=>switchMode(mode==='iso'?'builtin':'iso')}><Disc3 size={15}/>{mode==='iso'?'返回系统自带模板':'已有 ISO 安装盘？从 ISO 安装'}</button>
      </div><footer className="modal-foot"><button className="button secondary" onClick={close}>取消</button>{!ready && mode==='builtin' ? <button className="button primary" onClick={()=>{if(localIso&&builtin){setIsoChoice(localIso);setFamily(builtin.family);setMode('iso');setStep(2);}else manageImages();}}>{localIso?'使用本地 ISO 安装':'查找或下载 ISO'} <ArrowRight size={16}/></button> : <button className="button primary" disabled={!ready} onClick={()=>setStep(2)}>下一步 <ArrowRight size={16}/></button>}</footer>
    </> : <form className="create-dialog-form" onSubmit={async e=>{
      e.preventDefault();setError('');const f=new FormData(e.currentTarget);
      if(isoBlocked)return;
      if(!ready){setError('系统模板尚未准备好，请返回重新选择。');return;}
      try{await create({name:f.get('name'),network,family:recipe?.family ?? (mode==='iso'?family:template!.family),memory:Number(f.get('memory')),cpus:Number(f.get('cpus')),diskGB:Number(f.get('diskGB')),...(fromIso?{isoPath:f.get('isoPath'),isoTypeConfirmed:confirmed,firmware:recipe?.firmware ?? f.get('firmware'),freshInstall:true,...(recipe?{recipeId:recipe.id}:{})}:{templateId:template!.id})},true);}catch(e){setError(e instanceof Error?e.message:'创建失败');}
    }}>
      <div className="create-dialog-body">
      <div className="create-system-summary"><Layers size={19}/><div><strong>{mode==='iso'?'从 ISO 安装':selected?.name}</strong><p>{recipe?'首次自动安装，完成后可直接复用。':mode==='iso'?'使用本地安装盘创建全新系统。':'从模板创建独立副本。'}</p></div><button type="button" className="text-button" disabled={busy} onClick={()=>{setStep(1);setError('');}}><ArrowLeft size={15}/>重新选择系统</button></div>
      <div className="create-config-grid"><section className="create-basics" aria-label="环境信息">
      <label>给这个环境起个名字<input key={selectionKey} autoFocus name="name" required maxLength={64} defaultValue={`${mode==='iso'?families.find(t=>t.id===family)?.name:selected?.name} ${customizing?'定制':'测试'}`} placeholder="例如：我的开发测试环境"/></label>
      {mode==='iso' ? <>
        <label>要安装的系统<select value={family} onChange={e=>setFamily(e.target.value as Family)}>{families.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        {!!data.images?.length && <label>从 ISO 目录中选择<select value={isoChoice} onChange={e=>{setIsoChoice(e.target.value);const image=data.images?.find(item=>item.isoPath===e.target.value);if(image)setFamily(image.family);}}><option value="">手动选择其他文件</option>{data.images.map(image=><option key={image.isoPath} value={image.isoPath}>{image.file}</option>)}</select></label>}
        <ImagePath value={isoChoice} onPathChange={setIsoChoice} name="isoPath" label="ISO 安装盘" placeholder="选择下载好的 .iso 文件" kind="iso" pick={pickImage} disabled={busy}/>
        <button type="button" className="text-button" disabled={busy} onClick={manageImages}>设置 ISO 目录或在线下载 <ArrowRight size={14}/></button>
        <p className="field-help">{recipe?'已匹配自动安装配置。':'按系统安装向导操作，自行设置账号和密码。'}</p>
      </> : null}
      {mode==='builtin'&&recipe&&<><ImagePath value={isoChoice} onPathChange={setIsoChoice} name="isoPath" label="原版 ISO 安装盘" placeholder="选择对应版本的 ISO" kind="iso" pick={pickImage} disabled={busy}/><button type="button" className="text-button" disabled={busy} onClick={manageImages}>没有安装盘？前往下载 ISO <ArrowRight size={14}/></button></>}
      {fromIso&&!!isoChoice.trim()&&<div className={`iso-inspection ${inspection.error||inspection.result?.status==='mismatch'?'is-error':''}`}>
        <p role="status">{inspection.loading?'正在读取安装盘信息…':inspection.error||inspection.result?.message}</p>
        {inspection.result?.label&&<small>镜像内部标识：{inspection.result.label}</small>}
        {inspection.error&&<button type="button" className="text-button" onClick={inspection.retry}>重新检查</button>}
        {suggested&&<button type="button" className="text-button" disabled={busy} onClick={()=>{setMode('iso');setFamily(suggested.family);setManualInstall(false);setIsoRecipeId(suggested.id);setError('');}}>改用 {suggested.name} 自动安装 <ArrowRight size={14}/></button>}
        {inspection.result?.status==='mismatch'&&<button type="button" className="text-button" disabled={busy} onClick={()=>manual(inspection.result?.detectedFamily??recipe?.family??family)}>按{families.find(f=>f.id===(inspection.result?.detectedFamily??recipe?.family??family))?.name}手动安装 <ArrowRight size={14}/></button>}
        {inspection.result?.requiresConfirmation&&<label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmedKey(e.target.checked?inspection.key:'')}/>我已确认系统类型，使用手动安装</label>}
      </div>}
      {!fromIso&&<p className="field-help">保留模板中的软件和账号，数据单独保存。</p>}
      </section><fieldset className="instance-resources"><legend>实例配置</legend>
        <div className="form-grid" key={selectionKey}>
          <label>处理器（核）<input name="cpus" type="number" required min={1} max={Math.min(32,data.host.threads)} step={1} defaultValue={cpuDefault}/></label>
          <label>内存（MB）<input name="memory" type="number" required min={recipe?.memory??512} max={memoryLimit} step={1} defaultValue={memoryDefault}/></label>
          <label>磁盘容量（GB）<input name="diskGB" type="number" required min={Math.max(8,template?.diskGB??recipe?.diskGB??8)} max={512} step={1} defaultValue={Math.max(8,template?.diskGB??recipe?.diskGB??64)}/></label>
        </div>
        <p className="field-help">{template?<>磁盘至少 {template.diskGB} GB，仅支持扩大。</>:recipe?<>至少 {recipe.memory} MB 内存、{recipe.diskGB} GB 磁盘。</>:'2048 MB = 2 GB。'} 磁盘按实际写入占用空间。</p>
        {mode==='iso'&&!recipe&&<label>启动方式<select name="firmware" key={family} defaultValue={family==='windows'?'uefi':'bios'}><option value="bios">BIOS</option><option value="uefi">UEFI</option></select></label>}
      </fieldset></div>
      <details className="create-connection"><summary><span>网络与登录</span><span className="field-help">NAT · {linux?'SSH 密钥连接':'浏览器桌面'}</span></summary>
      <NetworkFields value={network} change={setNetwork} disabled={busy}/>
      {linux&&<p className="field-help">{mode==='iso'&&!recipe?'手动安装后，需自行启用 SSH 并授权本机公钥。可在实例的“连接与网络”中查看步骤。':'默认使用本机 Ed25519 SSH 密钥。新装 Linux 自动授权；已有模板可在“连接与网络”中查看授权步骤。'}</p>}

      {(mode!=='iso'||recipe) && <p className="login-hint">{recipe?.loginHint || template?.loginHint || '保留模板中的账号和登录方式；如需密码，请使用你安装系统时设置的账号。'}</p>}
      </details>
      {template&&<p className="field-help">扩大磁盘后，需在系统内检查并扩展分区与文件系统。</p>}
      {customizing && <p className="notice">启动后安装你需要的软件 → 正常关机 → 在环境上点击“保存为模板”。</p>}
      </div><div className="create-dialog-actions">
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="modal-foot"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy||!ready||isoBlocked}>{busy?<LoaderCircle size={16} className="spin"/>:<ArrowRight size={16}/>} {busy?(recipe?'正在校验并创建…':'正在创建并启动…'):inspection.loading?'正在检查安装盘…':recipe?'创建并自动安装':mode==='iso'?'开始安装':'创建并启动'}</button></footer>
      </div></form>}
  </Modal>;
}
