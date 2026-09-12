'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, Box } from 'lucide-react';
import { families, type Family, type VmState } from '@/shared/types';
export function OsIcon({family, small = false}: {family: Family; small?: boolean}) {
  return <span className={`os-icon ${family} ${small ? 'small' : ''}`} aria-hidden="true">{families.find(x => x.id === family)?.mark ?? 'L'}</span>;
}
export function Status({state}: {state: VmState}) {
  const labels = {running: '运行中', stopped: '已关闭', starting: '启动中', stopping: '关闭中', error: '启动异常'};
  return <span className={`status ${state}`}><span />{labels[state]}</span>;
}
export function Modal({title, description, children, close, className = ''}: {title: string; description?: string; children: ReactNode; close: () => void; className?: string}) {
  const ref = useRef<HTMLDialogElement>(null), titleId=useId();
  useEffect(() => { const d = ref.current, previous=document.activeElement; d?.showModal(); d?.querySelector<HTMLElement>('[data-modal-autofocus]')?.focus(); return () => {d?.close();if(previous instanceof HTMLElement && previous.isConnected)previous.focus();}; }, []);
  return <dialog ref={ref} className={`modal ${className}`} onCancel={e => {e.preventDefault(); close();}} aria-labelledby={titleId}>
    <header className="modal-head"><div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div><button type="button" className="icon-button" onClick={close} aria-label="关闭对话框"><X size={20}/></button></header>
    {children}
  </dialog>;
}
export function Empty({title, description, children}: {title: string; description: string; children?: ReactNode}) {
  return <div className="empty"><div className="empty-icon"><Box size={32} strokeWidth={1.4}/></div><h3>{title}</h3><p>{description}</p>{children}</div>;
}
export function Bytes({value}: {value: number}) { return <>{(value / 1073741824).toFixed(1)} GB</>; }
