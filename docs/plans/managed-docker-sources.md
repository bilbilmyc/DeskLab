# 独立 Docker 引擎：镜像与打包来源核验

核验日期：2026-09-12。本文仅记录官方资料和方案建议；没有下载运行时、安装软件或启动虚拟机。下述「建议」不是已实现或已通过实机测试的能力。

## 已核实事实

### Ubuntu Minimal 可以作为虚拟机基础镜像

- Ubuntu 官方发布目录提供 `ubuntu-24.04-minimal-cloudimg-amd64.img`，明确标为 **QCow2 UEFI/GPT Bootable disk image**；扩展名 `.img` 不代表 raw 格式。目录同时提供 `SHA256SUMS`、其 GPG 签名、软件包清单和带日期的构建。启动说明要求 KVM 使用 virtio 网卡。[官方发布目录](https://cloud-images.ubuntu.com/minimal/releases/noble/release/)
- 当前该镜像的软件包清单包含 `cloud-init`、`openssh-server`、`systemd`、`apt` 和虚拟机内核；它是可启动的 Linux 系统，而非只含根文件系统的容器 tar 包。[官方 amd64 软件包清单](https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.manifest)
- Canonical 的 QCOW 启动教程将 minimal releases 列为镜像源，并通过 cloud-init user-data 初始化实例。这支持选择该镜像系列；该教程使用 Linux/libvirt，本身不能证明 Windows 上某个 QEMU/WHPX 组合已经兼容。[Canonical QCOW 教程](https://ubuntu.com/docs/public-images/public-images-how-to/launch-with-libvirt/)
- cloud-init NoCloud 支持无网络的本地配置盘：文件系统为 VFAT 或 ISO9660，卷标为 `CIDATA`，配置文件放根目录；`meta-data` 需要 `instance-id`。因此可设计由应用生成 seed ISO，传入公钥和初始化配置。[NoCloud 官方说明](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html)

### Linux Engine 与 Compose 可以独立于 Desktop 打包

- Docker 官方 Ubuntu 仓库支持 Ubuntu 24.04，安装组件包括 `docker-ce`、`docker-ce-cli`、`containerd.io`、`docker-buildx-plugin`、`docker-compose-plugin`。其中 `containerd.io` 已打包 containerd/runc，不能再无区别叠加发行版的同名依赖。文档支持选择指定 Engine/CLI 版本。[Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/)
- Compose 插件可通过 Docker 的 Linux 仓库安装，命令接口为 `docker compose`。手工下载插件不会自动更新；仓库安装也不等于产品已具备完整升级、回滚策略。[Compose Linux 插件说明](https://docs.docker.com/compose/install/linux/)
- Docker 提供 Windows `docker.exe` 客户端及 `dockerd.exe`。该 Windows daemon 二进制安装方式运行的是原生 Windows 容器，不能直接提供 Linux 容器环境，且不附带 Compose/Buildx。[二进制安装说明](https://docs.docker.com/engine/install/binaries/)
- Docker CLI 的 `--host` 支持 TCP、SSH 与 Windows named pipe，`--config` 支持独立客户端配置目录。**上述 Linux 容器限制针对本机 Windows daemon，不表示 Windows CLI 不能控制 Linux daemon。** 从官方客户端连接协议与服务端分离设计可推导本方案：Windows 客户端通过 TCP/TLS 连接应用管理的 Linux VM。具体版本组合与路径行为仍须实机验收。[Docker CLI 参考](https://docs.docker.com/reference/cli/docker/#specify-daemon-host--h---host)
- Docker 支持 TLS 双向校验：daemon 检查客户端证书，客户端校验服务端证书。使用回环地址连接时，服务端证书的 SAN 需要涵盖实际访问地址；端口号 2376 自身不会启用 TLS。[Docker TLS 说明](https://docs.docker.com/engine/security/protect-access/#use-tls-https-to-protect-the-docker-daemon-socket)
- Compose 官方发布资产提供独立 Windows 可执行文件。例如核验时 v5.5.1 有 `docker-compose-windows-x86_64.exe`，并提供 SHA256、SBOM、provenance 与 sigstore 相关资产。因此 Windows Compose 无须从 Desktop 安装目录抽取。[Compose v5.5.1 发布页](https://github.com/docker/compose/releases/tag/v5.5.1)（资产清单由 [GitHub 官方 API](https://api.github.com/repos/docker/compose/releases/latest) 读取；这里记录可用性，不建议直接跟随 latest。）

### Docker 29 的数据不一定只在 data-root 下

- Engine 29.0 起的**全新安装**默认使用 containerd image store；从旧版本升级的实例通常保留旧存储驱动，不能只看版本号推断存储布局。[containerd image store 说明](https://docs.docker.com/engine/storage/containerd/)
- 常规独立 containerd 配置下，镜像内容与容器快照在 `/var/lib/containerd`，Docker 卷和其他 daemon 数据在 `/var/lib/docker`。Docker `data-root` **不会移动**前者，需另行配置 `/etc/containerd/config.toml` 的 `root`。[daemon 数据目录说明](https://docs.docker.com/engine/daemon/#daemon-data-directory)
- 官方当前另有 Engine 29.7.0 起可显式启用的 `embedded-containerd` 模式，其状态位于 Docker data-root 内，默认是 `/var/lib/docker/containerd/daemon`。这是需要明确选择的不同运行模式，不能把上面的双目录规则写成所有 Docker 29 部署的绝对结论。[embedded containerd 说明](https://docs.docker.com/engine/daemon/embedded-containerd/)

## 建议纳入方案的决策

1. 首版候选采用 Ubuntu 24.04 Minimal amd64 + NoCloud + 官方 Debian 包构建受控客体镜像。记录镜像构建日期、SHA256、各组件版本与来源；不要让可变的 `release/` 链接成为唯一版本标识。UEFI 固件、virtio 设备及 Windows 加速器兼容性列入后续验证。
2. 首版先采用官方包常规的独立 containerd 服务；为 Docker 与 containerd 明确设计同一持久数据盘上的两个目录。挂载失败应阻止服务启动，避免数据意外写入系统盘。`embedded-containerd` 暂作为后续候选，不混入首版默认配置。
3. Windows 侧分发锁定版本的 Docker CLI 与独立 Compose 插件，来源为官方静态二进制目录和官方 Compose releases；Linux Engine 及依赖在客体镜像内。由应用生成独立客户端配置目录和 mTLS 连接，通过仅监听 Windows 回环地址的 QEMU 端口转发访问客体 TLS API。SSH 仅作为可选诊断通道。插件发现、版本协商、证书更新及 Compose 行为列入兼容性验证；不能认为 `docker.exe` 已涵盖全部组件。
4. VM 的备份、迁移和升级验收应覆盖镜像、容器可写层、命名卷、daemon/containerd 配置及客体身份材料。不能仅凭备份 `/var/lib/docker` 宣称所有状态可恢复。

本次核验不提供性能百分比，也未完成再分发许可证逐组件审查；产品分发前应按实际锁定的软件包、固件和二进制清单核实，而不能仅依据「开源」推导整套分发结论。
