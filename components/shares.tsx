'use client';
import {useState} from 'react';
import {FolderOpen,LoaderCircle,Share2} from 'lucide-react';
import type {Machine,MachineShare} from '@/shared/types';
import {Empty,Modal} from './primitives';

type Action = (path: string, body?: unknown) => Promise<any>;
/** PowerShell aliases `curl` to Invoke-WebRequest; the real client is curl.exe. */
function curl(machine: Machine) { return machine.family === 'windows' ? 'curl.exe' : 'curl'; }
function guestBase(machine: Machine, share: MachineShare) {
  return machine.shareChannel ? `http://10.0.2.2:${machine.shareChannel.port}/share/${machine.shareChannel.token}/${share.name}` : undefined;
}
export function SharesPanel({machine,busy,action,close,pickDirectory}:{machine:Machine;busy:boolean;action:Action;close:()=>void;pickDirectory:()=>Promise<string|null>}) {
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[working,setWorking]=useState(false);
  const [name,setName]=useState(''),[hostPath,setHostPath]=useState(''),[readOnly,setReadOnly]=useState(false),[choosing,setChoosing]=useState(false);
  const [removing,setRemoving]=useState<MachineShare>(),[help,setHelp]=useState(false);
  const shares=machine.shares??[],channel=machine.shareChannel,live=machine.state==='running';
  const add=async()=>{
    setWorking(true);setError('');
    try{
      await action(`machines/${machine.id}/shares`,{name,hostPath,readOnly});
      setNotice(live?'共享已添加，环境内立即可用。':'共享已添加，启动环境后在系统内使用。');
      setName('');setHostPath('');setReadOnly(false);
    }catch(e){setError((e as Error).message);}
    finally{setWorking(false);}
  };
  const choose=async()=>{
    setChoosing(true);
    try{const path=await pickDirectory();if(path)setHostPath(path);}finally{setChoosing(false);}
  };
  const copy=async(text:string,label:string)=>{
    try{await navigator.clipboard.writeText(text);setNotice(label);}
    catch{setError('复制失败，请手动复制命令');}
  };
  return <Modal title={`${machine.name} · 宿主目录共享`} className="shares-modal" close={close}>
    <p className="field-help">把本机文件夹按环境共享给虚拟机。环境运行时，在系统内访问带令牌的地址即可浏览、下载和上传文件；地址即权限，不要粘贴到不信任的位置。<button className="text-button" onClick={()=>setHelp(true)}>使用说明</button></p>
    {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="saved" role="status">{notice}</p>}
    {shares.length?<div className="share-list">{shares.map(share=>{
      const base=guestBase(machine,share),client=curl(machine);
      return <article className="share-row" key={share.id}>
        <div className="share-identity"><Share2 size={17}/><div><strong>{share.name}</strong><small>{share.hostPath}</small></div><span className="share-mode">{share.readOnly?'只读':'可读写'}</span></div>
        {base?<div className="share-commands">
          <code>{base}/</code>
          <div className="inline">
            <button className="text-button" disabled={busy} onClick={()=>void copy(`${client} -O ${base}/文件名`,'下载命令已复制，把“文件名”换成要下载的文件')}>复制下载命令</button>
            {!share.readOnly&&<button className="text-button" disabled={busy} onClick={()=>void copy(`${client} -T 文件名 ${base}/`,'上传命令已复制，把“文件名”换成要上传的文件')}>复制上传命令</button>}
            <button className="text-button" disabled={busy} onClick={()=>setRemoving(share)}>删除</button>
          </div>
          {!live&&<small className="share-state">环境未运行，启动后此地址才可访问。</small>}
        </div>:<div className="share-commands"><small className="share-state">启动环境后会生成访问地址。</small>
          <div className="inline"><button className="text-button" disabled={busy} onClick={()=>setRemoving(share)}>删除</button></div>
        </div>}
      </article>;})}</div>
    :<Empty title="还没有共享文件夹" description="添加一个本机文件夹后，虚拟机里就能通过带令牌的地址读取和上传文件，无需网络配置。"/>}
    <form className="share-add" onSubmit={async e=>{e.preventDefault();await add();}}>
      <div className="form-grid">
        <label>共享名称<input required value={name} onChange={e=>setName(e.target.value)} placeholder="如 data" spellCheck={false} maxLength={32}/></label>
        <label className="share-folder">宿主文件夹<div className="inline">
          <input required value={hostPath} onChange={e=>setHostPath(e.target.value)} placeholder="选择或输入本机文件夹路径" spellCheck={false}/>
          <button type="button" className="button secondary" disabled={working||choosing||busy} onClick={()=>void choose()}>{choosing?<LoaderCircle size={16} className="spin"/>:<FolderOpen size={16}/>}选择文件夹</button>
        </div></label>
      </div>
      <label className="share-readonly"><input type="checkbox" checked={readOnly} onChange={e=>setReadOnly(e.target.checked)}/>只读共享（虚拟机只能读取，不能上传）</label>
      <footer className="modal-foot"><button type="button" className="button secondary" onClick={close}>关闭</button><button className="button primary" disabled={working||busy||!name||!hostPath}>{working?<LoaderCircle size={16} className="spin"/>:<Share2 size={16}/>}添加共享</button></footer>
    </form>
    {help&&<Modal title="宿主目录共享说明" close={()=>setHelp(false)}>
      <p className="field-help">这是文件通道，不是挂载盘：环境运行时，在系统内用返回 JSON 的浏览地址查看文件列表，用下载和上传命令传输单个文件。地址只在虚拟机 NAT 内可达（10.0.2.2）且带令牌；令牌随环境保存，删除共享或关闭环境后立即失效。上传仅支持共享文件夹根目录下的普通文件名，单个文件最大 4 GB；只读共享会拒绝上传。把宿主目录映射为虚拟机内的盘符（挂载式共享）暂不支持。</p>
    </Modal>}
    {removing&&<Modal title="删除共享" close={()=>setRemoving(undefined)}>
      <p>停止共享 {removing.name}（{removing.hostPath}）。宿主文件夹和其中的文件会保留，虚拟机内对应的地址立即失效。</p>
      <footer className="modal-foot"><button className="button secondary" onClick={()=>setRemoving(undefined)}>取消</button><button className="button danger" disabled={busy||working} onClick={async()=>{setWorking(true);try{await action(`machines/${machine.id}/shares/${removing.id}/delete`);setNotice('共享已删除');setRemoving(undefined);}catch(e){setError((e as Error).message);}finally{setWorking(false);}}}>确认删除</button></footer>
    </Modal>}
  </Modal>;
}
