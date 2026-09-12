'use client';
import {Terminal} from 'lucide-react';
import type {Machine} from '@/shared/types';

export function SshAccess({machine,connect}: {machine:Machine;connect:()=>void}) {
  return <div className="ssh-access"><Terminal size={15}/><span>{machine.network?.mode==='bridged'&&!machine.session?.sshPort?'桥接网络':'NAT 内网'}</span>{machine.family!=='windows'&&<code>{machine.session?.sshPort?`SSH 127.0.0.1:${machine.session.sshPort}`:machine.network?.address?`SSH ${machine.network.address}:22`:'SSH 待配置'}</code>}<button className="text-button" onClick={connect}>连接信息与网络设置</button></div>;
}
