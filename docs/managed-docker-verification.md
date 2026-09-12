# 独立 Docker 引擎实现与验证

版本：0.3.0，2026-09-12。当前实测宿主为本项目 Windows x64 + WHPX。

已实现：预构建 Ubuntu Minimal 24.04/Docker 29.7.2 组件、独立 Windows CLI/Compose、每引擎 mTLS、系统/数据双盘、Docker 和 containerd 持久化、双层 TCP/UDP 转发、按需启动、正常退出、QGA 剩余空间、资源调整、完整停机备份/恢复、系统重建和中断恢复事务。普通 VM 与外部 Docker 的生命周期保持独立。

## 可重跑验证

- `bun test tests`：116 项通过、1 项权限环境相关测试跳过、0 项失败。包含 SQLite v1→v2 一致备份、引擎凭据与 SAN、恢复事务提交前/后中断，以及切换引擎期间的操作隔离。最终结果记录于 `.runtime/checks/unit-tests-0.3-final.log`。
- `bun scripts/checks/docker-managed/bootstrap.ts`：实际 WHPX 启动、离线预装组件、mTLS、Compose、正常关机。首轮准备至 Docker 就绪约 21 秒，仅是本机一次观测，不是性能承诺。
- `bun scripts/checks/docker-managed/services.ts`：真实 HTTP、UDP、重复端口拒绝、停止/重启后的固定入口、Compose Nginx、Redis 数据卷 down/up 保留、退出后 QEMU 消失；12 项通过。
- `bun scripts/checks/docker-managed/backup-restore.ts <隔离 services 目录>`：屏蔽系统 Docker PATH 和 Desktop 客户端目录，验证独立工具、客体剩余空间、完整备份、恢复先前 Redis 值、错误客户端证书拒绝、重建系统盘保留数据、完整退出；7 项通过。
- `bun scripts/checks/desktop-service-smoke.ts`：打包程序、托盘、普通 VM NAT/SSH、运行时 TCP/UDP 映射、退出保护；浏览器脚本包含 97 项原有界面检查、19 项 Docker/映射检查和 25 项内置引擎检查，均通过。
- `bun scripts/checks/docker-managed/installed.ts`：11 项通过。从完整安装包安装到隔离目录，屏蔽外部 Docker 路径，通过打包 API 初始化、HTTP、退出、重开不自启、容器数据保留验证。报告：`.runtime/checks/docker-managed/installed-M1r5Tj/report.json`。
- `bun scripts/checks/installer-smoke.ts`：安装、覆盖升级和卸载保留用户数据，全部通过；报告：`.runtime/checks/installer-check-1789216892583/result.json`。

Windows 隔离测试须同时覆盖 `ProgramFiles`、`ProgramW6432` 和 `ProgramFiles(x86)`，并清除大小写重复的 PATH，否则系统会恢复实际 Desktop 安装路径。

## 当前工作机安装结果

已将 `D:\apps\DeskLab` 从 0.2.0 覆盖升级至 0.3.0，安装 EXE 与经过验证的构建 SHA-256 一致。升级前正常关闭 Ubuntu，备份旧程序和元数据，完成 schema v2 迁移。原有 1 台 Ubuntu、1 个模板的 ID 保留，Ubuntu 已恢复运行，`127.0.0.1:2222` 返回 SSH 服务标识；已有外部 Docker 容器 ID 集合保持不变。

正式目录中的内置引擎已初始化并通过 mTLS 就绪检查，随后正常停止，未留引擎 QEMU 进程；默认 2 核、2048 MB、64 GB 稀疏数据盘。引擎 ID 为 `540075a8-c6f4-473b-bbca-7376e51e6fcb`。升级报告与旧程序备份：`.runtime/backups/before-managed-0.3-1789217161645/`；9 项检查通过。安装版页面无浏览器运行错误，截图为 `.runtime/checks/docker-managed/ui/installed-0.3.png`。

浏览器脚本需要设置 `PLAYWRIGHT_MODULE_PATH` 为可用的 Playwright 模块绝对路径。所有实机测试使用 `.runtime/checks/` 的隔离数据，不重置用户实例或修改既有外部容器。

## 验证边界

“无 Desktop 依赖”已通过屏蔽系统 Docker CLI 和 Desktop 路径、使用独立 Linux VM/工具验证；当前宿主仍安装有 Docker Desktop，尚未在另一台从未安装 Desktop 的 Windows 实机复测。WHPX、固件、TLS 与网络均在当前 Windows 宿主实际运行；不能据此声称所有硬件和 Windows 版本已验证。

原始 Compose YAML/.env 不由恢复过程覆盖，需自行保留；内置引擎首版不支持宿主目录挂载、build、GPU、特权容器或局域网公开。强制停止可能造成客体数据损坏，只有明确确认后才执行。

构建输入及第三方说明在 `scripts/build/docker-engine/`，产物集中于 `dist/engines/docker/` 和 `dist/installer/`。组件校验文件为 manifest.json，原始包清单为 packages.tsv。
