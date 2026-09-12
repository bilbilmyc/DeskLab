import {open,realpath,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import type {IsoInspection} from '../shared/iso-inspection';
import type {Family} from '../shared/types';
import {readIsoLabel} from './install-media';
import {isoSources,type IsoSource} from './iso-sources';
import {family as familyInput} from './validation';

const names:Record<Family,string>={ubuntu:'Ubuntu',debian:'Debian',rocky:'Rocky Linux',windows:'Windows',linux:'其他 Linux'};
const input=z.object({path:z.string().trim().min(1).max(2048),family:familyInput,recipeId:z.string().optional()}).strict();
export function familyFromIsoLabel(label:string):Family|undefined {
  if(/\bubuntu\b/i.test(label))return 'ubuntu';
  if(/\bdebian\b|^d-live\s/i.test(label))return 'debian';
  if(/\brocky\b/i.test(label))return 'rocky';
  if(/windows|^(?:CCCOMA|CPRA|CENA|SSS|SERVER_EVAL|CLIENT).*_(?:X64|X86)|^WIN(?:10|11|SERVER)/i.test(label))return 'windows';
}
async function sourcePath(path:string){
  if(!isAbsolute(path)||! /\.iso$/i.test(path))throw new Error('请选择本机 ISO 文件的完整路径');
  let resolved:string;
  try{resolved=await realpath(path);}catch{throw new Error('找不到或无法读取这个安装盘，请检查路径或重新选择文件');}
  const file=await stat(resolved);
  if(!file.isFile())throw new Error('安装盘路径必须指向普通文件');
  return {resolved,file};
}
export async function inspectIso(value:unknown):Promise<IsoInspection> {
  const data=input.parse(value),{resolved,file}=await sourcePath(data.path);
  const expected=data.recipeId?isoSources.find(s=>s.id===data.recipeId):undefined;
  if(data.recipeId&&!expected)throw new Error('自动安装模板不存在');
  // Only internal volume metadata is used for detection. Renaming the file is irrelevant.
  const label=await readIsoLabel(resolved).catch(()=>undefined),detectedFamily=label?familyFromIsoLabel(label):undefined;
  const suggested=isoSources.find(s=>s.family===detectedFamily&&s.bytes===file.size&&['ubuntu-server','debian-server','rocky-server','windows-desktop','windows-server'].includes(s.id));
  const info={label,detectedFamily,suggestedRecipeId:suggested?.id,requiresConfirmation:false};
  if(detectedFamily&&detectedFamily!==data.family)return {...info,status:'mismatch',message:`所选系统是 ${names[data.family]}，安装盘内部标识为 ${names[detectedFamily]}。请更换安装盘或切换系统。`};
  if(expected&&file.size!==expected.bytes)return {...info,status:'mismatch',message:`此自动安装模板需要 ${expected.file}，所选文件大小不匹配。请更换对应版本，或改用手动安装。`};
  if(expected)return {...info,status:'match',message:expected.sha256?`安装盘初步匹配 ${expected.name}。创建前将校验完整性。`:`安装盘大小匹配 ${expected.name}。此版本缺少官方校验值，无法确认完整性。`};
  if(detectedFamily)return {...info,status:'match',message:`识别为 ${names[detectedFamily]}，与所选系统一致。将按安装盘向导手动安装。`};
  return {...info,status:'unknown',requiresConfirmation:true,message:'无法从安装盘内部标识识别系统。请确认系统类型；手动安装需自行配置账号与 SSH。'};
}
export async function verifyAutomaticIso(path:string,source:IsoSource) {
  const {resolved}=await sourcePath(path),handle=await open(resolved,'r');
  try{
    const before=await handle.stat();
    if(before.size!==source.bytes)throw new Error(`此模板需要 ${source.file}，所选 ISO 大小不匹配`);
    const hash=new Bun.CryptoHasher('sha256');let bytes=0;
    for await(const chunk of handle.createReadStream({autoClose:false})){hash.update(chunk);bytes+=chunk.length;if(bytes>=16*1024*1024){bytes=0;await Bun.sleep(0);}}
    const after=await stat(resolved);
    if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('安装盘在校验期间发生变化，请重新选择');
    if(source.sha256&&hash.digest('hex')!==source.sha256)throw new Error(`安装盘完整性校验失败，需要 ${source.file}。未创建实例，请重新下载对应安装盘。`);
  }finally{await handle.close();}
}
export async function validateSelectedIso(path:string,family:Family,recipeId?:string,confirmed=false){
  const result=await inspectIso({path,family,recipeId});
  if(result.status==='mismatch'||result.requiresConfirmation&&!confirmed)throw new Error(result.message);
  if(recipeId)await verifyAutomaticIso(path,isoSources.find(s=>s.id===recipeId)!);
}
