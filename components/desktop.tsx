'use client';
import { useEffect, useRef, useState } from 'react';
import { Maximize, RefreshCw, Keyboard, Monitor } from 'lucide-react';
import type { Machine } from '@/shared/types';
import { OsIcon, Status } from './primitives';
import {SshAccess} from './ssh-access';
type Rfb = {disconnect: () => void; sendCtrlAltDel: () => void; scaleViewport: boolean; resizeSession: boolean; focus: () => void; addEventListener: (event: string, callback: (event: CustomEvent) => void) => void;};
export function Desktop({machine, ticket,connect}: {machine: Machine; ticket: (id: string) => Promise<string>;connect:()=>void}) {
  const target = useRef<HTMLDivElement>(null), frame = useRef<HTMLDivElement>(null), rfb = useRef<Rfb | null>(null);
  const [message, setMessage] = useState('正在连接桌面…'), [connected, setConnected] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let canceled = false; let connection: Rfb | undefined;
    setConnected(false); setMessage('正在连接桌面…');
    async function connect() {
      try {
        const key = await ticket(machine.id);
        const {default: RFB} = await import('@novnc/novnc');
        if (canceled || !target.current) return;
        connection = new RFB(target.current, `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/vnc?ticket=${encodeURIComponent(key)}`) as Rfb;
        rfb.current = connection; connection.scaleViewport = true; connection.resizeSession = false;
        connection.addEventListener('connect', () => { if (!canceled) {setConnected(true); setMessage(''); connection?.focus();} });
        connection.addEventListener('disconnect', () => { if (!canceled) {setConnected(false); setMessage('桌面连接已断开。环境仍在运行时，可以重新连接。');} });
        connection.addEventListener('securityfailure', () => {if (!canceled) setMessage('桌面认证失败，请重新连接。');});
      } catch (e) {if (!canceled) setMessage(e instanceof Error ? e.message : '连接失败');}
    }
    void connect(); return () => {canceled = true; connection?.disconnect(); rfb.current = null;};
  }, [machine.id, machine.session?.pid, attempt, ticket]);
  return <section className="desktop-frame" ref={frame}>
    <div className="desktop-toolbar"><div className="inline"><OsIcon family={machine.family} small/><strong>{machine.name}</strong><Status state={machine.state}/></div><div className="inline"><button className="button secondary compact" disabled={!connected} onClick={() => rfb.current?.sendCtrlAltDel()}><Keyboard size={16}/>Ctrl Alt Del</button><button className="icon-button" title="重新连接" aria-label="重新连接桌面" onClick={() => setAttempt(x => x+1)}><RefreshCw size={17}/></button><button className="icon-button" title="全屏" aria-label="全屏桌面" onClick={() => void frame.current?.requestFullscreen()}><Maximize size={17}/></button></div></div>
    <SshAccess machine={machine} connect={connect}/>
    <div className="desktop-screen"><div ref={target} className="vnc-target"/>{!connected && <div className="desktop-message"><Monitor size={40} strokeWidth={1.2}/><p>{message}</p><button className="button secondary" onClick={() => setAttempt(x => x + 1)}>重新连接</button></div>}</div>
    <div className="desktop-caption" role="status">{machine.installation&&machine.installation.phase!=='ready'?machine.installation.message+' 安装期间可以返回工作空间，请保持 DeskLab 运行。':'鼠标和键盘输入会发送到此环境。关闭标签页不会关闭虚拟机。'}</div>
  </section>;
}
