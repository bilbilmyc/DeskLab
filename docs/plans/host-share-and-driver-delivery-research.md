# 宿主机目录共享与客户机驱动交付调研

调研日期：2026-10-07。范围：官方文档、上游 issue 与补丁系列、社区项目，以及本仓库代码和捆绑 QEMU 二进制的本地能力检查；只读研究。本轮没有创建 SMB 共享、没有新建宿主账户、没有在客户机内安装任何驱动，也没有修改虚拟机参数。凡涉及"应当可行"的推断都未做真实客户机验证，见文末验证清单。

## 结论

1. **两条"QEMU 原生"共享路线（virtio-fs 与 9p）在 Windows 宿主上当前都不可行。** virtiofsd 没有 Windows 宿主移植：官方 Rust 实现依赖 Linux 系统调用与沙箱机制，vhost-user 基础设施在 Windows 上仅部分支持，截至本轮检索没有进行中的移植计划。9p（virtfs）在官方 Windows 构建中被编译掉——本机捆绑的 QEMU 11.1.0 w64 二进制实测 `-fsdev help` 返回 "fsdev support is disabled"，`-device help` 中没有 `virtio-9p-pci` 和 `vhost-user-fs` 设备；上游 Windows 宿主支持自 2022 年起的 [跟踪 issue #974](https://gitlab.com/qemu-project/qemu/-/issues/974) 仍未合入，补丁停在 2023 年初的 v4 系列。要用 9p 就必须自维护 QEMU 分支，而且 Windows 客户机侧还缺 9p 客户端。
2. **不要把 QEMU `-nic user,smb=` 当作候选。** 该选项不是内嵌 SMB 服务器，只是让 QEMU 去启动宿主上的 Samba `smbd`（Linux 路径 `/usr/sbin/smbd`）。Windows 宿主没有 smbd，捆绑包也不含。官方 Windows 文档场景之外，这条路只在装了 Samba 的 Linux/macOS 宿主可用。
3. **挂载式共享的现实主线是"现有 slirp NAT + Windows 原生 SMB 服务"。** 用户态网络里 `10.0.2.2` 即宿主回环别名，安装期的 token HTTP 通道（`server/installations.ts` 的 `10.0.2.2:<port>`）已在生产中证明客户机可达宿主回环服务。同一通路可以承载 SMB：Linux 客户机用内核 CIFS 客户端 `mount -t cifs //10.0.2.2/...`（模板里补 `cifs-utils` 即可），Windows 客户机用系统原生 `net use \\10.0.2.2\...`，两类客户机都零驱动、零额外软件。代价集中在宿主侧：创建共享和配套账户需要管理员权限，与"单用户、运行期不提权的托盘应用"定位冲突，需要安装期一次性提权 helper 和受限专用账户设计。
4. **零提权的 v1 是把安装期 HTTP 通道推广为常驻文件通道，或内嵌 SFTP 服务端。** 它们提供的是"文件投放/回收"而不是挂载盘，但完全复用现有模式（token HTTP 通道、SSH 密钥体系），不改宿主、不需管理员、双向可用。本轮未找到维护状态良好的可嵌入 JS/Bun SMB2 服务端实现，自行实现 SMB2 + NTLM 风险高，不推荐。（2026-10-07 已按 HTTP 通道实现 v1，见 [docs/host-shares.md](../host-shares.md)。）
5. **驱动交付（virtio-win）是独立事项，且当前用户虚拟机刻意不需要驱动。** `server/lab.ts` 的用户虚拟机用 IDE 磁盘 + e1000 网卡，正是为了让 Windows 客户机开箱免驱动；引擎虚拟机（Linux）已在 WHPX 下验证 virtio-blk/net/serial + QGA 可用。引入 virtio-win 的前提是先把 Windows 用户虚拟机切到 virtio 设备（性能动机）或要启用 QGA/virtio-fs。交付机制完全复用现有 ISO 管线：`iso-sources` 加固定 URL + SHA-256 条目、`-cdrom` 挂载、Windows 配方补 `DriverPaths`，或装完后静默 `msiexec /i virtio-win-gt-x64.msi /qn`。
6. **virtio-win 内含 virtio-fs 驱动，但 Windows 客户机用 virtio-fs 还需要 WinFsp（GPLv3/商业双许可）。** 由于宿主侧 virtiofsd 缺失，这条链路整体不可用；WinFsp 只在未来出现可用宿主组件时才相关，引入前需过许可审阅。

## 与当前 DeskLab/QEMU 的关系

- **用户虚拟机参数**：`server/lab.ts` `start()`（约 292–303 行）构造 `q35,pic=off`/`pc`、单块 qcow2 `if=ide`、e1000 NAT（`server/network.ts` 的 `networkArguments()`，回环 hostfwd）、VNC 显示。IDE + e1000 是有意的免驱动组合，本轮所有方案评估都以此为基线：任何把 Windows 客户机迁到 virtio 的提案都会同时引入 virtio-win 依赖。
- **引擎虚拟机先例**：`server/docker/managed/engine.ts`（约 105–110 行）用 `virtio-blk-pci`、`virtio-net-pci`、`virtio-serial` + QGA，证明 WHPX 下 virtio 设备对 Linux 客户机可用；`server/docker/managed/guest-agent.ts` 是现成的 QGA 客户端（目前只用只读 `guest-get-fsinfo`）。
- **捆绑 QEMU 能力（本机实测，2026-10-07）**：`.runtime/tools/qemu/qemu-system-x86_64.exe`（Stefan Weil w64 构建，QEMU 11.1.0）`-fsdev help` → "fsdev support is disabled"；`-device help` 无 9p/vhost-user-fs 设备；`-nic user,smb=` 可解析但无实际后端。目录内无 `virtiofsd`。
- **ISO 管线**：`server/iso-sources.ts` 固定 8 个来源（url/bytes/sha256），`server/iso-downloads.ts` 只接受清单内来源，断点续传、校验通过才发布。清单目前没有 virtio-win。`server/lab.ts` 已有 `-cdrom` 挂载与弹出（`eject()`）。
- **文件投递先例**：`server/installations.ts` `listen()` 在安装期起 token 保护的 Bun HTTP 服务，客户机经 `http://10.0.2.2:<port>/install/<token>/...` 拉取文件并回调——这就是"宿主向客户机供文件"的已验证通路。
- **配置模型**：`Machine`（`shared/types.ts`）以 JSON 文档列存 SQLite，新增 `shares`/`drives` 等字段不需要数据库迁移；Zod 输入在 `server/validation.ts`。注意 `server/validation.ts:31` 的 `qemuValue()` 负责路径逗号转义，未来任何进入 `-drive`/`-nic` 的宿主路径都要走它。
- **Windows 安装配方**：`server/install-recipes.ts` 的 `windowsRecipe` 生成 Autounattend.xml，目前没有 `DriverPaths`/`PnpCustomizations` 节；`Finish.ps1` 靠扫描盘符 D..Z 定位。

## 目录共享各路线细节与边界

### virtio-fs：宿主侧阻断，仅客户机侧成熟

Windows 客户机侧方案成熟：virtio-win 提供 viofs 驱动，配合 [WinFsp](https://github.com/winfsp/winfsp) 与 virtiofs 服务即可挂载。但宿主侧需要 virtiofsd 守护进程经 vhost-user 与 QEMU 通信，而 virtiofsd 只有 Linux 实现，Windows 宿主没有等价物；vhost-user 基础设施本身在 Windows 上也只是部分支持。结论：在出现可用的 Windows 宿主 virtiofsd 之前，此路线对 DeskLab 关闭，仅作为长期跟踪项。

来源：[libvirt Virtiofs 文档](https://libvirt.org/kbase/virtiofs.html)、[virtiofsd 上游仓库](https://gitlab.com/virtio-fs/virtiofsd)、[QEMU vhost-user 文档](https://www.qemu.org/docs/master/interop/vhost-user.html)。

### 9p：需要自维护 QEMU 分支，Windows 客户机还缺客户端

上游有 [Windows 宿主支持跟踪 issue #974](https://gitlab.com/qemu-project/qemu/-/issues/974)（2022 年开），对应 [2023 年初的 v4 补丁系列](https://lists.nongnu.org/archive/html/qemu-devel/2023-01/)只覆盖 `local` 后端的部分操作，至今未合入主线；官方与社区 Windows 构建因此都不含 fsdev。社区存在 [Virtio9PFS-handler](https://github.com/derfsss/Virtio9PFS-handler)（基于 WinFsp 的 Windows 端 9p 客户端 handler），说明"自建 QEMU + WinFsp 客户端"理论上能凑齐两端，但这意味着同时维护一个 QEMU Windows 分支和客户机侧第三方组件，与当前"捆绑上游原版构建"的分发策略冲突。Linux 客户机侧 9p 客户端是内核自带（`mount -t 9p`），但当前捆绑 QEMU 连宿主侧都没有 9p，Linux 客户机也无从受益。结论：不推荐，仅当上游合入 Windows 支持后重估。

来源：[QEMU 9psetup 文档](https://wiki.qemu.org/Documentation/9psetup)。

### QEMU `-nic user,smb=`：Windows 宿主不可用

slirp 的 `smb=` 选项由 QEMU 进程拉起宿主上的 Samba `smbd` 并导出目录，是 Linux/macOS 宿主的功能；Windows 上既无 smbd 也不在捆绑范围。代码里也没有任何引用。结论：排除。

来源：[QEMU 用户态网络文档](https://www.qemu.org/docs/master/system/net/invocation.html)。

### Windows 原生 SMB（LanmanServer）+ `10.0.2.2`：挂载式共享的候选主线

原理：slirp 用户态网络中 `10.0.2.2` 映射到宿主回环，客户机可以连宿主监听回环的任意服务（安装期 HTTP 通道已验证此通路）。Windows 宿主的文件与打印机共享服务（LanmanServer，445 端口）监听含回环在内的所有接口，因此：

- **Windows 客户机**：`net use Z: \\10.0.2.2\<共享名> /user:<账户>`，系统原生 SMB2/3 客户端，无需驱动或第三方软件。
- **Linux 客户机**：`mount -t cifs //10.0.2.2/<共享名> -o username=...`，内核 CIFS 客户端自带，`cifs-utils`（mount 辅助工具）需要装进模板——DeskLab 自己维护 preseed 模板，加包可控。
- **协议兼容性推断（未实测）**：hostfwd 场景下宿主侧来源是 QEMU 进程发起的回环连接，Windows 防火墙不过滤回环流量；现 SMB 服务器默认 SMB2/3，现代 Windows 客户机不会退到 SMB1。

代价与风险，全部在宿主侧：

1. **提权**：`New-SmbShare` 与本地账户创建需要管理员。对"运行期不提权的托盘应用"，合理设计是安装期（安装器本来提权）或一次性授权的 helper 预建受限专用本地账户 + 按 VM 建共享并收紧 ACL（拒绝交互登录、只授权共享目录）；运行期只做启用/停用。匿名/来宾 SMB 访问在现代 Windows 默认关闭，必须用真实凭据。
2. **凭据下发**：客户机要知道宿主账户口令才能挂载。凭据经 seed ISO/finish 脚本注入客户机，等于假定客户机可信——这与"测试环境"定位一致，但要在文档中明示：挂载共享的口令在客户机内可见。
3. **产品面**：这是"每 VM 一个共享"还是"全局共享目录池"、挂载是否随开机自动恢复（Linux fstab/`credential=` 文件、Windows `net use /persistent`）需要产品决策。
4. **边界**：仅 NAT 内可达（10.0.2.2 不出现在物理网络），不引入局域网暴露，符合当前网络边界承诺。

### 零提权 v1：常驻 HTTP 文件通道或内嵌 SFTP

- **HTTP 通道**：把 `server/installations.ts` 的 token 模式推广为随 VM 生命周期常驻的服务：宿主侧配置若干目录，客户机以 `http://10.0.2.2:<port>/<token>/...` 浏览/下载（GET）和上传（PUT/POST + 大小与路径白名单）。Linux 客户机 `curl`/`wget`，Windows 客户机 `Invoke-WebRequest`（Windows 10+ 自带 OpenSSH 与 PowerShell，零依赖）。优点：不提权、不改宿主、完全复用现有代码模式。缺点：不是挂载盘，没有随机读写的语义。
- **SFTP 通道**：内嵌 `ssh2` 一类库的 SFTP 服务端，DeskLab 已有 SSH 密钥体系，可生成每 VM 凭据。Windows 10+ 自带 `sftp`/`scp` 客户端，Linux 原生可用；双向、断点、权限模型都比 HTTP 上传好。仍不是挂载盘（Windows 侧挂载需客户机装 WinFsp + sshfs-win，Linux 侧 sshfs 也要装）。
- **定位**：两者都是"文件传输"而非"共享目录"。作为 v1 与挂载式 v2 并不冲突：传输通道先落地，SMB 挂载作为体验升级另行立项。

### 兜底：次盘离线交换

给停止的 VM 临时挂一块 raw/VHDX 次盘（复用 `-drive` 机制与现有磁盘配额管理），宿主侧用 Windows 原生 VHDX 挂载写入，再启动 VM 读取。只适合"停机交换"，不能在线共享，且宿主与客户机同时挂载同一镜像会损坏数据，必须强制互斥。价值在于不引入任何网络协议，可作为 SMB 不可行时的退路。本轮未验证 Windows 家庭版的 VHDX 挂载可用性。

## 驱动交付（virtio-win）细节

**是什么、从哪来**：Red Hat 维护的 Windows virtio 驱动集合，官方分发在 [fedorapeople direct-downloads](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/)（stable ISO）。内容含存储（viostor/vioscsi）、网卡（netkvm）、balloon、串口（vioserial，QGA 通道）、rng、virtio-fs（viofs）、GPU/输入等驱动，以及整包 MSI（`virtio-win-gt-x64.msi`）和 QGA 安装器。许可为 GPLv2，允许随产品重分发，需更新 `THIRD_PARTY_NOTICES.md` 并按仓库惯例固定版本 + 字节数 + SHA-256 加入 `server/iso-sources.ts`（当前 8 条清单，加第 9 条即可复用下载/校验/缓存全链路）。

**什么时候需要**：当前不需要。IDE + e1000 的设计目标就是 Windows 客户机免驱动。引入 virtio-win 的触发条件只有一个——把 Windows 用户虚拟机切到 virtio 设备（virtio-blk 的 I/O 性能显著优于 IDE，尤其 WHPX 下），或为其启用 QGA（干净关机、文件操作）。"切 virtio"本身是独立的产品决策，应另立文档论证；一旦决定，驱动交付按下面三条路径之一走。

**交付路径**（按时机）：

1. **安装期**：Windows 安装时把 virtio-win ISO 作为第二张光盘挂载（现有 `-cdrom`/`media=cdrom,index=N` 模式，seed ISO 已用 `index=3`），并在 `windowsRecipe` 的 Autounattend.xml 里加 `<DriverPaths>`（`PnpCustomizations` 阶段）指向该盘。这样系统装完时 virtio 磁盘/网卡驱动已就位，适合"直接以 virtio-blk 为安装目标"的方案。参考上游自动化测试的做法（[avocado-vt 文档](https://avocado-vt.readthedocs.io/en/latest/GetStarted/Configure.html)）。
2. **装完后**：不改安装流程，`Finish.ps1`（已能从光盘/`10.0.2.2` 通道拿文件）执行 `msiexec /i virtio-win-gt-x64.msi /qn` 静默装驱动。驱动先行入仓（staging），之后切硬件时即插即用；一般无需为未见设备重启。适合"先按 IDE 装、后迁 virtio"的渐进方案。
3. **按需**：用户手动经现有 `isoPath` 挂载 virtio-win ISO，在客户机设备管理器里指认。作为兜底写进使用文档即可。

**与共享功能的协同**：若 HTTP/SMB 共享落地，virtio-win ISO 内容（或解包后的驱动目录）可以经共享通道提供给所有客户机，避免每个用户单独下载 1 GiB 级 ISO；这属于实现期优化，不影响路线。

**WinFsp 边界**：virtio-fs 驱动在 Windows 客户机内必须配合 [WinFsp](https://github.com/winfsp/winfsp)（GPLv3 与商业双许可，MSI 支持 `msiexec /qn` 静默安装）。在宿主侧 virtiofsd 缺失的当下不需要引入；若未来引入，需先过许可审阅并在第三方声明中记录。

## 后续验证优先级

1. **SMB 通路实测（零代码）**：手工在宿主建一个 SMB 共享与受限测试账户，在一台现有 Linux 测试机内 `mount -t cifs //10.0.2.2/...`、一台现有 Windows 测试机内 `net use \\10.0.2.2\...`，验证 SMB2/3 协商、NTLM 认证、大文件与并发读写。不通过则挂载式主线降级，v1 只做传输通道。
   - 2026-10-07 进展（真实 Debian 13.6 与 Windows 10 22H2 客体，`.runtime/checks/guest-probe-*/`、`guest-smb-*/`）：两类客体经 slirp NAT 到 `10.0.2.2:445` 的 TCP 连通均已实测成立（`SMB445=OPEN`，宿主 LanmanServer 监听回环）；v1 文件通道也在同一批客体里完成了浏览、下载与上传回传的真机验证（Linux 用 `curl`，Windows 用 `curl.exe` + PowerShell）。
   - 2026-10-07 SMB 协商验证（`scripts/checks/guest-smb-probe.ts`）：Debian 客体内内核 CIFS 客户端以 `vers=3.0` 挂载 `//10.0.2.2/...`，dmesg 显示完整完成 SMB3 方言协商与 NTLM 会话建立，错误凭据在**认证层**被拒（`SessSetup = -13`、`STATUS_ACCESS_DENIED`），无网络层错误。基础挂载不需要 mount.cifs 助手（内核即可）；客体在线 apt 不可靠（DNS 返回 IPv6 优先而 slirp IPv6 受限），**cifs-utils 应预装进安装配方**。**剩余未验证**：宿主建共享与专用账户（需管理员）、有效凭据下的实挂载与读写。
   - 同轮副产物：该模板的 `serial-getty@ttyS0` 未输出登录提示（系统正常启动），客体自动化优先走 tty1 + QMP send-key 或 SSH。
2. **模板侧准备**：Linux preseed 增加 `cifs-utils`；Windows 客户机验证 `net use` 持久化与开机自动重连。
3. **virtio-win 管线预演**：固定一个 stable ISO 版本 + SHA-256 试下载校验；在一台 Windows 模板上试装（`DriverPaths` 与静默 MSI 两种），确认无对话框、无强制重启。
4. **virtio 切换 PoC（仅当决定切换）**：WHPX 下 Windows 客户机以 virtio-blk/virtio-net 完成"安装期加载驱动→装完可用"的全流程；目前只有 Linux 引擎虚拟机验证过 virtio。
5. **长期跟踪**：[QEMU 9p Windows 宿主支持（#974）](https://gitlab.com/qemu-project/qemu/-/issues/974)与 virtiofsd Windows 移植动向；有实质进展再重估挂载式共享的技术选型。
