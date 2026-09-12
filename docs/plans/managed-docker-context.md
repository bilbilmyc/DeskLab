# 独立引擎实现上下文

## Files to Modify
| 文件 | 用途 | 改动 |
|---|---|---|
| server/docker/service.ts、cli.ts、compose.ts | Docker 操作 | 显式引擎、独立 CLI/TLS、按需启动、客体端口 |
| server/database.ts | 元数据 | 版本 2 迁移、托管引擎和中转端口 |
| server/app.ts、components/docker/panel.tsx | API 与页面 | 初始化/启停/资源与备份、退出协调 |
| scripts/build/installer.ts、installer/desklab.iss | 安装 | 离线引擎组件与独立工具目录 |

## Dependencies
| 文件 | 关系 |
|---|---|
| server/qemu.ts、firmware.ts、install-media.ts | 复用 QMP、UEFI、NoCloud ISO 生成 |
| server/ports.ts、ssh-network.ts | 主机端口预留、QMP 转发核验 |
| shared/docker.ts、shared/ports.ts | 增加引擎状态和中转信息 |
| server/docker/managed/ | 新增镜像/凭据/专属 VM/备份职责 |

## Tests
| 文件 | 覆盖 |
|---|---|
| tests/database.test.ts、docker.test.ts | 迁移和已有 Docker 行为 |
| tests/docker-managed/ | 凭据、磁盘身份、双层映射、恢复 |
| scripts/checks/docker-managed/ | WHPX 实机、TLS、HTTP/UDP、Compose、备份和退出 |
| scripts/checks/desktop-service-smoke.ts、docker-ui.mjs | 安装包、普通 VM 和界面回归 |

## Review
实现前已核对依赖与风险：数据库迁移需要备份；托管 VM 使用独立表，不进入普通 VM 重置/删除 API；外部 npipe 与独立 TLS 连接分开；单个异步操作固定引擎 ID；持久数据盘覆盖 Docker 和 containerd；无 Desktop 的独立性必须由运行测试证明。此上下文已由实施者复核，可以开始隔离验证。
