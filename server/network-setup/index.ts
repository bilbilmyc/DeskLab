import {spawn} from 'node:child_process';
import {mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {run} from '../qemu';
import asset,{networkVersion} from '../generated/network';
import type {NetworkSetupOperation,NetworkSetupStatus,PhysicalAdapter} from '../../shared/network';
export const bridgeSetupEnabled=false;

export const setupRequest=z.discriminatedUnion('action',[
  z.object({action:z.literal('validate')}).strict(),
  z.object({action:z.literal('prepare'),adapterId:z.string().uuid()}).strict(),
  z.object({action:z.literal('rollback'),operationId:z.string().uuid()}).strict(),
]);
const operationSchema=z.object({operationId:z.string().uuid(),state:z.enum(['idle','awaiting-admin','preparing','configuring','rolling-back','rolled-back','validated','ready','failed','needs-recovery']),message:z.string(),updatedAt:z.string().optional()});
const operationRoot=()=>join(process.env.ProgramData??'C:\\ProgramData','DeskLab.NetworkSetup');
export async function readOperation(id:string):Promise<NetworkSetupOperation|undefined> {
  if(!z.string().uuid().safeParse(id).success)return;
  try {const file=Bun.file(join(operationRoot(),id,'status.json'));if(file.size>65536)return;return operationSchema.parse(JSON.parse((await file.text()).replace(/^\uFEFF/,'')));}catch{return;}
}
export async function physicalAdapters():Promise<PhysicalAdapter[]> {
  if(process.platform!=='win32')return [];
  const script=String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;ConvertTo-Json -Compress -InputObject @(Get-NetAdapter -Physical | Where-Object { $_.HardwareInterface -and $_.Virtual -eq $false } | ForEach-Object { [pscustomobject]@{id=$_.InterfaceGuid.ToString().Trim('{}');name=$_.Name;description=$_.InterfaceDescription;status=$_.Status.ToString();wireless=($_.NdisPhysicalMedium -eq 9 -or $_.PhysicalMediaType -match '802.11|Wireless')} })`;
  const output=await run(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],15000);
  return z.array(z.object({id:z.string().uuid(),name:z.string(),description:z.string(),status:z.string(),wireless:z.boolean()})).parse(JSON.parse(output));
}
export class NetworkSetup {
  private current?:NetworkSetupOperation;
  private busy=false;
  private adapters?:{at:number;value:PhysicalAdapter[]};
  constructor(private root:string){}
  async status():Promise<NetworkSetupStatus> {
    if(!this.adapters||Date.now()-this.adapters.at>30000)this.adapters={at:Date.now(),value:await physicalAdapters()};
    if(this.current){const saved=await readOperation(this.current.operationId);if(saved&&(saved.updatedAt??'')>=(this.current.updatedAt??''))this.current=saved;}
    const entries=await readdir(operationRoot()).catch(()=>[]);
    const operations=(await Promise.all(entries.map(readOperation))).filter((o):o is NetworkSetupOperation=>!!o);
    operations.sort((a,b)=>(b.updatedAt??'').localeCompare(a.updatedAt??''));
    if(!this.current)this.current=operations[0];
    const recoveryOperations=operations.filter(o=>o.operationId!==this.current?.operationId&&['needs-recovery','preparing','configuring','rolling-back'].includes(o.state));
    return {physicalAdapters:this.adapters.value,operation:this.current,recoveryOperations,canPrepare:false,message:'自动桥接正在进行本机兼容性验证；验证会创建并撤销两块独立 TAP 网卡。物理网络配置暂不开放。'};
  }
  async start(input:unknown) {
    if(!bridgeSetupEnabled)throw new Error('桥接配置已停用，当前版本仅支持 NAT。');
    const request=setupRequest.parse(input);
    if(process.platform!=='win32')throw new Error('网络助手仅支持 Windows');
    if(this.busy)throw new Error('网络助手正在工作，请等待结果');
    if(request.action==='prepare')throw new Error('自动物理桥接尚未通过完整恢复验证，暂不能启用');
    if(request.action==='validate') {
      const entries=await readdir(operationRoot()).catch(()=>[]);
      const operations=await Promise.all(entries.map(readOperation));
      if(operations.some(o=>o&&['needs-recovery','preparing','configuring','rolling-back'].includes(o.state)))throw new Error('先恢复上一次未完成的网络配置，再开始检测');
    }
    const operationId=request.action==='rollback'?request.operationId:crypto.randomUUID();
    if(request.action==='rollback'&&!await readOperation(operationId))throw new Error('未找到 DeskLab 网络配置日志');
    let executable=join(process.cwd(),'.runtime/build/native/DeskLab.NetworkSetup.exe');
    if(!asset) {
      const manifest=await Bun.file(join(process.cwd(),'.runtime/build/native/network-helper.json')).json().catch(()=>null);
      if(manifest&&/^DeskLab\.NetworkSetup-[a-f0-9]{16}\.exe$/.test(manifest.filename))executable=join(process.cwd(),'.runtime/build/native',manifest.filename);
    }
    if(asset&&networkVersion) {
      const directory=join(this.root,'runtime/network',networkVersion);await mkdir(directory,{recursive:true});
      executable=join(directory,'DeskLab.NetworkSetup.exe');
      const bytes=await Bun.file(asset).arrayBuffer();
      if(!await Bun.file(executable).exists()||new Bun.CryptoHasher('sha256').update(await Bun.file(executable).arrayBuffer()).digest('hex')!==networkVersion)await Bun.write(executable,bytes);
    }
    if(!await Bun.file(executable).exists())throw new Error('网络助手尚未构建，请运行 bun run network:build');
    this.busy=true;
    this.current={operationId,state:'awaiting-admin',message:'等待 Windows 管理员授权',updatedAt:new Date().toISOString()};
    const child=spawn(executable,['--interactive',request.action==='validate'?'isolated':'rollback',operationId,'00000000-0000-0000-0000-000000000000'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>{output=(output+chunk).slice(-64000);});child.stderr.resume();
    const finish=async(error?:string)=>{
      const result=await readOperation(operationId);
      this.current=result??{operationId,state:'failed',message:error??'管理员授权取消或网络助手未完成，请重试',updatedAt:new Date().toISOString()};
      this.busy=false;
    };
    child.once('error',e=>void finish(e.message));
    child.once('close',()=>{let message:string|undefined;try{message=JSON.parse(output).message;}catch{}void finish(message);});
    return this.current;
  }
}
