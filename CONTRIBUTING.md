# 参与开发

当前维护主线为 `master`，候选验证分支为 `v1.0.0-rc1`。提交小范围修改，说明具体问题、行为变化和验证结果；不要将预发布构建描述为稳定版。

先阅读 [构建与 CI](docs/build-and-ci.md) 和 [目录约定](docs/project-layout.md)。安装依赖使用 `bun install --frozen-lockfile`，提交前执行 `bun run typecheck`、`bun test tests` 和 `bun scripts/checks/repository-check.ts`。更改依赖时同步提交 `package.json` 与 `bun.lock`。

只把源码、必要图标、配置、锁文件和可复用文档提交到仓库。`.data/`、`data/`、`.runtime/`、`dist/`、`iso/`、虚拟磁盘、备份、密钥、环境文件和本机日志都应保持未跟踪；不要用 `git add -f` 绕过这些排除项。

使用专门的测试数据目录，避免在运行中的真实虚拟机或容器上验收删除、恢复、重置、关机或安装流程。文档引用的本机历史路径不是供其他贡献者下载的构建资产。

项目使用 Bun 作为产品运行时，不应无意加入 Node.js 运行依赖。Next.js 的本地版本可能不同于通用教程，编写相关代码前阅读 `AGENTS.md` 及 `node_modules/next/dist/docs/`。

提交公开 issue 时说明版本、Windows 版本、加速方式、复现步骤和错误文本，移除私钥、凭据及个人数据。默认测试账号属于产品文档，应与个人凭据区分。
