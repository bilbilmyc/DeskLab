'use client';
import {useState} from 'react';
import type {Machine} from '@/shared/types';
import type {MachineNetwork} from '@/shared/network';
import {authorizeKeyCommand,sshCommand,type SshKeyInfo} from '@/shared/ssh';
import {Modal} from './primitives';
import {NetworkFields} from './network-fields';
function CopyCommand({value,label}: {value:string;label:string}) {
  const [copied,setCopied]=useState(false);
  return <div className="connection-command"><code>{value}</code><button type="button" className="button secondary compact" aria-label={label} onClick={()=>void navigator.clipboard.writeText(value).then(()=>setCopied(true)).catch(()=>setCopied(false))}>{copied?'已复制':'复制'}</button></div>;
}
export function ConnectionInfo({machine,sshKey,prepareKey,save,close,busy}: {machine:Machine;sshKey?:SshKeyInfo;prepareKey:()=>Promise<SshKeyInfo>;save:(network:MachineNetwork)=>Promise<unknown>;close:()=>void;busy:boolean}) {
  const [network,setNetwork]=useState<MachineNetwork>(machine.network??{mode:'nat'}),[username,setUsername]=useState('root'),[key,setKey]=useState(sshKey),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  const live=['running','starting','stopping'].includes(machine.state)||!!machine.session;
  const actual=machine.network?.mode==='bridged'&&!machine.session?.sshPort?'bridged':'nat';
  const host=actual==='nat'?'127.0.0.1':undefined,port=actual==='nat'?machine.session?.sshPort:undefined;
  const userValid=/^[a-z_][a-z0-9_-]{0,31}$/.test(username);
  const provisioned=key&&machine.sshKeyFingerprint===key.fingerprint;
  return <Modal title={`${machine.name} · 连接与网络`} close={close}>
    {machine.family!=='windows'&&<section className="connection-section"><h3>SSH 密钥连接</h3>
      <p>{actual==='nat'?'通过 Windows 本机端口连接。':'当前实例使用旧网络配置，请正常关机后切换 NAT。'}{!live&&' 启动后显示实际连接端口。'}</p>
      <label>SSH 用户名<input aria-label="SSH 用户名" value={username} onChange={e=>setUsername(e.target.value)} maxLength={32}/></label>
      {key?<><p className="field-help">本机 Ed25519 密钥 · {provisioned?'公钥已随系统配置，登录时验证':'已有镜像需先授权公钥'}</p><p className="key-fingerprint">{key.fingerprint}</p>
        {host&&port&&userValid?<CopyCommand label="复制密钥 SSH 命令" value={sshCommand(host,port,username,key)}/>:<p className="notice">{actual==='bridged'?'请切换并保存 NAT 配置，再启动实例。':'实例启动且用户名有效后，将显示连接命令。'}</p>}
        <details open={!provisioned}><summary>公钥授权与密钥位置</summary><p className="field-help">私钥保存在 Windows：<code>{key.privateKeyPath}</code>。不会通过接口传出私钥内容。新装 Linux 自动授权；旧系统请在实例控制台以 root 执行下面的命令，再使用密钥连接。其他用户需要将公钥放到对应用户的 authorized_keys。</p><CopyCommand label="复制公钥授权命令" value={authorizeKeyCommand(key.publicKey)}/><p className="field-help">不会覆盖已有公钥，也不会更改旧系统的密码登录策略。重装或删除密钥前，请先为实例配置新的公钥。</p></details>
      </>:<button type="button" className="button secondary" disabled={busy} onClick={()=>void prepareKey().then(setKey).catch(e=>setError(e.message))}>生成本机 SSH 密钥</button>}
      {machine.sshError&&<p className="notice">{machine.sshError}</p>}
    </section>}
    <form onSubmit={e=>{e.preventDefault();setError('');setSaved(false);void save(network).then(()=>setSaved(true)).catch(e=>setError(e.message));}}>
      <NetworkFields value={network} change={setNetwork} disabled={live||busy}/>
      {live&&<p className="field-help">网络设置在正常关机后可修改。NAT 连接信息以本次启动分配的端口为准。</p>}
      {error&&<p className="form-error" role="alert">{error}</p>}{saved&&<p className="saved" role="status">网络配置已保存</p>}
      <footer className="modal-foot"><button type="button" className="button secondary" onClick={close}>关闭</button><button className="button primary" disabled={busy}>保存网络配置</button></footer>
    </form>
  </Modal>;
}
