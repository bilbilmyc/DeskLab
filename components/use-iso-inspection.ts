'use client';
import {useEffect,useState} from 'react';
import type {Family} from '@/shared/types';
import type {IsoInspection} from '@/shared/iso-inspection';
export type InspectIso=(input:{path:string;family:Family;recipeId?:string},signal:AbortSignal)=>Promise<IsoInspection>;
export function useIsoInspection(path:string,family:Family,recipeId:string|undefined,enabled:boolean,inspect:InspectIso){
  const [attempt,setAttempt]=useState(0),key=JSON.stringify([path.trim(),family,recipeId,enabled,attempt]);
  const [state,setState]=useState<{key:string;result?:IsoInspection;error?:string}>();
  useEffect(()=>{
    if(!enabled||!path.trim())return;
    const controller=new AbortController();let active=true;
    const timer=setTimeout(()=>{void inspect({path:path.trim(),family,recipeId},controller.signal).then(result=>{
      if(!['match','mismatch','unknown'].includes(result.status))throw new Error('无法读取安装盘检查结果，请重试');
      if(active)setState({key,result});
    }).catch(error=>{if(active)setState({key,error:error instanceof Error?error.message:'安装盘检查失败'});});},300);
    return()=>{active=false;clearTimeout(timer);controller.abort();};
  },[path,family,recipeId,enabled,inspect,key]);
  const current=state?.key===key?state:undefined;
  return {key,result:current?.result,error:current?.error,loading:enabled&&!!path.trim()&&!current,retry:()=>setAttempt(n=>n+1)};
}
