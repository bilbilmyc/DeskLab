'use client';
import { useId, useState } from 'react';
import { FolderOpen } from 'lucide-react';

export type PickImage = (kind: 'iso'|'disk', path?:string) => Promise<{path: string|null}>;
export function ImagePath({name, label, placeholder, kind, pick, disabled, initialPath = '', value, onPathChange}: {name: string; label: string; placeholder: string; kind: 'iso'|'disk'; pick: PickImage; disabled: boolean; initialPath?:string; value?:string; onPathChange?:(path:string)=>void}) {
  const id=useId(), [localPath,setLocalPath]=useState(initialPath), [error,setError]=useState(''), [selecting,setSelecting]=useState(false);
  const path=value??localPath,setPath=(next:string)=>{setLocalPath(next);onPathChange?.(next);};
  return <div className="image-path-field"><label htmlFor={id}>{label}</label><div className="image-path-row">
    <input id={id} name={name} required value={path} onChange={e=>setPath(e.target.value)} placeholder={placeholder} spellCheck={false}/>
    <button type="button" className="button secondary" disabled={disabled || selecting} onClick={async()=>{setError('');setSelecting(true);try {const selected=await pick(kind,path);if(selected.path)setPath(selected.path);}catch(e){setError(e instanceof Error?e.message:'无法打开文件选择器');}finally{setSelecting(false);}}}><FolderOpen size={16}/>{selecting?'请选择文件…':'选择文件'}</button>
  </div>{error&&<p role="alert" className="form-error">{error}</p>}</div>;
}
