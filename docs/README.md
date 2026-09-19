# 文档索引

当前正式版为 Windows x64 基础版 v1.0.0，产品范围见 [README](../README.md)，发布流程见 [版本与发布约定](releasing.md)。

## 使用

- [第一次使用](getting-started.md)：安装、创建、关机和自己的模板。
- [ISO 与系统支持](iso-guide.md)：必需文件、固定版本、目录外 ISO、错配处理与校验。
- [网络与 SSH](network-and-ssh.md)：仅 NAT、本机连接和密钥授权。
- [Docker 与存储](docker-and-storage.md)：独立/外部引擎、Compose、端口和数据备份。
- [安装、迁移与分发](distribution.md)：安装包组成和数据位置。

## 开发

- [构建与 CI](build-and-ci.md)：从干净克隆到 Windows 成品。
- [版本与发布约定](releasing.md)：主线、候选版、正式标签和发布准入。
- [目录约定](project-layout.md)、[贡献说明](../CONTRIBUTING.md)、[变更记录](../CHANGELOG.md)。
- [第三方组件](../THIRD_PARTY_NOTICES.md)、[ISO 源清单与历史核验](iso-sources.md)。

## 历史记录

[本机验证记录](verification.md)、[独立 Docker 验证](managed-docker-verification.md)、`ui/` 的界面变更记录和 `plans/` 的研究方案保留作实现依据。其中 `.runtime/`、个人目录和本机截图不随 Git 分发，不能视为可下载资源或当前 CI 的验证结果。

[Windows 桥接研究](network-setup.md)已暂停，不是安装指引。当前构建不执行桥接助手、不修改宿主网卡。
