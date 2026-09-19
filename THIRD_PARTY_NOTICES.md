# 第三方组件与分发说明

第一方 DeskLab 源码采用 [MIT 许可证](LICENSE)。本文件说明依赖来源，不为第三方组件改授许可证；随包组件保留各自的许可和源码获取资料。

- **Bun**：成品内嵌 Bun 运行时及其依赖。许可与 notices 见 [oven-sh/bun](https://github.com/oven-sh/bun)。
- **Next.js、React、Lucide、Zod**：依赖版本由 `bun.lock` 固定，各包许可随 npm 包提供。
- **noVNC**：浏览器远程控制台，参见 [noVNC LICENSE](https://github.com/novnc/noVNC/blob/master/LICENSE.txt)。
- **QEMU 与固件/DLL**：Windows 分发构建固定为 20260811，发布方及对应源码入口见 [QEMU Windows](https://qemu.weilnetz.de/w64/)；解压保留 `COPYING`，打包保留 QEMU 源说明。QEMU、固件、运行库可能采用不同许可证，不能用一个 DeskLab 许可证替代它们。
- **node-forge**：用于独立引擎证书生成，安装包附带其 LICENSE。
- **Inno Setup**：安装器构建工具，参见 [Inno Setup](https://jrsoftware.org/isinfo.php)；版本与固定下载摘要在构建脚本中。
- **完整 Docker 组件**：Ubuntu、Docker Engine、containerd、Compose 和 Windows CLI 保留上游许可与软件包 notices。资源清单和说明见 [`scripts/build/docker-engine/NOTICES.txt`](scripts/build/docker-engine/NOTICES.txt)；基础 CI 安装包不含此 Linux 镜像。
- **Windows 客体 ISO**：需要用户另行从发布方取得并遵守许可；程序不包含、激活或提供商业 Windows 许可证。

二进制分发应保留各组件的许可证、构建来源和相应源码获取资料。准备正式发行时核对实际打包的每项组件，而不是仅以此概览替代随包 notices。
