'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LabSnapshot } from '@/shared/types';
import type {InspectIso} from './use-iso-inspection';
export function useLab() {
  const [data, setData] = useState<LabSnapshot | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const token = useRef(''), mutating = useRef(false), alive = useRef(true), stopped=useRef(false);
  const [exited,setExited]=useState(false);
  const refresh = useCallback(async () => {
    if(stopped.current)return;
    const response = await fetch('/api/state', {cache: 'no-store'});
    if (!response.ok) throw new Error('无法连接本地服务，请确认 DeskLab 程序仍在运行。');
    const result = await response.json(); token.current = result.token;
    if (alive.current&&!stopped.current) setData(result);
  }, []);
  useEffect(() => {
    alive.current = true;
    let polling = false;
    const poll = () => {
      if (polling||stopped.current) return;
      polling = true;
      void refresh().catch(e => { if (alive.current&&!stopped.current) setError(e.message); }).finally(() => { polling = false; });
    };
    poll(); const timer = setInterval(poll, 1000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);
  const action = useCallback(async <T = unknown>(path: string, body: unknown = {}): Promise<T> => {
    // Browsing files and getting console tickets do not mutate the lab or lock its forms.
    if (path.endsWith('/console') || path==='files/list') {
      const response = await fetch(`/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json','x-lab-token':token.current},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)}).catch(error=>{if(error.name==='TimeoutError')throw new Error('读取超时，请重试或选择其他文件夹');throw error;});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'读取失败');return result;
    }
    if (mutating.current) throw new Error('请等待当前操作完成');
    mutating.current = true; setBusy(path); setError('');
    try {
      const response = await fetch(`/api/${path}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-lab-token': token.current}, body: JSON.stringify(body)});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '操作失败');
      if(path==='app/quit'){stopped.current=true;setExited(true);}else await refresh();
      return result;
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); throw e; }
    finally { mutating.current = false; setBusy(''); }
  }, [refresh]);
  const inspectIso=useCallback<InspectIso>(async(input,signal)=>{
    const response=await fetch('/api/isos/inspect',{method:'POST',headers:{'Content-Type':'application/json','x-lab-token':token.current},body:JSON.stringify(input),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'安装盘检查失败');return result;
  },[]);
  return {data, error, busy, action, refresh, exited, inspectIso, clearError: () => setError('')};
}
