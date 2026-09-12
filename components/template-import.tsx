'use client';
import { useState } from 'react';
import { Layers, LoaderCircle } from 'lucide-react';
import { families, type BuiltinTemplate, type Family } from '@/shared/types';
import { Modal } from './primitives';
import { ImagePath, type PickImage } from './image-path';
import { TemplateFields, templateFields } from './template-fields';
export function TemplateImport({builtin, close, busy, importImage, pickImage}: {builtin?: BuiltinTemplate; close:()=>void; busy:boolean; importImage:(value:unknown)=>Promise<unknown>; pickImage:PickImage}) {
  const [family,setFamily]=useState<Family>(builtin?.family ?? 'linux'), [error,setError]=useState('');
  return <Modal title={builtin ? `准备 ${builtin.name}` : '导入已有系统'} description="选择已经安装好系统的磁盘文件，DeskLab 会复制到模板库。" close={()=>{if(!busy)close();}}>
    <form onSubmit={async e=>{e.preventDefault();setError('');const f=new FormData(e.currentTarget);const fields=templateFields(f);try{await importImage({...fields,loginHint:fields.loginHint || undefined,family,path:f.get('path'),firmware:builtin?.firmware ?? f.get('firmware'),...(builtin ? {builtinId:builtin.id}: {})});close();}catch(e){setError(e instanceof Error?e.message:'导入失败');}}}>
      {builtin && <p className="notice">这台电脑还没有此系统的模板磁盘。请选择离线资源包中对应的已安装磁盘；普通 ISO 安装盘不能用于此处。</p>}
      <ImagePath name="path" label="已安装系统的磁盘文件" placeholder="选择 .qcow2、.vhdx 等磁盘文件" kind="disk" pick={pickImage} disabled={busy}/>
      {!builtin && <div className="form-grid two-columns"><label>系统类型<select name="family" value={family} onChange={e=>setFamily(e.target.value as Family)}>{families.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>原系统启动方式<select name="firmware" key={family} defaultValue={family==='windows'?'uefi':'bios'}><option value="bios">BIOS</option><option value="uefi">UEFI</option></select></label></div>}
      <TemplateFields value={builtin ? {name:builtin.name,memory:builtin.memory,cpus:builtin.cpus,description:builtin.description} : undefined}/>
      <p className="field-help">请先关闭原虚拟机。导入会保留磁盘里的软件和账号，不会重新安装系统。{!builtin && '启动方式需与原系统一致。'}</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <footer className="modal-foot"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy}>{busy?<LoaderCircle size={16} className="spin"/>:<Layers size={16}/>} {busy?'正在复制系统…':'导入模板'}</button></footer>
    </form>
  </Modal>;
}
