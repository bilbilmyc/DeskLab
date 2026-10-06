'use client';
import {useEffect, useState} from 'react';
import {LoaderCircle} from 'lucide-react';
import type {RestorePointOperation} from '@/shared/restore-points';

const stages: Record<RestorePointOperation['stage'], string> = {
  preparing: '正在检查环境和可用空间', copying: '正在复制系统磁盘',
  verifying: '正在校验磁盘和启动信息', committing: '正在保存还原点状态', cleaning: '正在清理临时文件',
};
const kinds = {create: '创建还原点', restore: '恢复还原点', delete: '删除还原点'};
export function RestorePointStatus({operation}: {operation: RestorePointOperation}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);}, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(operation.startedAt)) / 1000));
  const elapsed = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return <div className="notice">
    <LoaderCircle size={16} className="spin" aria-hidden="true"/>
    <span><span role="status">{kinds[operation.kind]}：{stages[operation.stage]}</span> · 已耗时 {elapsed}。请保持程序运行。</span>
  </div>;
}
