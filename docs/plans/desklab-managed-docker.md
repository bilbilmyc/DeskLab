# DeskLab 独立 Docker 引擎规划

状态：0.3.0 已实现主体功能，交付验证见 [实现与验证记录](../managed-docker-verification.md)。本文保留设计决策和后续扩展边界。日期：2026-09-12。

## 1. 产品决定

下一版提供“DeskLab 内置引擎”，由 DeskLab 启动专属的精简 Linux 虚拟机，在其中运行 Docker Engine。复用现有 QEMU/WHPX 和 NAT，不要求安装 Docker Desktop，不使用用户已有 Ubuntu 实例。继续保留“外部 Docker 引擎”入口，两者的数据与生命周期独立。

这里的“内置”包括 Linux 运行环境、Docker Engine、containerd、Linux Docker CLI/Compose，以及 Windows 管理客户端和 Compose 插件。只放一个 Windows dockerd.exe 无法提供本地 Linux 容器。[Docker 二进制安装](https://docs.docker.com/engine/install/binaries/)

首版只提供一个托管 Linux 引擎；普通虚拟机列表不显示可随意重置或删除的引擎实例。在 Docker 页面明确展示它占用的 CPU、内存、磁盘和后台运行状态。

## 2. 引擎镜像与交付

优先选择 Ubuntu 24.04 LTS minimal cloud image 的 amd64 版本作为预构建基础，而不是给最终用户执行一遍完整 ISO 安装。正式构建锁定具体镜像版本与校验值，按 Docker 官方 Ubuntu 包安装固定版本的 Engine、containerd、CLI、Compose。基础镜像的 UEFI 启动、virtio 磁盘和 WHPX 组合先做隔离验证；不假设现有 BIOS 安装配方可直接套用。[Ubuntu minimal 镜像](https://cloud-images.ubuntu.com/minimal/releases/noble/)、[Docker Ubuntu 安装](https://docs.docker.com/engine/install/ubuntu/)

构建输出包括系统基盘、版本清单、SHA-256、包清单、许可证及对应源码获取信息。发布时清除 machine-id、SSH host keys、cloud-init 状态、构建凭据和 Docker 运行数据。每次安装生成独立身份，公用基盘中不放通用密码或私钥。

建议完整安装包提供“独立 Docker 引擎”可选组件，包含已预装的软件，首次初始化不再依赖 apt 下载。软件包与 EXE 分开管理，放进正式发布目录，避免巨型程序反复整体解包。后续可再提供小安装包下载同一经过签名校验的引擎包；没有发布存储和签名流程前，不宣称已经支持在线分发。

无网络时可以初始化引擎、运行预先导入的容器镜像；拉取新的业务镜像仍需网络或离线导入。初始化使用本地 NoCloud seed，包含实例身份、证书和磁盘挂载配置。[cloud-init NoCloud](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html)

初始建议值：2 vCPU、2 GiB 内存、64 GiB 数据盘逻辑容量，可调整。它们是待压测的默认值，不是已测得的最低要求；数据盘按实际写入增长，界面分别显示容量上限、文件实际占用和客体剩余空间。首次启用前检查宿主可用内存、磁盘与 WHPX；所需 Windows 功能缺失时明确引导，不静默修改系统或退回极慢配置。

## 3. 管理连接：独立于 Docker Desktop

建议正常管理通道采用双向 TLS：Windows 内置 Docker CLI/Compose → Windows 回环管理端口 → QEMU NAT → 专属 Linux 的 Docker TLS 端口。Docker 支持客户端与服务端证书双向验证。[Docker TLS 连接](https://docs.docker.com/engine/security/protect-access/)

每个引擎生成独立 CA、服务端证书与客户端证书；只向客体注入所需服务端材料和 CA 公钥。Windows 私有目录保存客户端私钥，SQLite 只记凭据引用、指纹、有效期和引擎身份。服务端证书要匹配客户端实际连接地址；证书签发、续期和首次启动验证列入第一阶段技术验证。

Windows 侧只绑定 127.0.0.1。管理端口不会出现在用户可公开的业务映射列表中，不开放未认证的 2375。SSH 保留为使用独立密钥的诊断入口；正常使用不依赖用户 SSH agent 或修改其 ~/.ssh/config。

Windows Docker CLI 与 Compose 使用独立工具目录和 DOCKER_CONFIG；固定命令参数与证书路径，不依赖 PATH 中的 Docker Desktop 文件，不修改用户默认 context。客户端、服务端和 Compose 版本作为一套验证后发布。Windows 静态 CLI 对 Linux TLS 引擎的连接和独立 Compose 插件发现，必须在无 Docker Desktop 的 Windows 测试环境实测通过。

现在 server/docker/cli.ts 会查找系统 Docker，service.ts 只接受 npipe；应引入 EngineTransport，根据引擎类型构造连接参数。外部引擎保留现有 context 路径，托管引擎只接受程序生成的 TLS 配置。保留既有容器和 Compose 服务逻辑，避免重复实现 Docker 编排协议。

## 4. 网络：一个可用入口，两层内部转发

示例：Windows `127.0.0.1:8080` → 引擎 VM `10.0.2.15:18080` → 容器 `80/TCP`。

用户只填写本机端口 8080 和容器端口 80。引擎内中转端口由程序分配，并避开管理服务；详情中可以展开完整链路。TCP 和 UDP 都记录协议。QEMU 支持指定绑定地址的 hostfwd；Docker 需要发布到客体可达网卡地址，不能继续套用当前“客体 127.0.0.1”发布方式。[QEMU hostfwd](https://www.qemu.org/docs/master/system/invocation.html)、[Docker 发布端口](https://docs.docker.com/engine/network/port-publishing/)

端口页展示 Windows 可访问入口。Docker inspect 返回的客体地址和中转端口不能直接当作 Windows 地址显示。外部 Docker 的映射展示保留现有逻辑。

操作顺序：记录待应用预留 → 验证主客体端口 → 创建容器发布配置 → 安装 QEMU 转发 → 核对两端 → 标记已生效。任何一步失败都记录具体阶段并补偿；重启后按实际 Docker/QMP 状态协调，不盲目重复创建。停止后保留预留；删除资源才释放。现有端口修改需要停止并重建相应发布配置，不能声称 Docker 可随意热改端口。

首版保持仅本机访问。以后局域网访问可对指定业务端口选择宿主 LAN 地址，并管理范围受控的防火墙规则，仍无需网桥。管理接口永不跟随业务端口公开。

## 5. 数据盘和升级

每个引擎独立系统盘和数据盘。系统盘可以重新生成；数据盘保存容器、镜像、命名卷和引擎持久状态。建议布局：

```text
D:\apps\DeskLab\
  runtime\docker-tools\<版本>\       Windows CLI、Compose
  data\
    desklab.sqlite                   元数据
    engines\images\<版本>\          校验后的不可变系统基盘
    engines\<引擎 ID>\
      system.qcow2                   当前系统可写层
      data.qcow2                     持久数据盘
      seed.iso                       首次初始化材料，使用后卸载并清理
      credentials\                   当前用户可访问的凭据文件
      logs\                          有轮转和大小限制的引擎日志
      backups\                       停机备份及升级记录
```

基于当前常规软件包方案，数据盘需覆盖 `/var/lib/docker` 和 `/var/lib/containerd`。Docker 29 新装默认 containerd image store，单独修改 Docker data-root 不足以移动 containerd 数据。按固定版本的实际驱动和配置生成挂载规则，启动顺序保证数据盘就绪后才启动 containerd 和 Docker；挂载失败时拒绝启动，不能悄悄向空系统盘写数据。[Docker 数据目录](https://docs.docker.com/engine/daemon/)

升级程序不移动数据盘。升级引擎时：停止工作负载 → 正常关机 → 备份元数据与数据盘 → 生成新系统盘 → 启动并验证 → 提交版本。新版可能迁移数据格式，因此失败回滚要恢复同一备份时点的数据盘与元数据，不能只换回旧系统盘。备份前检查可用空间，首版提供明确的停机备份/恢复，不做运行中复制 qcow2。

外部 Docker Desktop 的资源不会自动出现于独立引擎。后续迁移使用镜像导出/导入、Compose 配置和卷备份恢复；直接复制 Desktop 虚拟磁盘不属于本方案。

## 6. SQLite 模型与模块边界

保留现有资源表和引擎 ID，使用带版本号、可回滚备份的 schema migration：

- docker_engines：增加 kind（external/managed）、期望/实际状态、错误、最后核验时间；每次操作传明确 engineId，不能在异步任务中读取会变化的全局选择。
- managed_engines：引擎 ID、内部 VM 引用、CPU/内存、系统镜像版本、数据盘路径、管理端口、凭据引用、恢复标记。内部 VM 受保护，不能通过普通实例 API 重置/删除。
- port_mappings：增加 engineId 下的 guestPort、中转地址、期望/实际状态和错误；宿主端口全局唯一，客体中转端口按引擎唯一。区分管理预留与业务预留。
- operations：记录步骤、重试条件和补偿进度；重启只协调，不重放删除等动作。升级备份另记录版本和文件清单。

建议新增 server/docker/managed/（引擎生命周期与初始化）、server/docker/transport.ts（连接）、server/docker/port-router.ts（双层映射）、scripts/build/docker-engine/（镜像构建）、tests/docker-managed/（隔离验证）。从 Lab 中抽取或复用低层 QEMU 启停/身份核对能力，专属引擎的生命周期不塞进现有普通 VM 的退出强制清理路径。

## 7. 用户流程与退出

Docker 页面显示“DeskLab 内置 / 外部引擎”，首次点击“启用内置引擎”，选择资源与数据位置，显示准备、初始化、启动、就绪四步进度。就绪检查包括客体身份、磁盘挂载、TLS 和 Docker API，而不只是 QEMU 进程存活。

默认按需启动。打开 DeskLab 不自动启动引擎；主动使用容器时启动。引擎已停止时浏览列表只显示缓存和“已停止”，不能因页面轮询偷偷启动。关闭浏览器后托盘继续显示运行中；可设置启动时恢复指定项目，默认关闭。首版不按“CPU 很低”推断可以自动关机。

真正退出：阻止新操作 → 停止专属引擎内工作负载 → 正常关闭 Linux → 确认该 QEMU 退出 → 退出 DeskLab。等待超时说明阻塞项，继续等待或由用户明确选择强制退出。正常退出要释放这套引擎的内存/CPU；只停止 docker.service 而保留 Linux VM 不算完成。其他普通 VM 沿用原有正常关机保护，Docker Desktop 与外部容器不受影响。

## 8. 实施顺序和发布门槛

1. **隔离技术验证**：构建一个预装引擎镜像，验证 WHPX/UEFI、NoCloud、双盘、证书、独立 Windows CLI/Compose。临时文件集中在 .runtime/checks/docker-managed/，不接管用户 Ubuntu 或外部容器。记录安装包大小、首次/二次启动耗时、空闲和负载内存、退出后进程情况；据此确定默认资源。
2. **0.3.0 核心功能**：引擎管理、SQLite 迁移、按需启动、容器现有功能复用、持久卷、双层 TCP/UDP 映射、正常退出及异常恢复。
3. **0.3.0 完整交付**：适配现有受限 Compose；替换 guest 发布端口，保留本地原文件与明确的 env 处理边界；完整安装包组件、版本验证、备份恢复、实际无 Desktop 机器安装测试。上述未齐全前不宣布“独立 Docker 支持完成”。
4. **后续扩展**：命名卷管理与导入导出、局域网发布、受控 Windows 目录共享、本地构建、资源动态调整。磁盘扩容分步验证；缩容不纳入首版。

关键验收：无 Docker Desktop/PATH 无 Docker 仍能启动；Nginx HTTP 和 UDP 服务真实可达；数据库容器写入后重启/更新/恢复仍存在；Compose down/up 保留卷；端口冲突与操作中断可恢复；拒绝错误 TLS 身份；浏览器关闭不停服务；托盘正常退出后无该引擎 QEMU 残留；普通 Ubuntu 和外部 Docker 资源不变。测试虚拟机若没有嵌套虚拟化能力，最终性能和 WHPX 验证须在支持条件的 Windows 实机进行。

本规划把独立性、数据可靠性和生命周期作为首版完成条件，不预设引擎包大小或启动速度已经达到某个数字。研究补充见 [官方来源核验](managed-docker-sources.md)。
