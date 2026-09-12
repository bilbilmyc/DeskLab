'use client';
import {useState} from 'react';
import {Server,Play,Square,Database,FileText,SlidersHorizontal} from 'lucide-react';
import {Modal} from '../primitives';
import type {ManagedAvailability,EngineBackup} from '@/shared/docker-managed';
type Invoke=(path:string,body?:unknown)=>Promise<any>;
const states={preparing:'准备中',starting:'启动中',running:'运行中',stopping:'关机中',stopped:'已停止',error:'需要检查'};
const size=(n:number)=>n>=1024**3?(n/1024**3).toFixed(1)+' GB':(n/1024**2).toFixed(1)+' MB';
export function ManagedEngine({data,selected,working,invoke}:{data?:ManagedAvailability;selected:boolean;working:boolean;invoke:Invoke}){
 const [inspector,setInspector]=useState(false);
 const [setup,setSetup]=useState<'enable'|'configure'>(),[logs,setLogs]=useState<string>(),[restoring,setRestoring]=useState<EngineBackup>(),[rebuilding,setRebuilding]=useState(false),[forcing,setForcing]=useState(false),[error,setError]=useState('');
 const engine=data?.engine;
 const call=async(path:string,body:unknown={})=>{setError('');try{return await invoke('managed/'+path,body);}catch(e){setError((e as Error).message);throw e;}};
 return <section className="managed-engine-compact" aria-label="DeskLab 内置引擎">
  <div className="docker-engine-strip"><Server size={18} className="engine-strip-icon"/><strong>内置引擎</strong>{engine?<><span className={'status '+(engine.state==='running'?'running':'stopped')}><span/>{states[engine.state]}</span><span className="engine-brief">{engine.cpus} 核 / {size(engine.memoryMB*1048576)}<span> · {engine.diskGB} GB 数据盘</span></span><div className="engine-strip-actions">{!selected?<button className="button secondary compact" disabled={working} onClick={()=>void call('select').catch(()=>{})}>使用此引擎</button>:engine.pid?<button className="button secondary compact" disabled={working} onClick={()=>void call('stop').catch(()=>{})}><Square size={14}/>正常停止</button>:<button className="button secondary compact" disabled={working} onClick={()=>void call('start').catch(()=>{})}><Play size={14}/>启动引擎</button>}<button className="button secondary compact" onClick={()=>setInspector(true)}><SlidersHorizontal size={15}/>引擎设置</button></div></>:<><span className="engine-brief">{data?data.available?'无需 Docker Desktop · 按需启动':'未安装引擎组件':'正在读取引擎…'}</span><button className="button secondary compact" disabled={working||!data?.available} onClick={()=>setSetup('enable')}>启用内置引擎</button></>}</div>
  {engine?.message&&<p className={engine.state==='error'?'alert error docker-alert':'engine-message'} role="status">{engine.message}{engine.state==='error'&&<button className="text-button" onClick={()=>setInspector(true)}>检查引擎 →</button>}</p>}
  {error&&!inspector&&!setup&&<p className="alert error docker-alert" role="alert">{error}</p>}
  {data&&!data.available&&<p className="engine-message">请使用完整安装包安装“独立 Docker 引擎”组件。</p>}
  {inspector&&<Modal title="内置引擎设置" close={()=>setInspector(false)}><div className="managed-engine">
  <div className="managed-heading"><span className="container-symbol"><Server size={24}/></span><div><h2>DeskLab 内置引擎</h2><p>{engine?'由 DeskLab 启停的独立 Linux 容器环境':'独立运行 Docker，无需安装 Docker Desktop。'}</p></div>{engine&&<span className={`status ${engine.state==='running'?'running':'stopped'}`}><span/>{states[engine.state]}</span>}</div>
  {!data?.available&&<p className="notice">未找到独立引擎组件，请用完整安装包安装“独立 Docker 引擎”组件。</p>}
  {engine?<><div className="managed-resources"><div><small>CPU / 内存</small><strong>{engine.cpus} 核 / {size(engine.memoryMB*1048576)}</strong></div><div><small>数据盘容量上限</small><strong>{engine.diskGB} GB</strong></div><div><small>磁盘文件大小</small><strong>{engine.diskBytes===undefined?'读取中':size(engine.diskBytes)}</strong></div><div><small>引擎内剩余空间</small><strong>{engine.diskFreeBytes===undefined?'启动后读取':size(engine.diskFreeBytes)}</strong></div></div>
   <p className="field-help">数据位置：<code>{engine.directory}</code></p>
   {engine.message&&<p className={engine.state==='error'?'alert error':'notice'} role="status">{engine.message}</p>}
   <div className="managed-actions">
    <button className="button secondary" disabled={working||engine.state!=='stopped'||!engine.initialized} onClick={()=>void call('backup',{label:'手动备份 '+new Date().toLocaleDateString()}).catch(()=>{})}><Database size={15}/>停机备份</button>
    <button className="button secondary" disabled={working} onClick={()=>void call('logs').then(r=>{setInspector(false);setLogs(r.text);}).catch(()=>{})}><FileText size={15}/>引擎日志</button>
    <button className="button secondary" disabled={working||engine.state!=='stopped'} onClick={()=>{setInspector(false);setSetup('configure');}}>调整资源</button>
    <button className="text-button" disabled={working||engine.state!=='stopped'||!engine.initialized} onClick={()=>{setInspector(false);setRebuilding(true);}}>修复 / 更新系统</button>
    {!engine.initialized&&engine.state==='error'&&<button className="button secondary" disabled={working} onClick={()=>void call('enable').catch(()=>{})}>继续初始化</button>}
    {engine.state==='error'&&!!engine.pid&&<button className="button danger" disabled={working} onClick={()=>{setInspector(false);setForcing(true);}}>强制停止引擎</button>}
   </div>
   {!!data?.backups.length&&<details className="managed-backups"><summary>备份与恢复 · {data.backups.length} 份</summary><p className="field-help">恢复会将内置引擎的容器、数据卷和映射还原到备份时点。请先停止引擎。</p>{data.backups.map(b=><div className="backup-row" key={b.id}><div><strong>{b.label}</strong><small>{new Date(b.createdAt).toLocaleString()} · {size(b.bytes)}</small></div><button className="button secondary compact" disabled={working||engine.state!=='stopped'} onClick={()=>{setInspector(false);setRestoring(b);}}>恢复</button></div>)}</details>}
  </>:<div className="managed-intro"><p>启用时准备专属系统盘和数据盘。首次默认分配 2 核、2 GB 内存；容器数据持续保留。</p><button className="button primary" disabled={working||!data?.available} onClick={()=>setSetup('enable')}>启用内置引擎</button></div>}
  <p className="field-help">按需启动；关闭浏览器后继续运行。真正退出 DeskLab 时，会正常停止容器并关闭这套引擎，释放其内存和 CPU。</p>
  {error&&<p className="alert error" role="alert">{error}</p>}
  </div></Modal>}
  {setup&&<Modal title={setup==='enable'?'启用 DeskLab 内置引擎':'调整内置引擎资源'} close={()=>setSetup(undefined)}><form onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await call(setup,{cpus:Number(f.get('cpus')),memoryMB:Number(f.get('memory')),...(setup==='enable'?{diskGB:Number(f.get('disk'))}:{})});setSetup(undefined);}catch{}}}>
   <div className="form-grid"><label>CPU 核数<input name="cpus" type="number" min={1} max={32} defaultValue={engine?.cpus??2} required/></label><label>内存（MB）<input name="memory" type="number" min={1024} max={32768} step={256} defaultValue={engine?.memoryMB??2048} required/></label></div>
   {setup==='enable'&&<label>数据盘容量上限（GB）<input name="disk" type="number" min={16} max={1024} defaultValue={64} required/></label>}
   <p className="notice">数据盘保存在 DeskLab 数据目录中，按写入增长。系统和 Docker 已随组件预装，拉取新的容器镜像仍需联网。</p>{error&&<p className="form-error">{error}</p>}
   <footer className="modal-foot"><button type="button" className="button secondary" disabled={working} onClick={()=>setSetup(undefined)}>取消</button><button className="button primary" disabled={working}>{setup==='enable'?'准备并启动':'保存配置'}</button></footer>
  </form></Modal>}
  {logs!==undefined&&<Modal title="内置引擎日志" close={()=>setLogs(undefined)}><pre className="task-output">{logs||'暂无日志'}</pre></Modal>}
  {restoring&&<Modal title="恢复内置引擎备份" close={()=>setRestoring(undefined)}><p>恢复到“{restoring.label}”。当前引擎中的后续修改将被替换，建议先创建一份当前状态的备份。</p><footer className="modal-foot"><button className="button secondary" onClick={()=>setRestoring(undefined)}>取消</button><button className="button danger" disabled={working} onClick={()=>void call('restore',{id:restoring.id}).then(()=>setRestoring(undefined)).catch(()=>{})}>确认恢复</button></footer></Modal>}
  {rebuilding&&<Modal title="修复或更新引擎系统" close={()=>setRebuilding(false)}><p>先创建完整停机备份，再使用已安装组件重建系统盘，并保留数据盘。成功后启动引擎；失败时恢复备份。</p><footer className="modal-foot"><button className="button secondary" onClick={()=>setRebuilding(false)}>取消</button><button className="button primary" disabled={working} onClick={()=>void call('rebuild').then(()=>setRebuilding(false)).catch(()=>{})}>备份并重建</button></footer></Modal>}
  {forcing&&<Modal title="强制停止内置引擎" close={()=>setForcing(false)}><p>这会立即结束独立 Linux 引擎，正在写入的数据可能丢失。正常关机无法完成时才使用。</p>{error&&<p className="form-error">{error}</p>}<footer className="modal-foot"><button className="button secondary" onClick={()=>setForcing(false)}>返回</button><button className="button danger" disabled={working} onClick={()=>void call('force-stop',{confirm:true}).then(()=>setForcing(false)).catch(()=>{})}>确认强制停止</button></footer></Modal>}
 </section>;
}
