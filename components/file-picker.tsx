'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowUp, Check, File, Folder, LoaderCircle} from 'lucide-react';
import type {FileListing, FilePickerKind} from '@/shared/file-picker';
import {Modal} from './primitives';

type Selection = {path: string|null};
type Request = {kind: FilePickerKind; path?: string};
type ListFiles = (request: Request) => Promise<FileListing>;

export function useFilePicker(list: ListFiles) {
  const [request, setRequest] = useState<Request|null>(null);
  const pending = useRef<((value: Selection) => void)|null>(null);
  const lastPath = useRef<Partial<Record<FilePickerKind,string>>>({});
  useEffect(() => () => {pending.current?.({path:null});pending.current=null;}, []);
  const pick = useCallback((kind: FilePickerKind, path?: string) => new Promise<Selection>(resolve => {
    pending.current?.({path:null});
    pending.current=resolve;
    setRequest({kind, path:path || lastPath.current[kind]});
  }), []);
  const finish = (path: string|null) => {
    if(path && request)lastPath.current[request.kind]=path;
    pending.current?.({path});pending.current=null;setRequest(null);
  };
  return {pick, dialog: request && <FilePicker request={request} list={list} finish={finish}/>};
}

function FilePicker({request, list, finish}: {request: Request; list: ListFiles; finish: (path:string|null)=>void}) {
  const [listing, setListing] = useState<FileListing|null>(null);
  const [address, setAddress] = useState(request.path ?? '');
  const [selected, setSelected] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const revision = useRef(0), entries = useRef<HTMLDivElement>(null);
  const load = useCallback(async (path?:string) => {
    const current=++revision.current;
    setLoading(true);setError('');setSelected('');
    try {
      const value=await list({kind:request.kind,path});
      if(current!==revision.current)return;
      setListing(value);setAddress(value.path);if(entries.current)entries.current.scrollTop=0;
    } catch(error) {
      if(current===revision.current)setError(error instanceof Error?error.message:'无法读取这个文件夹');
    } finally {if(current===revision.current)setLoading(false);}
  }, [list, request.kind]);
  useEffect(() => {void load(request.path);return () => {revision.current++;};}, [load, request.path]);
  const directory=request.kind==='directory';
  const choice=directory?listing?.path:selected;
  return <Modal title={directory?'选择 ISO 文件夹':request.kind==='iso'?'选择 ISO 安装盘':request.kind==='compose'?'选择 Compose 文件':'选择虚拟磁盘'} description={directory?'打开存放 ISO 的文件夹，再点击“使用此文件夹”。':'浏览这台电脑，选择已有文件即可，无需上传或复制。'} close={()=>finish(null)}>
    <div className="file-picker">
      <form className="file-picker-address" onSubmit={event=>{event.preventDefault();void load(address.trim() || undefined);}}>
        <label htmlFor="file-picker-address">当前位置</label>
        <div><button type="button" className="icon-button" title="返回上级文件夹" aria-label="返回上级文件夹" disabled={loading||!listing?.parent} onClick={()=>void load(listing?.parent ?? undefined)}><ArrowUp size={18}/></button><input id="file-picker-address" value={address} onChange={event=>setAddress(event.target.value)} placeholder="输入文件夹的完整路径" spellCheck={false}/><button type="submit" className="button secondary" disabled={loading}>前往</button></div>
      </form>
      {!!listing?.shortcuts.length && <nav className="file-picker-shortcuts" aria-label="常用位置">{listing.shortcuts.map(item=><button type="button" key={item.path} className="button secondary" disabled={loading} onClick={()=>void load(item.path)}>{item.name}</button>)}</nav>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <div ref={entries} className="file-picker-entries" aria-label="本机文件列表" aria-busy={loading}>
        {loading?<p className="file-picker-empty" role="status"><LoaderCircle className="spin" size={18}/>正在读取文件夹…</p>:listing?.entries.length?listing.entries.map(item=><button type="button" key={item.path} className={`file-picker-entry${selected===item.path?' selected':''}`} aria-pressed={item.directory?undefined:selected===item.path} onClick={()=>item.directory?void load(item.path):setSelected(item.path)}>
          {item.directory?<Folder size={19}/>:<File size={19}/>}<span>{item.name}</span>{selected===item.path?<Check size={16}/>:<small>{item.directory?'打开文件夹':'选择'}</small>}
        </button>):!error&&<p className="file-picker-empty">{directory?'这个文件夹中没有子文件夹，可以直接使用。':request.kind==='iso'?'这里没有 ISO 安装盘，请选择其他文件夹或在本机设置中下载。':'这里没有虚拟磁盘文件，请选择其他文件夹。'}</p>}
      </div>
      {listing?.truncated&&<p className="field-help">目录内容较多，已限制显示数量。可在上方输入目标文件或子文件夹的完整路径。</p>}
      <p className="file-picker-selection" role="status">{directory?'将使用：':selected?'已选择：':'请选择一个文件'}<span>{choice}</span></p>
      <footer className="modal-foot"><button type="button" className="button secondary" onClick={()=>finish(null)}>取消</button><button type="button" className="button primary" disabled={loading||!!error||!choice} onClick={()=>choice&&finish(choice)}>{directory?'使用此文件夹':'使用此文件'}</button></footer>
    </div>
  </Modal>;
}
