# 桌面服务与工程目录调整

## 实施范围与上下文

- SSH：`server/lab.ts` 创建和恢复 QEMU，`server/qemu.ts` 提供 QMP；当前 `-nic user,model=e1000` 没有入站转发。新增本机 SSH 端口分配、恢复及界面连接信息，保留已有磁盘和登录配置。
- 托盘：`server/app.ts` 拥有服务生命周期，`server/startup.ts` 打开浏览器，`server/process-lock.ts` 保证单实例。新增 Windows 原生托盘辅助程序，通过父子进程标准输入输出传递菜单事件，复用服务退出保护。
- 打包：`scripts/build/package.ts`、`scripts/build/installer.ts`、`installer/DeskLab.iss` 负责输出。应用统一到 `dist/app/`，安装包统一到 `dist/installer/`，辅助编译文件统一到 `.runtime/build/`。根目录不再复制 EXE。
- 脚本：构建脚本放 `scripts/build/`，集成验证放 `scripts/checks/`，ISO 工具放 `scripts/iso/`；同步命令、相对导入和文档。
- 验证：新增 SSH 映射/托盘协议和生命周期检查；保留既有启动、恢复、分发与安装测试。Docker 只输出独立规划。

## 兼容与风险

- 已运行的虚拟机通过已验证身份的 QMP 添加本地转发，不强制重启、不修改客户系统 SSH 策略。
- SSH 默认只监听 Windows 本机回环地址。每个 Linux 环境分配独立端口；显示实际端口。
- 托盘退出与浏览器退出使用同一保护，存在运行中环境时不强制断电。关闭浏览器不等于关闭服务，托盘保持可见。
- 目录整理不移动正在使用的安装目录、用户数据、ISO 和虚拟磁盘；历史验证产物归档，保持可追溯。
- 根目录仍保留 Next.js 必需入口及工具配置；不借目录整理改写业务模块结构。

上下文已按调用链和现有测试完成检查，按以上范围实施。
