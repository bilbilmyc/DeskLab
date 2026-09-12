# Docker 集成规划

状态：0.2.0 已实现“连接已有本机 Linux Docker 引擎”、容器和受限 Compose 管理、统一端口映射与 SQLite 元数据。当前行为与限制见 [使用说明](../docker-and-storage.md)。下文保留阶段规划，自带托管引擎仍未实现。资料核验日期：2026-09-12。

第二阶段的具体实施以 [DeskLab 独立 Docker 引擎规划](desklab-managed-docker.md) 为准：预构建精简 Linux、独立客户端、双向 TLS、双盘持久化与双层 NAT 映射。

建议先做“连接已有 Docker”，再做“DeskLab 托管 Docker 引擎”。前者尽快提供容器和 Compose 管理，后者复用已有 QEMU 虚拟机能力，为没有 Docker Desktop 的用户提供独立环境，并让托盘退出真正释放该环境占用。WSL2 自管发行版留作后续选项。Docker 是可选功能，基础虚拟机功能继续无需安装 Docker。

## 当前代码边界

- [`server/lab.ts`](../../server/lab.ts) 已负责 QEMU 生命周期、进程身份核对、磁盘依赖及恢复；容器没有 qcow2、VNC 或 QMP，不应直接塞进现有 `Machine` 模型。
- [`shared/types.ts`](../../shared/types.ts) 的 `Machine` / `Template` / `VmState` 均面向虚拟机；应新增独立容器域模型，只在界面总览中聚合。
- [`server/store.ts`](../../server/store.ts) 提供原子保存与虚拟磁盘事务；可复用保存机制，Docker 资源操作需要自己的恢复记录，不能复用磁盘删除事务。
- [`server/app.ts`](../../server/app.ts) 已有本地 HTTP、请求令牌和退出入口；容器操作应继续经过服务端校验，浏览器不能直接访问 Docker socket。
- 当前虚拟机使用用户模式 NAT。SSH、容器发布端口、宿主文件共享需要分别解决；允许客体 root 登录不会自动建立宿主端口转发。基础能力与限制见 [`README.md`](../../README.md)。

## 三条方案及选择

### 第一阶段：连接已有 Docker Desktop / Engine

让用户选择检测到的 Docker context，测试连接后显示引擎位置、版本、Linux/Windows 类型及资源概况。使用现有安装，不自动下载、接受许可或修改用户默认 context。Docker CLI 的 context 能提供实际 endpoint，不能把 Docker Desktop 管道名硬编码成唯一地址。[Docker context inspect](https://docs.docker.com/reference/cli/docker/context/inspect/)

优势是无需再起一台 VM，能管理现有容器，也容易提供 Compose。代价是引擎由用户或 Docker Desktop 管理，关闭 DeskLab 不能保证引擎本身不占内存；界面与托盘必须明确标注“外部引擎”。这是功能接入的首选，不是零依赖安装的最终方案。

Docker Desktop 当前安装条件包括受支持的 Windows、虚拟化能力及对应后端要求；接入前按官方页面检查，不把项目曾验证过 Windows 10 + WHPX 当成 Desktop 必定兼容。Desktop 的个人用途等场景免费；组织用途须按当前订阅条款核对，不能默认所有公司都免费，也不把 Desktop 安装器塞进 DeskLab 安装包。[Windows 安装条件](https://docs.docker.com/desktop/setup/install/windows-install/)、[Desktop 许可](https://docs.docker.com/subscription-billing/desktop-license/)

首版只管理 Linux 容器。若当前 Engine 是 Windows containers 模式，显示原因及切换指引，不自动切换用户引擎；后续 Windows 容器单独规划。

### 第二阶段：DeskLab 专属 Linux VM 内运行 Docker Engine

复用现有 Ubuntu Server 自动安装及 VM 生命周期，创建标记为容器引擎的专属 VM。用户原来用于测试的 Ubuntu 保持独立，不静默安装或接管它。由安装配方从 Docker 官方 apt 仓库安装固定并验证过的 Engine / CLI / containerd / Compose 版本，记录版本与升级结果；首次下载失败可重试。Docker 官方支持在 Ubuntu 中安装这些组件。[Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)

优点是磁盘、资源和停机归 DeskLab 管理；代价是额外 VM 开销、系统维护、双层端口映射，以及 Windows 文件路径不能直接作为 Linux bind mount。与外部 Docker Desktop 连接采用同一容器服务接口。Engine 等开源组件的许可与 Desktop 订阅不是同一事项；如以后分发预装镜像，另做所含发行版、软件包、源码提供及许可证文件检查，本规划不预设已经具备再分发条件。[许可说明](https://docs.docker.com/subscription-billing/desktop-license/)

托管 VM 首次建议配置 2 核、4 GiB 内存及可扩展的数据磁盘，作为待实测默认值，并在创建前根据宿主可用资源给出调整入口。Docker 容器 CPU / 内存默认不自动受到合理的小配额限制，模板应显式设置资源限额。[Docker 资源约束](https://docs.docker.com/engine/containers/resource_constraints/)

### 暂缓：DeskLab 专属 WSL2 发行版

可导入独立发行版并在其中运行 Engine，但需要处理 WSL 安装/更新、发行版注册、systemd、路径转换、网络与升级兼容。WSL 可能需要提升权限及重启；不得把这些系统变更藏在普通“启动容器”按钮后。[安装 WSL](https://learn.microsoft.com/en-us/windows/wsl/install)

WSL2 的 `.wslconfig` CPU/内存设置影响全局 WSL2 环境，不适合作为 DeskLab 某个引擎的专属资源滑块。`wsl --shutdown` 会终止所有发行版及 WSL2 VM，因此退出 DeskLab 不能调用它；若以后采用此方案，只在正常停止工作负载后处理 DeskLab 自己的发行版。即便使用 `wsl --terminate <名称>`，也不能保证其他发行版占用的 WSL 资源全部释放。[WSL 配置范围](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)、[WSL 停止命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)

## 引擎连接与权限

第一版优先通过已安装 Docker CLI 的参数化调用实现适配，并通过结构化输出读取状态。每次显式传递 context / endpoint，禁用 shell 拼接，限定可执行文件路径和工作目录，不修改全局 `DOCKER_HOST`。首个技术验证须覆盖 Bun 打包后启动 Docker CLI、取消长任务和回收子进程。

支持的连接层分开处理：

1. Windows named pipe：通过所选 context 得到 `npipe://...`，由 Docker CLI 连接；若后续使用原生 HTTP 客户端，需要单独验证 Bun 的管道支持、权限拒绝和流读取。常见示例 `npipe:////./pipe/docker_engine` 不是所有安装的固定 endpoint。
2. Unix socket：用于 Linux 引擎本地客户端，常见为 `unix:///var/run/docker.sock`。Windows 上的 Bun 不能把 VM 内 socket 路径当成本机文件读取。
3. SSH：用于托管 VM 或用户显式配置的远程 Engine；通过 `ssh://用户@主机:端口` 访问远端 socket。托管 VM 配独立密钥及已核验的 host key；Windows 回环 SSH 转发到 VM 22 端口。授权用户需拥有远端 socket 权限。
4. TLS：后续高级连接支持双向 TLS，校验 CA、服务端主机名及客户端证书。首版不接受无认证的 TCP 2375，不自动开启该监听。

这些是 Docker 官方支持的 CLI / daemon 访问形式。[CLI endpoint](https://docs.docker.com/reference/cli/docker/)、[SSH 与 TLS](https://docs.docker.com/engine/security/protect-access/)

Docker socket 是高权限控制入口，加入 `docker` 组相当于获得 root 级能力。外部引擎默认只读展示已有资源；用户明确启动管理后，只对选择的资源执行操作。托管资源带 DeskLab 安装实例 ID 和项目 ID 标签，删除和退出前结合已存 ID、标签、引擎身份再次核对。凭据仅保存安全存储引用；不要把私钥、仓库密码或 `.env` 内容写入 `lab.json` 或页面快照。[Linux 权限说明](https://docs.docker.com/engine/install/linux-postinstall/)

如果之后直接使用 Engine API，初始化时协商兼容版本，探测能力后启用功能；Compose 继续交给 Compose CLI，而非自行用多个容器 API 重写编排语义。[Engine API](https://docs.docker.com/reference/api/engine/)

## 首版功能与 Compose 范围

- “容器”独立入口：选择引擎，查看连接状态、容器、端口、健康状况和资源使用。
- 单容器：拉取镜像、创建、启动、停止、重启、日志、终端、删除。镜像选择记录 tag 和最终 digest；删除持久卷为单独操作。
- Compose：导入本地项目，固定项目目录、配置文件集合及 DeskLab 项目名；先运行 `config` 验证并预览最终配置，再执行 `pull`、`up -d`、`ps`、`logs`、`stop`、`start`、`down`。超时、取消及部分成功都保留执行结果，重读引擎状态。
- 首版 Compose 仅支持预构建镜像及 named volumes；本地 `build`、watch、私有仓库登录、复杂远程 bind mounts、GPU、Swarm 和 Kubernetes 延后。检测不支持的配置时解释具体字段。

Compose 的相对路径依赖首个配置文件/显式项目目录，项目名必须稳定；操作用独立参数数组固定 `--project-directory`、`-f`、`-p`。不得仅靠进程当前目录寻找配置。以上命令职责与规则见 [Compose CLI](https://docs.docker.com/reference/cli/docker/compose/)。

“停止”使用 `compose stop`，保留容器。“移除项目运行资源”使用 `down`，默认不带 `--volumes` / `--rmi`；数据清理单独列出卷和关联项目，外部卷不纳入 DeskLab 清理范围。对匿名卷提示重新 `up` 不保证自动重新挂载，持久数据模板使用 named volumes。[Compose stop](https://docs.docker.com/reference/cli/docker/compose/stop/)、[Compose down](https://docs.docker.com/reference/cli/docker/compose/down/)

## 退出、重连与资源释放

浏览器关闭只结束界面会话，托盘仍显示运行的 VM / 容器数量。退出前统一检查待完成的拉取、创建、停止任务，禁止新建；托盘使用与网页相同的退出协调器。

- 外部引擎：默认停止 DeskLab 所有的工作负载，然后退出管理服务；保留用户原有容器和 Docker Desktop / Engine 进程。清楚显示“外部 Docker 引擎仍运行”。用户可为特定项目选择退出时保留运行，托盘退出前显示该清单。
- 托管引擎：先停止容器并等待结束，再正常关闭专属 VM，确认 QEMU 已退出后关闭 DeskLab。超时列出未停止的资源，允许继续等待或显式强制退出，不能把 QEMU 强杀当作数据库正常关机。
- 强制停止、异常退出和恢复：记录未完成操作；重启时核对引擎身份及实际容器，不因缓存标记“running”就视为正在运行，也不自动重做删除或重建。
- Docker 不可连接与容器 stopped 分开显示。关闭日志或终端连接只结束订阅，不能停止容器。

状态建议拆为 `EngineConnectionState`（未配置、连接中、在线、不可达、错误）、引擎报告的容器状态及独立 `Operation`（排队、执行、成功、失败、取消）。Docker 外部状态定期全量核对，事件流只用来加快更新。

## 存储、网络与项目目录

建议新增 `server/docker/`（引擎适配、Compose、状态、操作）、`shared/docker.ts`、`components/docker/`、`tests/docker/`，避免进一步堆入 `server/lab.ts`。持久元数据放应用数据目录的 `docker/`，包括引擎配置、项目配置及受控日志；临时验证放 `.runtime/` 的专属子目录；EXE 和打包产物统一由项目发布目录管理。

外部 Engine 的镜像和卷仍在其数据目录中，不能声称复制 DeskLab 安装目录就能备份它们。托管 VM 磁盘由 DeskLab 管理；持久卷的应用一致性备份需先停服务或使用数据库导出，再归档卷。第一版只提供手动备份指引，不提供运行中 VM 磁盘快照按钮。

bind mount 的源路径属于 daemon 所在主机。连接远端/VM 时，`D:\workspace` 不是远端的同一路径；第一版不做隐式共享或路径猜测。后续按明确的上传/同步或受控文件共享方案单独实施。[Bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)

外部本机引擎默认把发布端口绑定到 `127.0.0.1`；对显式 LAN 暴露进行可见提示。Docker 发布端口不显式指定地址时可绑定到所有地址，不能把单纯写 `8080:80` 描述为“仅本机”。[端口发布](https://docs.docker.com/engine/network/port-publishing/)

托管 VM 是两层映射：Windows `127.0.0.1:宿主端口` → QEMU NAT 客体端口 → 容器端口。Docker 应发布到客体可达网卡，不能仅绑定客体 `127.0.0.1` 再期望 QEMU 转发到达。映射由统一分配器管理，与 SSH、VNC/QMP、DeskLab HTTP 端口一起检查冲突；持久保存用户指定端口，无法绑定时给出实际错误，不静默换端口。

## 实施顺序与验收

1. **连接验证**：在独立测试数据目录使用现有 Docker，验证 npipe、SSH、权限不足、CLI 缺失、Compose 缺失、引擎未启动及 API 版本不兼容；无 Docker 的电脑继续正常使用虚拟机。确认 EXE 内参数化调用可行后再展开 UI。
2. **最小容器流程**：测试一个短任务容器和一个发布回环端口的 Web 容器；验证拉取进度、启动、日志、终端输入、停止、删除、端口冲突与中文路径；取消拉取后无悬挂子进程。测试标签不同的外部容器始终不被批量操作。
3. **Compose 流程**：两个服务及一个 named volume；验证配置错误不创建资源、部分启动失败可恢复、停止再启动数据仍在、`down` 默认保留卷、显式清理范围正确。资源所属引擎变化时阻止误操作。
4. **退出闭环**：关浏览器后托盘可重新打开；正常退出停所属工作负载；外部引擎保留且如实提示；异常关闭后重连正确；用户设置保留运行的项目不会误停。用宿主进程和资源采样记录实际占用，不以页面消失代表释放完成。
5. **托管 VM 验证**：全新宿主完成引擎准备；安装中断可重试；Windows 端口实际可访问容器；停机再启动卷数据保留；退出后专属 QEMU 消失；更改 CPU/内存后生效；移动完整数据目录后恢复。至少验证项目当前支持的 Windows + WHPX 环境。

本次交付只包含规划。进入实现时先完成第 1 项技术验证；其结果决定首版 CLI 适配细节及最低支持版本，不在尚未测试时承诺“一键安装”“零依赖容器”或所有资源随退出自动释放。
