# Docker、端口映射与 SQLite

> v1.0.0 基础安装包支持连接外部 Docker，不包含独立引擎 Linux 镜像；完整独立引擎构建继续单独验证，方式见 [构建与 CI](build-and-ci.md)。

## 使用

在侧栏打开“Docker 容器”，选择“DeskLab 内置”或“外部 Docker”。完整安装包包含独立引擎可选组件；基础安装仍可使用普通虚拟机和已有 Docker Desktop。两种引擎的数据分开，不自动迁移容器。

## DeskLab 内置引擎

点击“启用内置引擎”，设置 CPU、内存和数据盘容量上限，再“准备并启动”。默认 2 核、2 GB 内存、64 GB 数据盘上限；数据文件按写入增长。组件包含预装 Ubuntu、Docker Engine、containerd、独立 Docker CLI 和 Compose，初始化无需下载系统包；首次拉取业务容器镜像仍需联网。

内置引擎使用现有 QEMU/WHPX 与 NAT，无需 Docker Desktop、WSL 发行版或桥接驱动。当前支持 Windows x64、启用 WHPX 的宿主。状态卡展示已分配资源、磁盘文件大小及运行时的客体剩余空间；停止后可调整 CPU、内存。

引擎按需启动。打开程序或查看停止的引擎不会自动启动它；明确启动容器时会启动引擎。关闭浏览器后它继续运行，托盘提示内置 Docker 正在运行。真正退出 DeskLab 时，先停止容器，再正常关闭专属 Linux，确认 QEMU 退出。普通虚拟机仍需先正常关机。关机失败可重试；“强制停止”须在错误状态下单独确认。

“停机备份”保存完整系统盘、数据盘、引擎凭据、资源与映射记录。“恢复”会回到备份时点，覆盖之后的修改。“修复 / 更新系统”先备份，再使用已安装的组件重建系统盘，保留数据盘；失败时恢复备份。安装新版组件后使用此入口更新引擎。Compose 的原始 YAML 和环境文件仍需保留或另行备份，程序不覆盖用户的原文件。

内置引擎文件集中在 `data/engines/<引擎 ID>/`，其中 `system.qcow2` 为系统盘，`data.qcow2` 为持久数据盘，`backups/` 为停机备份。共享系统基盘在 `data/engines/images/`，软件组件在安装目录的 `runtime/docker-engine/`。持久数据盘同时保存 Docker 和 containerd 数据。

Windows 到容器经过两层映射，例如 `127.0.0.1:8080 → 引擎内 20000 → 容器 80`。页面展示可从 Windows 使用的入口，中间端口自动分配。独立管理连接使用每个引擎自己的双向 TLS 证书；凭据保存在受限目录，SQLite 不保存私钥。

## 外部引擎与通用容器操作

选择“外部 Docker”，选择本机 Linux Docker context 并连接。退出 DeskLab 会保留 Docker Desktop 和其他应用的容器。已有容器按安装身份标签判断管理权限，外部容器显示为只读。

- 容器：拉取镜像、创建、启动、停止、重启、删除、最近 200 行日志和容器内 Shell 命令。默认限制 512 MB 内存、1 核 CPU；创建时可调整。
- Compose：选择已有 YAML 文件，校验后导入，支持启动/更新、停止、移除容器、删除记录。支持预构建镜像、普通命名卷、固定 TCP/UDP 发布端口。暂不支持 build、宿主目录挂载、特权配置、外部网络/数据卷、secrets/configs。
- 仅允许操作带有本次安装身份标签的容器；其他容器显示为只读。原 Compose 文件继续作为配置来源，需保留在原位置；生成的覆盖文件放在数据目录的 `docker/projects/<项目 ID>/`。
- 退出 DeskLab 会停止本程序管理的容器，保留命名数据卷；内置引擎同时正常关机，外部 Docker Desktop 和其他应用容器不退出。强制结束进程无法保证清理。

## 端口映射

端口映射页统一显示自动 SSH、虚拟机自定义 NAT 和 Docker 发布端口，支持搜索、按资源类型筛选、复制入口。虚拟机自定义映射支持增删改；运行时允许增加/删除，修改已有映射需要先关机。

新建映射只绑定 `127.0.0.1`，例如 Windows 的 `127.0.0.1:8080` 转到实例内的 `80/TCP`。本版暂未提供局域网发布开关。虚拟机里的服务仍需自行启动并允许对应端口。运行状态反映资源状态，不是服务连通性检测。外部 Docker 容器的既有绑定按引擎实际配置显示。

SQLite 对协议和宿主入口建立唯一约束，启动前同时检查端口占用。停止后保留配置与预留；Docker 端口在容器创建或 Compose YAML 中配置。Compose 移除容器后仍显示预留，删除项目记录才释放。

## 元数据与实际文件

`data/desklab.sqlite` 是元数据的唯一来源，使用 WAL 和事务，内置 Bun SQLite，无需安装数据库服务。表包括 settings、machines、templates、docker_engines、managed_engines、engine_backups、docker_projects、docker_resources、port_mappings、operations 和 metadata。引擎实时状态定期同步；上次被中断的操作会标为失败，供检查后重试。0.3.0 的 schema v2 升级前在 `data/backups/before-managed-v2-*.sqlite` 保存一致的 v1 备份。

首次启动自动导入旧 `lab.json`，先备份原文到 `data/backups/lab.pre-sqlite.json`。迁移保持实例 ID、模板 ID、磁盘路径、SSH 身份和设置；原 `lab.json` 改为版本标记，防止旧程序误用过时数据。

- 虚拟机磁盘：`data/machines/<实例 ID>/disk.qcow2`。
- 模板磁盘：`data/templates/`；需要和依赖它的实例一起备份。
- SSH 密钥：仍为本地文件；数据库和页面只使用公钥元数据。
- Docker 镜像、容器文件系统与命名卷：内置引擎保存在其数据盘中；外部引擎保存在 Docker Desktop 中。删除容器会删除该容器的可写层，需要长期保留的数据应放命名卷。
- Compose 配置和环境文件：保留原文件；数据库记录路径，不保存展开的环境变量。

备份前正常关闭实例、停止容器、退出 DeskLab，再备份完整 `data` 和 Compose 原文件。内置引擎的完整备份包含其命名卷；外部 Docker 引擎的数据与命名卷需另行备份。仅复制 SQLite 无法备份系统磁盘或容器数据。

后续扩展包括卷管理与导入导出、局域网发布、Windows 目录共享和本地构建。当前没有实现这些后续功能；首版提供的 Compose 范围仍为预构建镜像、固定端口与命名卷。
