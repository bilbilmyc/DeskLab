'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
import {Activity, Download, RefreshCw} from 'lucide-react';
import type {DiagnosticExport, DiagnosticReport} from '@/shared/diagnostics';

type Action = <T = unknown>(path: string, body?: unknown) => Promise<T>;
export function useDiagnostics(ready: boolean, action: Action, configuration: string) {
  const [report, setReport] = useState<DiagnosticReport>();
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const busy = useRef(false), alive = useRef(true);
  const lastConfiguration = useRef<string | undefined>(undefined);
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  const run = useCallback(async (refresh = true) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError('');
    try {const next = await action<DiagnosticReport>('diagnostics/check', {refresh}); if (alive.current) setReport(next);}
    catch (cause) {if (alive.current) setError(cause instanceof Error ? cause.message : '体检失败，请重试。');}
    finally {busy.current = false; if (alive.current) setPending(false);}
  }, [action]);
  useEffect(() => {
    if (ready && !pending && lastConfiguration.current !== configuration) {
      lastConfiguration.current = configuration; void run(false);
    }
  }, [ready, configuration, run, pending]);
  return {report, pending, error, run};
}
export type DiagnosticState = ReturnType<typeof useDiagnostics>;
const labels = {pass: '通过', warning: '需留意', fail: '需处理', unknown: '未确认'};
export function DiagnosticsSummary({state, open}: {state: DiagnosticState; open: () => void}) {
  const {report, pending, error} = state;
  return <div className="diagnostics-summary" role="status"><Activity size={17}/><span>{pending ? '正在检查本机运行条件…' : error ? '本机体检未完成' : report ? `本机体检：${report.summary.fail} 项需处理 · ${report.summary.warning} 项需留意 · ${report.summary.unknown} 项未确认` : '准备本机体检'}</span><button className="text-button" onClick={open}>查看体检</button></div>;
}
export function DiagnosticsPanel({state, action}: {state: DiagnosticState; action: Action}) {
  const {report, pending, error, run} = state;
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState(''), [downloaded, setDownloaded] = useState(false);
  async function download() {
    setExporting(true); setExportError(''); setDownloaded(false);
    try {
      const data = await action<DiagnosticExport>('diagnostics/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
      const link = document.createElement('a'); link.href = url; link.download = `DeskLab-diagnostics-${data.exportedAt.replace(/[:.]/g, '-')}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloaded(true);
    } catch (cause) {setExportError(cause instanceof Error ? cause.message : '导出失败，请重试。');}
    finally {setExporting(false);}
  }
  return <section className="panel diagnostics-panel" aria-labelledby="diagnostics-title" aria-busy={pending}>
    <div className="diagnostics-heading"><div><h2 id="diagnostics-title">本机体检</h2><p>打开页面自动检查；修改配置后更新。目录权限通过创建并删除临时文件验证，不会启动虚拟机或修改 Windows 功能。</p></div>
      <div className="diagnostics-actions"><button className="button secondary" disabled={pending || exporting} onClick={() => void run()}><RefreshCw size={15} className={pending ? 'spin' : ''}/>{pending ? '正在检测…' : '重新检测'}</button><button className="button secondary" disabled={pending || exporting || !report} onClick={() => void download()}><Download size={15}/>{exporting ? '正在导出…' : '导出诊断日志'}</button></div>
    </div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!report && !error && <p role="status">正在读取运行组件、Windows 虚拟化、存储与端口信息…</p>}
    {report && <><p className="diagnostics-meta" role="status">{pending ? '正在刷新，以下为上次结果。' : '检查完成。'} {new Date(report.checkedAt).toLocaleString()} · {report.summary.pass} 项通过 / {report.summary.fail} 项需处理 / {report.summary.warning} 项需留意 / {report.summary.unknown} 项未确认</p>
      <ul className="diagnostics-checks">{report.checks.map(check => <li key={check.id}><div><strong>{check.title}</strong><span className={`diagnostic-status diagnostic-${check.status}`}>{labels[check.status]}</span></div><p>{check.detail}</p>{check.remedy && check.status !== 'pass' && <p className="diagnostic-remedy">处理建议：{check.remedy}</p>}</li>)}</ul></>}
    <p className="field-help">导出 JSON 包含体检结果和本次运行最近 100 条受支持操作的状态与错误类别；不含原始日志、路径、实例名称、密钥、环境变量或客体输出。仅下载到本机，不上传。</p>
    {exportError && <p role="alert" className="form-error">{exportError}</p>}{downloaded && <p role="status" className="saved">诊断文件已交给浏览器下载。</p>}
  </section>;
}
