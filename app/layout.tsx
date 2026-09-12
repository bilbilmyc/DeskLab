import type { Metadata } from 'next';
import './globals.css';
import './settings-cards.css';
import './template-cards.css';
import './workspace-layout.css';
import './docker-workspace.css';
import './workbench-theme.css';
import './readability.css';
import './create-dialog.css';
export const metadata: Metadata = {title: 'DeskLab · 本地桌面实验室', description: '创建、使用和恢复本机上的 Windows 与 Linux 测试环境', icons: {icon: '/icon.svg'}};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
