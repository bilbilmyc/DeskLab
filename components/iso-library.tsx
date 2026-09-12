'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, Check, Download, FolderOpen, LoaderCircle, Pause, Play, RefreshCw, Disc3 } from 'lucide-react';
import type { Family, IsoDownload, IsoResource, LabSnapshot } from '@/shared/types';
import { Modal, OsIcon } from './primitives';

export const downloading=(job?:IsoDownload)=>!!job && ['queued','downloading','verifying'].includes(job.status);
function size(bytes:number){return bytes>=1073741824?`${(bytes/1073741824).toFixed(2)} GB`:`${(bytes/1048576).toFixed(1)} MB`;}
function remaining(seconds?:number){if(seconds===undefined||!Number.isFinite(seconds))return '计算剩余时间…';return seconds<60?`约 ${Math.max(1,Math.ceil(seconds))} 秒`:`约 ${Math.ceil(seconds/60)} 分钟`;}
export function IsoProgress({job}:{job:IsoDownload}) {
  const percentage=job.total>0?Math.min(100,Math.max(0,job.received/job.total*100)):0;
  const labels={queued:'等待下载',downloading:'正在下载',verifying:'正在校验文件，请稍候',paused:'已暂停，可继续下载',completed:'下载完成',error:'下载未完成'};
  return <div className={`iso-progress ${job.status}`}><div className="progress-label"><span>{labels[job.status]}</span><strong>{job.status==='verifying'?'校验中':`${percentage.toFixed(1)}%`}</strong></div><progress aria-label={`${job.file} 下载进度`} max={100} value={job.total>0?percentage:undefined}/><div className="progress-detail"><span>{size(job.received)} / {size(job.total)}</span>{job.status==='downloading'&&<span>{size(job.speed)}/s · {remaining(job.eta)}</span>}</div>{job.error&&<p className="form-error" role="alert">{job.error}</p>}</div>;
}

export function IsoLibraryPanel({data,busy,save,scan,pickDirectory,download,pause,install}:{data:LabSnapshot;busy:boolean;save:(value:unknown)=>Promise<unknown>;scan:()=>Promise<unknown>;pickDirectory:()=>Promise<{path:string|null}>;download:(id:string)=>Promise<unknown>;pause:(id:string)=>Promise<unknown>;install:(path:string,family:Family)=>void}) {
  const library=data.isoLibrary, resources=library?.resources ?? [], active=resources.some(item=>downloading(item.download));
  const [path,setPath]=useState(data.host.isoDirectory ?? ''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[selecting,setSelecting]=useState(false),[sourceId,setSourceId]=useState<string|null>(null);
  useEffect(()=>{setPath(data.settings.isoDirectory || data.host.isoDirectory || '');},[data.settings.isoDirectory,data.host.isoDirectory]);
  const dirty=path.trim()!==(data.settings.isoDirectory || data.host.isoDirectory || '');
  const others=(data.images ?? []).filter(image=>!resources.some(item=>item.file.toLowerCase()===image.file.toLowerCase()));
  const selectedSource=resources.find(item=>item.id===sourceId);
  const invoke=async(operation:()=>Promise<unknown>)=>{setError('');try{await operation();}catch(e){setError(e instanceof Error?e.message:'操作失败，请重试。');}};
  const cards=(items:IsoResource[])=>items.map(item=>{
    const job=item.download, running=downloading(job);
    const status=item.isoPath?'已在本地':item.issue?'文件异常':job?.status==='paused'?'已暂停':job?.status==='error'?'需重试':job?.status==='queued'?'排队中':job?.status==='verifying'?'校验中':running?'下载中':item.url?'待下载':'来源不可用';
    return <article key={item.id} className="iso-card">
      <div className="iso-card-top"><OsIcon family={item.family}/><div className="iso-card-identity"><h3>{item.name}</h3><p className="iso-card-meta">{item.family==='windows'?'Windows 安装盘':item.id.endsWith('-desktop')?'Linux 桌面版':'Linux 终端版'}<span>{size(item.bytes)}</span></p></div><span className={`iso-card-state ${item.isoPath?'ready':running?'active':job?.status==='error'||item.issue?'failed':''}`}>{item.isoPath&&<Check size={13}/>} {status}</span></div>
      {job&&!item.isoPath?<IsoProgress job={job}/>:!!(item.issue||item.unavailableReason)&&<p className="iso-card-note">{item.issue||item.unavailableReason}</p>}
      {job&&!item.isoPath&&item.issue&&<p className="iso-card-note error-text">{item.issue}</p>}
      <div className="iso-card-actions"><button className="text-button" onClick={()=>setSourceId(item.id)} aria-label={`${item.name} 文件与来源`}>文件与来源</button>
        {item.isoPath?<button className="button primary compact" disabled={busy} onClick={()=>install(item.isoPath!,item.family)}>启动安装 <ArrowRight size={15}/></button>:running?<button className="button secondary compact" disabled={busy} onClick={()=>void invoke(()=>pause(item.id))}><Pause size={14}/>{job?.status==='queued'?'移出队列':'暂停'}</button>:<button className="button secondary compact" disabled={busy||!!item.issue||!item.url||!!library?.error||dirty} onClick={()=>void invoke(()=>download(item.id))}>{job?.status==='paused'?<Play size={14}/>:job?.status==='error'?<RefreshCw size={14}/>:<Download size={14}/>} {job?.status==='paused'?'继续下载':job?.status==='error'?'重新下载':'在线下载'}</button>}
      </div>
    </article>;
  });
  const extra=resources.filter(item=>item.id.endsWith('-desktop')&&item.family!=='windows');
  return <>
    <details className="iso-directory-panel"><summary><FolderOpen size={18}/><strong>ISO 存放目录</strong><code title={path}>{path}</code><span>{dirty?'待保存':active?'下载中':'管理目录'}</span></summary>
      <form onSubmit={async e=>{e.preventDefault();setNotice('');await invoke(async()=>{if(dirty)await save({isoDirectory:path});else await scan();setNotice('扫描完成，检测结果显示在下方。');});}}>
        <label htmlFor="iso-directory">ISO 目录</label><div className="iso-directory-controls"><input id="iso-directory" value={path} onChange={e=>{setPath(e.target.value);setNotice('');}} disabled={busy||active} placeholder={data.host.isoDirectory} spellCheck={false}/><button type="button" className="button secondary" disabled={busy||active||selecting} onClick={async()=>{setError('');setSelecting(true);try{const selected=await pickDirectory();if(selected.path){setPath(selected.path);setNotice('');}}catch(e){setError(e instanceof Error?e.message:'无法打开文件夹选择器');}finally{setSelecting(false);}}}><FolderOpen size={16}/>{selecting?'请选择…':'选择文件夹'}</button><button className="button primary" disabled={busy||active||selecting}>{busy?<LoaderCircle size={16} className="spin"/>:<RefreshCw size={16}/>} {dirty?'保存并扫描':'重新扫描'}</button></div>
        <p className="field-help">检测到 ISO 后可启动安装；缺少时点“在线下载”。留空保存可恢复默认目录。</p>
        {active?<p className="notice">下载在后台进行，离开页面也会继续。更换目录前请先暂停；关闭 DeskLab 后可在下次打开时继续下载。</p>:dirty?<p className="notice">目录已修改，请点击“保存并扫描”后再下载。</p>:null}
        {notice&&<p className="saved iso-scan-notice" role="status"><Check size={15}/>{notice}</p>}
      </form>
      {(error||library?.error)&&<p className="form-error" role="alert">{error||library?.error}</p>}
    </details>
    <section aria-label="系统镜像"><div className="iso-cards-heading"><div><h2>系统安装盘</h2><p>已有“已准备好”的模板时，可以直接创建环境。</p></div><span>{resources.filter(item=>!!item.isoPath).length} / {resources.length} 已在本地</span></div>
      <div className="iso-card-grid">{cards(resources.filter(item=>!extra.includes(item)))}</div>
      {extra.length>0&&<details className="extra-templates"><summary>其他 Linux 桌面安装盘 <span>{extra.length}</span>{extra.some(item=>downloading(item.download))&&' · 下载中'}</summary><div className="iso-card-grid">{cards(extra)}</div></details>}
      {others.length>0&&<div className="other-isos"><div className="iso-cards-heading"><div><h3>目录中发现的其他 ISO</h3><p>启动前请确认是完整的系统安装盘。</p></div></div><div className="iso-card-grid">{others.map(item=><article className="iso-card other-iso-card" key={item.isoPath}><Disc3 size={24}/><h3>{item.file}</h3><button className="button secondary compact" disabled={busy} onClick={()=>install(item.isoPath,item.family)}>启动安装 <ArrowRight size={14}/></button></article>)}</div></div>}
    </section>
    {selectedSource&&<Modal title={selectedSource.name} description="镜像文件与来源" close={()=>setSourceId(null)}><div className="iso-source-details"><h3>文件名</h3><p className="mono">{selectedSource.file}</p>{selectedSource.isoPath&&<><h3>本地位置</h3><p className="mono">{selectedSource.isoPath}</p></>}<h3>完整性检测</h3><p>{selectedSource.hasChecksum?'在线下载完成后，会对照发行方校验值检查完整性。':'此镜像未提供公开校验值；下载时核对文件大小并记录本地校验值。'}本地扫描仅检测文件名和大小。</p>{selectedSource.sourcePage&&<a href={selectedSource.sourcePage} target="_blank" rel="noreferrer">查看发行方来源 <ArrowRight size={14}/></a>}</div><footer className="modal-foot"><button className="button secondary" onClick={()=>setSourceId(null)}>关闭</button></footer></Modal>}
  </>;
}
