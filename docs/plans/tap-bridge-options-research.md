# Windows 10 TAP 与桥接替代方案调研

调研日期：2026-09-12。范围：官方文档与源码，只读研究；没有下载或执行安装程序，没有更改宿主网络。本文对第三方机制的分析不等于已通过本机联网验证。

## 结论

1. **TAP 驱动和多实例网卡创建可以自动化，不需要安装整个 OpenVPN 客户端。** 保留上游签名驱动包，使用 Windows PnPUtil 登记驱动，再用 tapctl 创建、命名、删除 DeskLab 所属 TAP。TAP 只解决 QEMU 到 Windows 的虚拟以太网端口，**本身不创建到物理网卡的网桥**。
2. **SoftEther Local Bridge 是值得做隔离 POC 的开源替代路线。** 它有命令行控制、自带 Windows 二层驱动，可以考虑 `QEMU → OpenVPN TAP → SoftEther Virtual Hub → 有线物理网卡`，避开 Windows 原生 Network Bridge 的创建 API。但是“OpenVPN TAP 在 SoftEther 枚举中可用”“当前签名组件在 Windows 10 加载”“宿主与虚拟机双向通信”必须实测，不能直接宣布已可用。
3. **Npcap 和 WinpkFilter 不适合作为免费即装即用的默认产品依赖。** 前者的静默安装与产品重分发需要 OEM 授权，后者分发需要商业许可；两者还都需要 DeskLab 编写或接入帧转发程序。WinPcap 已停止维护。
4. **不要寻找能给现有 QEMU 直接加上的 `-netdev pcap` 参数。** 当前上游后端清单及构建源没有此后端。可以通过现有 TAP 或 socket 后端接外部转发进程，不必必然修改 QEMU；如果采用第三方 QEMU-pcap 补丁，则产生自维护 QEMU 分支。

## TAP 驱动准备：可直接纳入后续实现

OpenVPN tap-windows6 官方 Release 当前列出 9.27.0，发布时间是 **2024-03-19**，不是抓取页面显示的“今年 3 月”。Release 含 `dist.win10.zip`、`dist.win7.zip` 和 amd64/arm64/i386 MSM 合并模块。上游构建说明区分 Win10 attestation 签名包与旧版 cross-signed 包。应固定版本与 SHA-256、验证来源和签名，然后按系统架构选择；本轮只查询元数据，没有验证下载后二进制的签名。

来源：[官方 Releases](https://github.com/OpenVPN/tap-windows6/releases)、[Release API](https://api.github.com/repos/OpenVPN/tap-windows6/releases/latest)、[签名与打包源码说明](https://github.com/OpenVPN/tap-windows6/blob/master/README.rst)。

建议分为两层：

- **驱动包层**：管理员 helper 通过 `pnputil /add-driver <绝对路径的 INF> /install` 加入驱动仓库。该命令支持 Windows 10 1607 起；`/install` 更新匹配设备，不负责凭空创建 root-enumerated TAP 网卡。不要加 `/reboot` 自动重启，应记录需要重启的结果。
- **设备层**：固定版本 tapctl，显式执行 `tapctl create --hwid root\tap0901 --name DeskLab-<实例短 ID>`。成功后记录返回 GUID、PnP 实例 ID、名字和实例 ID 对应关系。一个运行中的 QEMU 配一张 TAP；删除只按已记录的 GUID 定点执行，绝不能调用全局删除所有 TAP 的旧脚本。

来源：[Microsoft PnPUtil 参数](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil-command-syntax)、[OpenVPN Tapctl 官方说明](https://community.openvpn.net/Pages/Tapctl)、[tapctl 主程序源码](https://github.com/OpenVPN/openvpn/blob/master/src/tapctl/main.c)。

**关键易错点**：新版 tapctl 默认硬件 ID 为 `ovpn-dco`，不是 TAP。必须显式指定 `root\tap0901` 或 `tap0901`。tapctl 不能安装驱动，只能管理已有驱动对应的接口。OpenVPN MSI 的源码把 tapctl 与驱动作为独立组件，说明可拆分处理，但具体抽取和分发构件需固定来源版本，不能从任意本机 VPN 安装目录借用。

来源：[tapctl 源码](https://github.com/OpenVPN/openvpn/blob/master/src/tapctl/main.c)、[OpenVPN MSI 构件定义](https://github.com/OpenVPN/openvpn-build/blob/master/windows-msi/msi.wxs)。

tap-windows6 的源代码和目标代码使用 GPLv2，头文件 `tap-windows.h` 另有 MIT 双许可；tapctl 源文件也标注 GPLv2。产品应带第三方声明和对应源代码交付方案，并保留原始签名 INF/CAT/SYS；不要为改产品名随意改 INF 后再期望原签名有效。是否采用某个分发组合应按其实际许可证审阅，不能把“开源”理解为免除发行义务。

来源：[TAP COPYING](https://github.com/OpenVPN/tap-windows6/blob/master/COPYING)、[tapctl 版权头](https://github.com/OpenVPN/openvpn/blob/master/src/tapctl/main.c)。

## 与当前 DeskLab/QEMU 的关系

本仓库 `server/network.ts` 目前通过 `Get-NetAdapterBinding -ComponentID ms_bridge` 判定 TAP 是否加入 Windows 原生桥；启动参数使用 `-nic tap,...,ifname=<网卡名>`。`server/lab.ts` 限制一张 TAP 同时分配给一个运行实例。

QEMU 上游 Windows TAP 后端使用 TAP 设备接口、介质状态 IOCTL，并独占打开设备。不能让第二个用户态 TAP 客户端同时打开同一 TAP 设备句柄；但 SoftEther 通过 NDIS 协议层观察网卡是另一条路径，需要 POC 验证。当前 QEMU 无需因为“自动装 TAP”而重编译。

来源：[QEMU tap-win32.c](https://github.com/qemu/qemu/blob/master/net/tap-win32.c)、[QEMU 网络后端构建清单](https://github.com/qemu/qemu/blob/master/net/meson.build)。

若引入 SoftEther，能力检测不能继续只认 `ms_bridge`，需明确 `native-windows` 和 `softether` 两个 provider，分别核验成员网卡、桥服务和运行状态。桥接未准备好时继续使用现有 NAT 是产品选择；不可把失败的桥接配置默默当作成功。

## SoftEther：避免原生网桥的优先候选，但先验证

官方 Local Bridge 将 Virtual Hub 与以太网网卡连接为二层网络；支持多个桥，并提供 `BridgeDeviceList`、`BridgeCreate`、`BridgeDelete`。文档也描述可以桥接虚拟网卡。Windows 2000 以后使用自身内核组件，不要求 WinPcap。`/TAP:yes` 的“创建 tap 设备”只支持 Linux，**Windows 的候选方案要先创建 OpenVPN TAP，再按普通以太网适配器桥接，不能照抄 Linux 命令**。

来源：[SoftEther Local Bridges](https://www.softether.org/4-docs/1-manual/3._SoftEther_VPN_Server_Manual/3.6_Local_Bridges)、[Windows 桥接实现](https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/blob/master/src/Cedar/BridgeWin32.c)。

候选流程（尚未执行）：

1. 准备固定版本 SoftEther VPN Bridge 及配套原签名组件；Bridge 的固定 Virtual Hub 可减少引入完整 VPN Server 的管理面。
2. 注册并按需启动独立桥服务。官方 `vpnbridge /install`、`/start`、`/stop` 可管理服务，但“有命令行”不能直接等同“整个安装过程绝无对话框”；需继续核实该版本服务注册和驱动安装的无交互入口。
3. 枚举 SoftEther 支持的网卡，确认 DeskLab TAP 和所选有线 NIC 都在列表中。
4. 将两者连接到同一个 Hub，不启用 SecureNAT/DHCP。按照二层机制推断，Ubuntu DHCP 广播应到达现有路由器，获得 LAN 地址；必须抓取或观测 DHCP 结果证实。
5. 验证宿主 SSH、另一台 LAN 设备 SSH、来宾到网关/DNS、并发实例、睡眠恢复及桥服务停止后恢复。宿主通信不能仅由“LAN DHCP 成功”推断。

来源：[Bridge 服务模式](https://www.softether.org/4-docs/1-manual/5._SoftEther_VPN_Bridge_Manual/5.2_Operating_Modes)、[SeLow 驱动源码](https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/blob/master/src/SeLow/SeLow.c)。

局限：官方把无线网卡列为常见的不支持混杂模式设备；因此这条路线先针对有线以太网，不承诺 VMware 式 Wi-Fi 透明桥接。安装的内核组件也需要兼容性和签名验证。稳定分支声明 Apache 2.0，但仍需核对 `THIRD_PARTY.TXT` 等组件条款。相对原生桥的代价是额外服务、驱动、升级及故障恢复责任。

来源：[桥接网卡要求与 Wi-Fi 限制](https://www.softether.org/4-docs/1-manual/3._SoftEther_VPN_Server_Manual/3.6_Local_Bridges)、[稳定分支 LICENSE](https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/blob/master/LICENSE)。

## 其他路线的明确边界

**Npcap + 外部帧转发器**：可以收发以太网帧，但它不是现成的“把 QEMU 加入 LAN”功能。可接 QEMU socket 或 TAP，再自行实现转发、过滤自身注入帧、多 MAC、广播/组播和宿主环回处理。免费版不能用于产品捆绑重分发，也没有静默安装；需要 OEM Redistribution 许可。因此它是付费依赖加开发工作，不是本轮默认路线。

来源：[Npcap OEM](https://npcap.com/oem/)、[Npcap 重分发说明](https://npcap.com/oem/redist)。

**WinPcap**：官网已明确多年未更新，没有后续开发计划；不建议为新的 Windows 10/11 桌面产品引入旧内核依赖。

来源：[WinPcap 官方停止维护公告](https://www.winpcap.org/)。

**WinpkFilter / Windows Packet Filter**：官方提供 MAC 层 Ethernet Bridge 示例，技术上更接近自定义 Windows 以太网交换机，但产品分发需要 Binary/Source Code 授权，桥接源码取得方式也有许可要求。仍需与 QEMU TAP 或 socket 接口集成，并承担网络驱动升级、冲突、生命周期管理；不是“开源免费直接打包”。

来源：[Ethernet Bridge](https://www.ntkernel.com/windows-packet-filter/ethernet-bridge/)、[Windows Packet Filter 许可](https://www.ntkernel.com/windows-packet-filter/licensing/)、[自动驱动安装说明](https://www.ntkernel.com/docs/windows-packet-filter-documentation/installation/)。

**修改 QEMU 添加 pcap 后端**：当前上游支持 socket/TAP 等后端，构建清单没有 pcap 后端。理论上不改 QEMU 也能利用 socket 数据通道连接外部桥程序；直接采用第三方 qemu-pcap 分支则需要持续迁移 QEMU 补丁。本轮未找到上游可直接启用的 Windows pcap 后端。

来源：[QEMU 网络后端文档](https://www.qemu.org/docs/master/system/qemu-manpage.html)、[上游 net/meson.build](https://github.com/qemu/qemu/blob/master/net/meson.build)。

## 后续验证优先级

先结合 Windows 原生网桥自动化 API 的专项调研选择最小依赖路线。无论用原生桥还是 SoftEther，TAP 驱动准备可以复用；在隔离 Windows 10 测试机上验证签名安装、多 TAP、桥接 DHCP、宿主与 LAN SSH 和恢复后，再把真正通过的 provider 集成到程序中。SoftEther 是可执行的候选研究方向，不是已验证可交付承诺。
