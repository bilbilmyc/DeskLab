'use client';
import {useEffect, useRef, useState} from 'react';
import {History, LoaderCircle, Plus, RotateCcw, Trash2} from 'lucide-react';
import type {Machine} from '@/shared/types';
import {Modal} from './primitives';

export function RestorePointsPanel({machine, busy, action, close}: {
  machine: Machine; busy: boolean; action: (path: string, body?: unknown) => Promise<unknown>; close: () => void;
}) {
  const [name, setName] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<{id: string; kind: 'restore' | 'delete'}>();
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {cancelButton.current?.focus();}, [confirmation]);
  const points = [...(machine.restorePoints ?? [])].reverse();
  const selected = points.find(point => point.id === confirmation?.id);
  const stopped = machine.state === 'stopped' && !machine.session;
  const installing = !!machine.installation && machine.installation.phase !== 'ready';
  const createDisabled = !stopped || installing || !!machine.isoPath || busy;
  async function perform(path: string, body: unknown, message: string) {
    setError(''); setNotice('');
    try {await action(path, body); setNotice(message); setConfirmation(undefined); return true;}
    catch (cause) {setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); return false;}
  }
  return <Modal title={`${machine.name} · 还原点`} className="restore-points-modal" close={() => {if (!busy) close();}}>
    <p className="field-help">停机后保存系统磁盘和 UEFI 启动信息。每个还原点独立占用磁盘空间，CPU、内存和端口映射不随恢复改变。</p>
    {!stopped && <p className="notice">请先正常关闭环境，确认进程已退出，再创建、恢复或删除还原点。</p>}
    {stopped && installing && <p className="notice">请先完成自动安装，再创建或恢复还原点。</p>}
    {stopped && !installing && machine.isoPath && <p className="notice">创建前请先完成系统安装，并在“更多操作”中弹出 ISO。</p>}
    {busy && <p className="notice" role="status"><LoaderCircle className="spin" size={15}/>正在处理磁盘，请保持 DeskLab 运行。较大的磁盘可能需要几分钟。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="saved" role="status">{notice}</p>}
    {selected && confirmation ? <form className="restore-point-confirmation" onSubmit={async event => {
      event.preventDefault();
      await perform(`machines/${machine.id}/restore-points/${selected.id}/${confirmation.kind}`, {confirm: true}, confirmation.kind === 'restore' ? '已恢复到选定还原点，环境保持关闭。' : '还原点已删除，当前环境磁盘保留。');
    }}>
      <h3>{confirmation.kind === 'restore' ? '确认恢复' : '确认删除还原点'}</h3>
      <p>{confirmation.kind === 'restore' ? `将“${machine.name}”恢复到“${selected.name}”。此后未保存为还原点的磁盘更改会丢失，当前挂载的 ISO 会卸下。还原点本身保留，恢复后可手动启动。` : `永久删除还原点“${selected.name}”，释放它占用的空间。当前系统磁盘及其他还原点保留。`}</p>
      <footer className="modal-foot"><button ref={cancelButton} type="button" className="button secondary" disabled={busy} onClick={() => {setConfirmation(undefined); setError('');}}>取消</button><button className="button danger" disabled={busy || !stopped || (confirmation.kind === 'restore' && installing)}>{confirmation.kind === 'restore' ? '确认恢复' : '确认删除还原点'}</button></footer>
    </form> : <>
      <form className="restore-point-create" onSubmit={async event => {
        event.preventDefault();
        if (await perform(`machines/${machine.id}/restore-points`, {name: name.trim()}, '还原点已创建。')) setName('');
      }}>
        <label>还原点名称<input value={name} onChange={event => setName(event.target.value)} maxLength={64} required disabled={createDisabled} placeholder="例如：依赖已安装、测试前"/></label>
        <button className="button primary" disabled={createDisabled || !name.trim()}><Plus size={16}/>创建还原点</button>
      </form>
      <div className="restore-point-list" role="region" aria-label="已保存的还原点" tabIndex={0}>
        {!points.length ? <p className="restore-point-empty"><History size={22}/>暂无还原点。先保存一个测试起点。</p> : <ul>{points.map(point => <li key={point.id}>
          <div className="restore-point-identity"><strong>{point.name}</strong><small>{new Date(point.createdAt).toLocaleString()} · {(point.bytes / 1048576).toLocaleString(undefined, {maximumFractionDigits: 1})} MiB</small></div>
          <div className="restore-point-actions"><button className="button secondary compact" aria-label={`恢复到 ${point.name}`} disabled={busy || !stopped || installing} onClick={() => {setConfirmation({id: point.id, kind: 'restore'}); setError(''); setNotice('');}}><RotateCcw size={15}/>恢复</button><button className="icon-button" aria-label={`删除还原点 ${point.name}`} disabled={busy || !stopped} onClick={() => {setConfirmation({id: point.id, kind: 'delete'}); setError(''); setNotice('');}}><Trash2 size={16}/></button></div>
        </li>)}</ul>}
      </div>
      <p className="field-help">还原点随环境一起保存和删除。完整备份应包含整个数据目录；还原点不替代异地备份。</p>
    </>}
  </Modal>;
}
