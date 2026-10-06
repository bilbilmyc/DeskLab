'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LabSnapshot } from '@/shared/types';
import type {InspectIso} from './use-iso-inspection';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';
const connectionLost = '无法连接本地服务，请确认 DeskLab 程序仍在运行。正在自动重连。';
export function useLab() {
  const [data, setData] = useState<LabSnapshot | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting'), [connectionError, setConnectionError] = useState('');
  const token = useRef(''), mutating = useRef(false), alive = useRef(true), stopped = useRef(false);
  const connection = useRef<ConnectionState>('connecting'), generation = useRef(0), stateRequest = useRef(0);
  const lifetime = useRef(new AbortController());
  const [exited, setExited] = useState(false);
  const refresh = useCallback(async () => {
    if (!alive.current || stopped.current) return;
    const owner = generation.current, request = ++stateRequest.current;
    const current = () => alive.current && !stopped.current && generation.current === owner && stateRequest.current === request;
    try {
      const response = await fetch('/api/state', {cache: 'no-store', signal: AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(15000)])});
      if (!response.ok) throw new Error(connectionLost);
      const result = await response.json();
      if (!current()) return;
      token.current = result.token; connection.current = 'connected';
      setData(result); setConnectionState('connected'); setConnectionError('');
    } catch (cause) {
      if (!current()) return;
      connection.current = 'disconnected'; setConnectionState('disconnected');
      setConnectionError(cause instanceof DOMException && cause.name === 'TimeoutError' ? '本地服务响应超时，正在自动重连。显示的是上次读取的状态。' : connectionLost);
    }
  }, []);
  useEffect(() => {
    alive.current = true; lifetime.current = new AbortController(); ++generation.current;
    let polling = false;
    const poll = () => {
      if (polling || stopped.current) return;
      polling = true;
      void refresh().finally(() => {polling = false;});
    };
    poll(); const timer = setInterval(poll, 1000);
    return () => {alive.current = false; ++generation.current; lifetime.current.abort(); clearInterval(timer);};
  }, [refresh]);

  const requestJson = useCallback(async (path: string, body: unknown, signal: AbortSignal) => {
    if (!alive.current || stopped.current || connection.current !== 'connected') throw new Error('本地服务尚未连接，操作未发送。请等待自动重连后再试。');
    const owner = generation.current, revision = stateRequest.current;
    let response: Response, result: unknown;
    try {
      response = await fetch(`/api/${path}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-lab-token': token.current}, body: JSON.stringify(body), signal: AbortSignal.any([signal, lifetime.current.signal])});
      result = await response.json();
    } catch (cause) {
      if (alive.current && !stopped.current && generation.current === owner && stateRequest.current === revision && !(cause instanceof DOMException && cause.name === 'AbortError')) {
        ++stateRequest.current; connection.current = 'disconnected'; setConnectionState('disconnected'); setConnectionError(connectionLost);
      }
      throw cause;
    }
    if (!alive.current || stopped.current || generation.current !== owner) throw new DOMException('页面已离开', 'AbortError');
    if (!response.ok) throw new Error((result as {error?: string}).error || '操作失败');
    return result;
  }, []);
  const action = useCallback(async <T = unknown>(path: string, body: unknown = {}): Promise<T> => {
    // Read-only requests do not lock forms. Disk operations can take several minutes.
    if (path.endsWith('/console') || path === 'files/list' || path.startsWith('diagnostics/')) {
      const diagnostic = path.startsWith('diagnostics/');
      try {return await requestJson(path, body, AbortSignal.timeout(diagnostic ? 45000 : 15000)) as T;}
      catch (cause) {if (cause instanceof DOMException && cause.name === 'TimeoutError') throw new Error(diagnostic ? '体检超时，请稍后重新检测。' : '读取超时，请重试或选择其他文件夹'); throw cause;}
    }
    if (mutating.current) throw new Error('请等待当前操作完成');
    if (connection.current !== 'connected') throw new Error('本地服务尚未连接，操作未发送。请等待自动重连后再试。');
    const owner = generation.current;
    mutating.current = true; setBusy(path); setError('');
    try {
      const result = await requestJson(path, body, lifetime.current.signal);
      if (path === 'app/quit') {stopped.current = true; ++stateRequest.current; setExited(true);}
      else await refresh(); // A failed refresh must not turn a confirmed write into a failed write.
      return result as T;
    } catch (cause) {
      if (alive.current && generation.current === owner && !stopped.current) setError(cause instanceof TypeError || (cause instanceof DOMException && cause.name === 'TimeoutError') ? '请求中断，操作结果尚未确认。请等待重连并核对环境状态，避免重复提交。' : cause instanceof Error ? cause.message : '操作失败');
      throw cause;
    } finally {
      if (generation.current === owner) {mutating.current = false; if (alive.current) setBusy('');}
    }
  }, [refresh, requestJson]);
  const inspectIso = useCallback<InspectIso>((input, signal) => requestJson('isos/inspect', input, AbortSignal.any([signal, AbortSignal.timeout(15000)])) as ReturnType<InspectIso>, [requestJson]);
  return {data, error, connectionState, connectionError, busy: busy || (data?.restorePointOperation ? `machines/${data.restorePointOperation.machineId}/restore-points` : ''), action, refresh, exited, inspectIso, clearError: () => setError('')};
}
