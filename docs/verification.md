# 本机验证记录

## 托盘、网络、SSH 密钥和目录归整

- 原运行 Ubuntu 的 `10.0.2.15` 位于 QEMU NAT 内；已通过核对身份的 QMP 添加 `127.0.0.1:2222 → guest:22`，收到 OpenSSH 服务 banner。未重启该实例、未修改其登录策略；未代替用户验证密码。
- 新增 NAT / Windows TAP 桥接配置、独立 MAC、实例连接面板、本机 Ed25519 密钥与新装 Linux 公钥授权。桥接网卡缺失时明确提示，不把 VMnet / vEthernet 当作可用 TAP。本机缺少 TAP 网络桥，因此实际桥接 DHCP / 局域网 SSH 未实机验证。
- 自动测试 99 通过、1 个平台条件跳过；覆盖端口占用、恢复时复用转发、真实密钥生成/重用、私钥不出现在 API 元数据、安装脚本公钥配置、网络参数与无效配置。
- 原生 NotifyIcon 实测菜单事件、正常关闭、父进程管道关闭后的清理；打包 EXE 在隔离数据目录启动，真实 QEMU 创建 NAT 转发、运行中退出保护、浏览器关闭后服务可用、显式退出后主进程与托盘均结束。
- 浏览器 95 项检查通过：9 种窗口尺寸、控制台连接栏高度、设置页、键盘可达性、密钥命令复制、旧镜像授权指引、关机状态保存桥接配置及新建默认 NAT。桥接选项使用浏览器 fixture，未改动宿主机网络。
- 输出约定与历史文件归档见 `project-layout.md`。新的可重复检查入口在 `scripts/checks/`；以下保留此前功能的验证记录。
- 最终安装包已通过隔离安装、覆盖升级、卸载与数据保留检查；应用、安装包分别位于 `dist/app/`、`dist/installer/`。用户正在使用的安装目录未替换。

日期：2026-09-12（Asia/Shanghai）。

宿主：Windows 10 Pro x64，Intel i5-11600K，系统报告约 63.9 GiB 内存。Bun 1.3.14，Next.js 16.3.4，QEMU Windows 11.1.0。

## 已执行并通过

- `bun run typecheck`：所有应用、服务、打包和测试脚本类型检查。
- `bun test tests`：19 项测试，包含资源输入约束、目录逃逸拒绝、QEMU 路径转义、重置回滚、已提交重置恢复、删除回滚、保存失败的内存回滚、未完成启动的磁盘保护、未知 backing 依赖的删除保护、固件输入校验、UEFI 变量隔离与保留。
- `bun run smoke`：真实 WHPX 启动；QMP 控制；TCP VNC 握手；持久化记录重新加载后核对 QMP 身份并接管运行中的 VM；运行状态下拒绝磁盘操作；独立模板保存、backing 依赖保护、恢复、重启、删除。
- `bun run test:api`：拒绝不可信 Origin 和无令牌写请求；真实 WebSocket→VNC 握手；主程序突然退出后的状态校验；后续重新启动、关闭、删除。
- 该宿主上测试工具强制结束主程序时，QEMU 子进程也被结束；测试确认没有存活的孤儿进程，并成功重新启动。存活 VM 的重接管分支由 `smoke` 中的持久化重新加载场景独立覆盖。
- `bun scripts/build/package.ts --with-qemu`：构建静态页面并编译 Windows x64 EXE，复制本地 QEMU 运行文件和固件。
- 从不含网页构建目录的另一工作目录启动 EXE，嵌入页面正常提供服务，自动发现 EXE 旁的 QEMU 引擎和磁盘工具。
- 浏览器人工自动化：本机设置保存与检测、真实 qcow2 模板导入、从模板创建环境、启动、打开 noVNC 桌面。实际画面显示 SeaBIOS 和生成的 `DeskLab VM boot OK` 文本，浏览器没有捕获到 error/warn 日志。
- 320、375、414、768、1024、1440 像素下检查根页面无横向溢出；检查创建对话框、导航、模板页和设置页。
- 自检实例及模板已从正常工作空间删除，`.runtime` 中保留独立测试日志/镜像便于复查。

## 完整系统安装与默认账号

现有 8 张 ISO 均已安装到独立磁盘；Ubuntu / Debian / Rocky 的 Server 和 Desktop 各 1 个，Windows 10 Enterprise Evaluation 与 Windows Server 2022 Standard Evaluation Desktop Experience 各 1 个。

- Linux 使用 root，Windows 使用内置 Administrator，密码按用户要求设置为 `DeskLab0987`。
- Linux 用实际 SSH 密码认证核对 root 身份，并核对自动登录会话；Windows 使用 Win32 LogonUser 实际验证密码，并检查 Administrator / explorer 会话。
- 每个系统均正常关机后移除安装介质，再冷启动检查自动进入终端或桌面；之后导入独立模板、创建差分实例，在真实 DeskLab / WHPX 中再次启动并截图。
- 逐项记录以 `iso/prepared-images.json` 为准；平台实例画面保存在 `iso/boot-evidence/`。准备阶段回调、启动报告脚本已从模板客体中移除。
- Windows 10 已通过微软官方在线评估激活，LicenseStatus=1，验证时剩余 129600 分钟（90 天）。Windows Server 保持官方评估版，不提供商业激活。
- 应用新增 BIOS / UEFI 元数据继承、UEFI 固件文件检查、实例独立变量文件、恢复后新的变量文件及 Windows 本地 RTC。通过真实 QEMU 检查导入、克隆、保存模板和恢复后的 UEFI 行为。
- 新版 EXE 已打包；浏览器检查模板列表显示正确启动方式，点击指定模板后默认选中该模板且不再要求 ISO。

## 已知兼容性与验证范围

- 本次覆盖安装、登录、冷启动与模板创建，未逐项验证所有系统应用、更新、图形加速和长期运行稳定性。
- Windows 11 的 TPM / Secure Boot 初始化、macOS 宿主、GPU/USB 直通、音频、共享目录、远程多用户访问未实现。
- QEMU 软件模拟（TCG）是诊断选项；本轮主要验证 WHPX。
- 未做断电持久性认证；恢复测试模拟应用层中断。数据仍应定期备份。

- Windows BIOS 安装在本机 WHPX 下出现蓝屏；采用 Q35 + UEFI + Westmere CPU 后完成安装和冷启动。
- 本机 WHPX 的进程内复位仍不可靠；DeskLab 已通过接管客体重启解决产品操作路径，详见下节。参考 [QEMU WHPX 文档](https://www.qemu.org/docs/master/system/whpx.html) 和 [UEFI 重启问题 #2402](https://gitlab.com/qemu-project/qemu/-/issues/2402)。
- Ubuntu Desktop ISO 的原内核在本机 WHPX 下触发 FP/XSAVE 错误；模板改用官方 Ubuntu Server ISO 的 GA 6.8 内核、传统 GRUB 启动和 `noxsave`，GNOME 桌面会话已实际验证。

## 配套程序入口

- 移除 CMD 入口，打包生成根目录 `DeskLab.exe`，直接查找旁边的 `.data`、`iso`、`runtime`；项目内的 dist 副本通过 bundle 标记定位同一套数据。
- 界面提供配套镜像选择，加载已配套 ISO 时由服务端关联已安装系统；自定义 ISO 和显式重新安装仍保留原安装流程。
- 配套启动完成创建、启动及打开 noVNC 控制台；资源与固件继承经过检查。
- 配套目录定位和镜像清单验证增加 2 项单元测试；真实 QEMU 验证配对、重新安装、相对 backing、重置与迁移后的启动。
- 从无配置的其他工作目录运行根目录 EXE，确认读取项目 `.data` 并发现全部 8 个已配套镜像；重复运行 EXE 成功退出，原服务 PID 保持不变。
- 浏览器选择 Debian Server 配套镜像并点击“启动系统”，确认自动打开控制台且进入 root 自动登录终端；截图为 `iso/boot-evidence/bundled-iso-debian-server.png`。该验证环境随后正常关机并删除。

## Windows 重启调试与独立 EXE

- 基线实际捕获 `WHPX: Unexpected VP exit code 4` 和 QMP `paused`。`kernel-irqchip=off`、单核两个对照均在重启后黑屏，240 秒内没有新系统启动回报，均判失败。
- 修复采用 QEMU `-action reboot=shutdown,shutdown=pause` 与独立 QMP 事件连接。只有 `guest-reset` 触发新进程启动；确认旧 PID 已退出之后才重新打开原磁盘。正常关机、宿主强停和应用退出不会自动重启。
- `.runtime/windows-debug/production.ts desktop` 和 `server` 各使用独立差分副本，真实验证冷启动、连续两次客体 `shutdown /r /t 0`、正常关机。每次重启均确认 QEMU PID 改变、Windows LastBootUpTime 改变、Administrator 的 Explorer 会话存在。两组全部通过，仍使用 2 核和 WHPX。
- 截图为 `iso/boot-evidence/windows-desktop-reboot.png`、`windows-server-reboot.png`；机器可读结果为对应调试目录中的 `result.json`，汇总写入 `iso/prepared-images.json`。调试脚本仅写入独立测试磁盘，不写原模板。
- `bun scripts/checks/reboot-smoke.ts` 在修复前失败；修复后覆盖真实客体复位、连续进程重建、恢复接管后的复位、暂停后保护磁盘、宿主停止后保持关闭。
- 单 EXE 已包含 Bun、网页和 Windows x86 QEMU。复制 EXE 到空目录、使用独立用户目录启动，通过 `bun scripts/checks/standalone-smoke.ts` 验证内置引擎释放、外部磁盘导入、实际引导代码执行、QMP、WebSocket/VNC 与测试资源清理。
- 另外在成品 EXE 中创建 Windows 测试环境，实际执行客体重启，确认 QEMU PID 改变、浏览器无需刷新自动重连并重新显示桌面；截图为 `iso/boot-evidence/windows-exe-reboot.png`。测试环境随后正常关机、删除。
- 19 项单元/回归测试通过，其中新增恢复中断、事件订阅顺序、退出失败后的状态清理和程序退出竞态测试；真实 QEMU 的 `smoke`、`test:api`、`bundle-smoke`、`reboot-smoke` 全部通过。
- ISO 和模板路径输入旁均增加 Windows 原生“选择文件”入口；浏览器已核对入口和表单。原生文件对话框尚未做自动交互验证，路径输入及后续本地导入流程已通过实际测试。
- 新用户数据默认位于 `%LOCALAPPDATA%/DeskLab/data`，兼容现有 EXE 旁 `.data/lab.json`。ISO 目录与数据目录在本机设置中显示；macOS 发布仍未实现。

参考：[QEMU shutdown 原因](https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html#enum-ShutdownCause)、[Bun 单文件内嵌资源](https://bun.com/docs/bundler/executables)。

## 模板入口与新手流程（2026-09-12）

- 内置 8 套模板目录，区分「系统自带」与「我的模板」，现有基盘迁移后不再依赖 ISO 是否存在。成品 EXE 启动后确认 8 套内置系统全部就绪，原 8 个环境均保留并处于关闭状态。
- 创建流程为「选择系统 → 命名并启动」，资源设置默认收起；自定义模板可编辑名称、说明、默认资源及登录提示。系统自带模板禁止直接修改或删除。
- 全量 26 项测试、130 次断言通过，包括真实 qemu-img 导入/克隆/保存、原磁盘完整性、多次保存后的 backing 与恢复点删除保护，以及保存后卸下 ISO 再从磁盘启动。
- 在隔离数据目录中通过浏览器实际创建 Debian Server，看到 root 自动登录终端；正常关机并保存自定义模板，编辑默认内存为 4 GB，再从「我的模板」创建第二个环境，确认实际分配 4 GB 并再次自动进入 root 终端。两台验证环境随后均正常关机。原有配套模板没有写入改动。
- UI 检查覆盖 320、768、1024、1440 像素宽度，无横向溢出；检查系统/自定义/ISO 模式切换、缺少磁盘和空模板场景，以及关闭弹窗后的焦点恢复。缺资源等边界场景使用请求拦截，实际系统启动与保存流程使用真实后端。
- Next 静态构建与 Windows EXE 打包通过，根目录 DeskLab.exe 已更新。模板目录与默认参数编入程序，系统磁盘继续放在数据目录；当前未接入在线模板下载服务。
- 浏览器检查记录与截图在 .runtime/template-ui-evidence/，包括 report.json。原生文件选择器不在本次自动交互验证范围内。

## ISO 目录与在线下载（2026-09-12）

- 「本机设置 → 系统镜像」可选择或输入 ISO 目录，保存后立即扫描。原版 ISO 显示「启动安装」，缺少 ISO 显示「在线下载」；已安装模板仍可直接创建环境。下载临时文件不会出现在可用 ISO 清单中。
- 全量 48 项测试、235 次断言通过，覆盖真实 HTTP 流、两路并发、排队、暂停续传、Range/ETag 不一致、断网、哈希失败、独立下载子进程被强制结束后的恢复、同名文件保护、目录切换与退出错误清理。
- 新版根目录 EXE 从另一个工作目录启动，识别原来的 8 个 ISO、8 套已准备模板与 8 个关闭状态的环境。目录设置保存在数据目录，下载清单编入 EXE。
- 在隔离目录中通过真实 UI 下载 Rocky Linux 9.8 Server：暂停时已保存 653799298 字节，继续后增长；再次暂停到 1171676368 字节，退出并换用成品 EXE 后准确恢复相同进度。最终完整下载 2755067904 字节，SHA-256 为 d338032cd1cdd41c67139f2f71b4c832c8e4a21943106519db9c7137df7a63d4，与官方值一致。
- 下载完成后 UI 自动显示「启动安装」。通过该按钮创建测试环境，ISO 路径与 Rocky 系统类型自动填入；成品 EXE 使用 2 核、2 GB 内存和 BIOS 实际启动，浏览器显示 Rocky Linux Minimal 9.8 安装启动菜单。该测试只确认安装盘引导，不重复执行完整系统安装；验证后已关闭测试虚拟机与测试服务。隔离数据保留在 .runtime/iso-ui-1789177779/，递归清理被自动审批策略拦截。
- 26 项浏览器检查通过，覆盖 320/768/1440 宽度、真实进度字段的渲染、离开后返回、键盘操作、恢复默认目录和缺少模板时的引导；多下载状态及文件夹选择器交互使用请求拦截模拟。原生文件夹对话框尚未做自动交互验证。
- 证据位于 .runtime/iso-ui-evidence/：report.json 与截图为浏览器边界场景；real-download.json 为真实完整下载及本地 SHA-256 记录，real-iso-boot.json 为实际启动环境的状态。此次仅重新下载并引导了 Rocky Server，其余来源的地址和校验资料核查见 [ISO 下载源核验](iso-sources.md)。

## 模板库与本机设置卡片布局（2026-09-12）

- 模板库和 ISO 安装盘改为卡片网格：320/768/1024/1440 像素宽度下分别显示 1/2/2/3 列。模板详情和 ISO 来源说明使用独立弹窗，避免展开内容推长整行卡片。
- 本机设置分为「系统镜像」和「运行与存储」；切换分组保留未保存的目录及引擎输入。「运行与存储」包含运行环境、本地存储和帮助卡片。下载入口直达系统镜像，查看本机配置直达运行与存储。
- 65 项浏览器检查全部通过，无脚本错误；覆盖响应布局、长名称、详情与管理入口、焦点恢复、ISO 路径预填、模拟下载暂停/恢复/错误和分组跳转。所有写入请求均被测试拦截，未实际修改配置、下载文件或创建虚拟机。
- TypeScript 检查、Next 静态构建与 Windows EXE 打包通过。报告和截图保存在 .runtime/cards-ui-evidence/。

## 内置安装配方、安装包与环境列表滚动（2026-09-12）

- Windows 安装包内含程序、运行引擎和小型自动安装配方，不含原版 ISO 或预先安装的系统磁盘。独立目录中执行安装、覆盖升级、卸载共 11 项检查通过；初始 `data/` 与 `iso/` 为空，升级及卸载保留测试数据。证据：`.runtime/installer-check-1789182465179/result.json`。最后两次程序更新另外核对了专用测试目录 220 项路径、元数据和文件哈希，全部保留。
- `bun test tests` 全量通过 79 项测试、609 次断言，覆盖安装介质生成与解析、原版 ISO 提取、安装资源访问校验、目录链接拒绝、状态恢复和下载生命周期。最终启动兼容修复后，TypeScript、Next 静态构建、EXE 编译以及 10 项恢复/重启回归再次通过。
- 环境列表拥有自己的滚动区域，侧栏、页面标题、资源统计和筛选栏保持固定。100 项浏览器检查通过，覆盖 320/768/1024/1440 宽度、短视口、滚轮、PageDown、最后一张卡片的键盘聚焦，文档滚动位置保持为 0。报告：`.runtime/machine-scroll-evidence/report.json`。创建向导另外通过 9 项检查，确认无已安装模板时提交原版 ISO、内置配方及正确资源；报告：`.runtime/install-ui-evidence/report.json`。
- Ubuntu Server、Debian Server、Rocky Server 与 Windows 10 均从原版 ISO 完成无人值守安装，程序收到安装完成报告并观察到客体正常关机后缓存基础系统，再自动从磁盘启动。Linux 三套系统通过实际 SSH 密码认证验证 `root / DeskLab0987`，并核对 tty1 自动登录；测试用临时端口转发已移除。证据：`.runtime/unattended-final/linux-password-verification.json` 及同目录下 `data/lab.json`、`screens/`。
- Windows 10 安装收尾脚本通过 Win32 LogonUser 验证 Administrator 密码并检查 Explorer 会话。随后通过 API 从新缓存创建了第二个环境：无 ISO、无安装任务、新的 UEFI 变量文件、独立差分磁盘，再次自动进入 Administrator 桌面。副本经 API 正常关机；报告：`.runtime/unattended-final/windows-clone-verification.json`。
- Windows Server 使用真正安装后的 EXE，在 `C:\Windows` 工作目录、未设置 `LAB_DATA_DIR` 或 QEMU 路径的条件下完成同一流程。首次启动自动准备内置引擎，原版 ISO 由应用生成的独立配置介质驱动；安装状态依次经过 `installed → caching → ready`，记录了真实的客体正常关机。过程中修复了 Windows 工作目录遮蔽 QEMU 键盘映射文件，以及某些原版 DVD 提示只输出到画面导致自动按键漏触发的问题。最终运行程序与发布 EXE 哈希一致；原版 Server ISO 的 SHA256 与安装准备前相同。证据：`.runtime/unattended-installed/first-use.json`、`observed-result.json`、`source-iso-verification.json`。
- Windows Server 缓存后的主环境与新建差分副本均自动进入中文桌面。副本不带 ISO/安装任务，使用新的 UEFI 变量文件；一次性客体只读探测确认 Administrator、Explorer 和自动登录设置。证据：`.runtime/unattended-installed/final-install-verification.json`、`windows-server-clone-verification.json` 和 `screens/`。全部本轮安装/克隆测试环境正常关机，测试服务与前端开发服务已退出；用户原工作区的成品服务继续运行。
- 已替换当前项目根目录的 EXE，并刷新用户现有浏览器页面。8 个原环境、8 套原模板和 8 个本地 ISO 均保留，环境全部关闭且无错误；实测成品页面只有环境卡片滚动。备份和更新核对：`.runtime/before-unattended-20260912-111840/`。

## 安装版桌面启动与图标修复（0.1.1，2026-09-12）

- 在真实 `D:\apps\DeskLab` 安装目录复现：项目中的旧服务占用 43210，安装版以 `EADDRINUSE` 退出。仅改变端口即可正常运行。新增启动回归先确认失败，再实现自动选择空闲端口、记录实际地址和同数据目录实例复用；地址复用同时验证数据目录与锁持有者 PID，避免打开另一个目录的环境。
- 启动失败改为保存 `data/logs/startup.log` 并在桌面启动时显示可读错误对话框。正常启动不创建控制台；页面提供“退出程序”，拒绝在环境仍运行时退出，成功后停止轮询并显示“DeskLab 已退出”。
- 程序、安装包、桌面/开始菜单快捷方式及卸载入口使用 DeskLab 图标与 0.1.1 文件元数据。Bun 1.3.14 的 hideConsole 选项未实际写出 GUI 子系统，打包后仅对本项目生成的未签名 EXE 做受限兼容处理；8 个图标尺寸、PE 头和保护条件均通过验证，真实小型程序的 GetConsoleWindow 为空。记录：`.runtime/windows-branding-evidence/`。
- 全量 82 项测试、629 次断言通过；另通过真实 API/QEMU/WebSocket、异常退出恢复与资源清理检查。TypeScript、Next 静态构建和成品安装包构建通过。
- 使用新安装包覆盖升级用户安装目录，配置文件哈希保持一致，快捷方式明确引用 `D:\apps\DeskLab\DeskLab.ico`。在旧项目服务占用端口时，从桌面快捷方式实际启动新 EXE，自动选择 56572 并在默认 Chrome 打开正确页面；再次启动保持同一服务 PID。通过实际 UI 退出后再从桌面快捷方式启动。旧项目后台服务已经退出，原项目数据保留。证据：`.runtime/before-startup-fix-20260912-114217/`。
- 安装目录与 dist 中均为 0.1.1；根目录历史 EXE 未同步更新，相关组合命令被自动审批策略拒绝，未尝试绕过。当前应使用桌面快捷方式或 `D:\apps\DeskLab\DeskLab.exe`。

## 安装版文件选择修复（0.1.2，2026-09-12）

- 在用户原 Chrome 页面复现：只点击“选择文件”即出现“正在创建并启动…”，取消被禁用；外部 PowerShell 文件选择请求最终超时。界面共享 busy 状态已确认是表单锁定的原因，原生窗口不可见的具体 Windows 焦点原因未作确认。
- 移除原生 PowerShell 选择入口，改为页面内本机文件浏览器。ISO、虚拟磁盘和目录共用组件，支持常用位置、上级目录、完整路径、中文和空格、独立加载状态与立即取消。读取结果不会创建环境或上传文件。
- `/api/files/list` 保留 Host、Origin 和令牌校验，独立于虚拟机操作队列。单次最多返回 500 项并扫描 5000 项；显式指定的文件在截断列表中保留。常用位置探测每项最多等待 500ms，结果缓存 30 秒，离线盘不会阻塞其他位置。
- 完整现有测试运行 88 通过、1 POSIX 权限测试在 Windows 跳过，669 个断言。随后增加扫描上限与快捷位置限时处理，定向文件测试 7 通过、1 跳过，37 个断言；离线盘挂起模拟 5 个断言通过。类型检查与最终 EXE 构建通过。
- 在最终 EXE 和实际安装版各运行真实浏览器回归，覆盖 ISO 路径回填、目录选择、磁盘选择、取消、慢请求取消、错误恢复及 375/768/1440px 布局。仅慢请求场景延迟网络，文件列表使用真实本机 API；没有创建环境、导入磁盘或保存设置。记录：`.runtime/file-picker-evidence/compiled-report.json`、`report.json`、`iso-picker.png`；脚本：`.runtime/file-picker-ui-verify.mjs`。
- 通过正式安装包覆盖升级 `D:\apps\DeskLab`，EXE SHA256 与构建清单一致，`data/lab.json` 升级前后哈希一致。桌面快捷方式启动成功，版本 0.1.2。最后在原 Chrome 标签页再次选择真实 Ubuntu Server ISO 并回填创建表单，保持等待用户创建。安装日志：`.runtime/file-picker-evidence/upgrade.log`。
