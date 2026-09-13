# DeskLab

[![Windows build](https://github.com/bilbilmyc/DeskLab/actions/workflows/windows-build.yml/badge.svg?branch=master)](https://github.com/bilbilmyc/DeskLab/actions/workflows/windows-build.yml)

在 Windows 本机创建独立的 Windows / Linux 测试环境，通过浏览器使用桌面或终端；也可以使用 DeskLab 独立 Docker 引擎管理容器。

**当前处于预发布验证阶段，不是正式生产版本。** 主分支为 `master`，当前候选分支为 [`v1.0.0-rc1`](https://github.com/bilbilmyc/DeskLab/tree/v1.0.0-rc1)。正式版时间尚未确定；候选版本通过验证后再决定是否发布，不会按日期自动转正。

## 能做什么

- 创建、启动和正常关闭虚拟机；在浏览器中使用 noVNC 控制台。关机、强制关闭、恢复与删除均有确认。
- 从模板创建独立副本，自定义 CPU、内存、磁盘；保存自己的系统模板。已有模板的磁盘可扩大，不能缩小。
- 首次自动安装 Ubuntu Server、Debian Server、Rocky Server、Windows 10 和 Windows Server；也可导入已有磁盘或手动安装其他 ISO。
- 选择 ISO 后识别内部系统标识，错配就地提示；创建前再次校验，避免产生失败的空实例。
- NAT 网络、默认 Ed25519 SSH 密钥、虚拟机 TCP/UDP 端口映射。
- 独立 Docker 引擎或连接已有 Linux Docker context；容器、镜像、受限 Compose、日志、命令执行与端口展示。
- Windows 通知区域托盘、SQLite 元数据，以及保存在本机的虚拟磁盘和数据卷。

## 下载与安装

在仓库 [Actions → Windows build](https://github.com/bilbilmyc/DeskLab/actions/workflows/windows-build.yml) 中选择成功的候选分支构建，下载 `DeskLab-<版本>-windows-x64-basic` 产物。解压后运行 `DeskLab-Setup.exe`，安装完成后使用 DeskLab 快捷方式。Actions 产物保留 14 天，不等同于正式 Release；需要登录 GitHub 才能下载。

安装包有两种组成，请先区分：

- **基础构建（GitHub Actions 默认）**：内含网页、Bun 服务、托盘、QEMU、固件和安装配方。支持虚拟机和连接外部 Docker；不包含独立 Docker 的预装 Linux 数据包。
- **完整构建（本机专用构建）**：在基础构建上附带独立 Docker 引擎组件，包含预装 Linux、Docker、Compose 和 Windows CLI。安装时勾选该组件即可使用，无需 Docker Desktop。[完整构建方法](docs/build-and-ci.md#完整安装包与独立-docker-组件)

**两种构建都不附带 Windows/Linux 客体安装 ISO、你的虚拟机磁盘或个人数据。** 独立 Docker 的预装 Linux 镜像与用于创建测试虚拟机的 ISO 是两种不同资源。

当前目标是 Windows x64。使用 WHPX 硬件加速需在固件中启用虚拟化，并在 Windows 功能中启用“Windows 虚拟机监控程序平台”，完成系统要求的重启。也提供较慢的 TCG 模式。建议先用一台小规格实例验证本机兼容性；尚未适配 macOS、Linux 宿主或 Windows ARM64。

成品运行无需安装 Bun、Node.js 或数据库服务。使用基础构建的外部 Docker 功能时，需要自行准备 Docker 引擎及可用的 Docker CLI/context。

## 创建第一个环境

1. 打开“创建环境”，选择系统。
2. 首次安装时选择对应 ISO，填写名称并调整 CPU、内存、磁盘。ISO 可放在其他磁盘或文件夹，不必复制到应用目录。
3. 查看安装盘检查结果：匹配后创建；选错时更换文件，或切换到识别出的系统。未知自定义 ISO 经确认后使用手动安装。
4. 点击“创建并自动安装”，保持 DeskLab 和 ISO 文件可用，等待系统安装、保存基础模板并进入系统。
5. 模板准备好后，再创建同类实例无需 ISO。保存自己的配置时，在实例正常关机后选择“更多操作 → 保存为模板”。

自动安装的 Linux 使用 `root`，Windows 使用 `Administrator`，控制台默认密码均为 `DeskLab0987` 并配置自动登录。新装 Linux 的 SSH 默认使用密钥，禁止 SSH 密码登录。手动安装和导入镜像保留原来的账号设置。这些默认配置用于个人本地测试，使用前应根据自己的环境修改账号和密码。

完整步骤见 [新手指南](docs/getting-started.md)，安装盘版本见 [ISO 与系统支持](docs/iso-guide.md)。

## ISO、模板与数据在哪

安装版的数据位置由 EXE 同级的 `desklab.install.json` 固定：

```text
安装目录/
  DeskLab.exe
  desklab.install.json
  data/
    desklab.sqlite       设置、实例、模板、Docker 和映射元数据
    machines/            实例可写磁盘
    templates/           安装好的模板基盘
    ssh/                 本机 SSH 密钥
    engines/             独立 Docker 系统盘、数据盘和凭据
  iso/                   默认 ISO 目录，可在设置中更换
  runtime/docker-engine/ 完整构建附带的独立引擎安装资源
  templates/             说明与目录参考，不是模板磁盘
```

选择外部 ISO 时直接引用原文件，不自动移动、复制或上传；安装完成前不要移动或删除。自动安装完成后会卸下 ISO，之后从系统磁盘启动。手动安装完成后需正常关机并弹出 ISO，或保存为模板。

备份前关闭虚拟机、停止容器并退出 DeskLab，复制完整数据目录及外置 Compose 配置。**只备份 SQLite 无法备份虚拟磁盘和 Docker 数据卷。** [Docker 与存储](docs/docker-and-storage.md)说明了独立引擎备份和外部 Docker 数据边界。

## 连接与退出

当前仅支持 **NAT**。桥接已暂停，程序不安装 TAP、不创建 Windows 网桥。实例内部的 `10.0.2.15` 不是 Windows 应直接连接的地址；请复制“连接与网络”中显示的 SSH 命令：

```powershell
# 示例；私钥路径和端口以实例页面为准
ssh -i 'D:\apps\DeskLab\data\ssh\id_ed25519' -o IdentitiesOnly=yes -p 2222 root@127.0.0.1
```

虚拟机和内置 Docker 的新映射仅绑定本机 `127.0.0.1`，暂不提供局域网发布开关。详情见 [网络与 SSH](docs/network-and-ssh.md)。

关闭浏览器或控制台标签不会关闭虚拟机或服务。点击实例电源按钮后，需要“确认关机”；退出 DeskLab 前保存工作并关闭实例，再通过页面或托盘退出。独立 Docker 引擎会正常停止；外部 Docker Desktop 本身继续运行。异常强杀进程不等同于正常关机。

## 开发与构建

固定使用 Bun **1.3.14** 和 `bun.lock`；Bun 是应用运行时，`node:*` 导入是其标准 API 兼容接口。

```powershell
git clone git@github.com:bilbilmyc/DeskLab.git
cd DeskLab
git switch v1.0.0-rc1
bun install --frozen-lockfile
bun run dev
```

开发默认入口为 `http://127.0.0.1:43210`，Next 内部开发端口为 3000。源码运行默认使用项目 `.data/`，不要指向真实安装数据。端口占用时查看启动输出中的实际地址。

```powershell
bun run typecheck
bun test tests
bun run qemu:prepare           # Windows + 7-Zip；校验下载并局部解压 QEMU
bun run package -- --with-qemu
bun run installer
```

产物位于 `dist/app/` 和 `dist/installer/`，不会输出到项目根目录。GitHub Actions 执行依赖安装、类型检查、无本机介质的单元测试、Windows EXE/基础安装包构建、隔离启动验证与 SHA256 清单生成。云端成功不代表已通过真实 WHPX、完整 OS 安装和独立 Docker 引擎验收。

[构建与 CI](docs/build-and-ci.md) · [分支与预发布约定](docs/releasing.md) · [项目目录](docs/project-layout.md) · [贡献说明](CONTRIBUTING.md)

## 当前边界

- 支持的自动安装版本固定，不能将任意 ISO 当作对应模板使用。Windows 镜像为官方评估版，DeskLab 不提供 Windows 商业许可证。
- CPU、内存和磁盘可在创建时调整；扩大虚拟磁盘后，可能仍需在客体中扩展分区和文件系统。
- Compose 支持预构建镜像、命名卷和固定端口；不支持本地 build、宿主目录挂载、特权容器、外部网络/卷及 secrets/configs。
- 尚不支持桥接、局域网发布、GPU/USB 直通、音频、宿主共享目录和 Windows 11 的完整 TPM/Secure Boot 初始化。
- 单用户本地应用，管理接口仅监听回环，使用 Host、Origin 和请求令牌保护；不提供远程管理或多用户权限体系。

## 文档与第三方组件

[文档索引](docs/README.md)集中列出使用说明和开发资料。`docs/plans/`、旧版本验证记录和 UI 变更记录属于历史资料，不代表功能承诺；当前能力以本 README 和使用指南为准。

项目尚未指定第一方源码的开源许可证，不应将仓库公开等同于 MIT/Apache 授权。Bun、QEMU、noVNC、Docker、Linux 发行版和安装器各自保留其许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
