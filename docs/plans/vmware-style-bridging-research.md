# VMware 式桥接可行性调研（DeskLab 视角）

调研日期：2026-10-07。范围：仓库内既有桥接研究与暂停实现的状态梳理、上游与社区资料检索，以及一次**不修改宿主网络**的真实客体 NAT 探测（Debian 模板实机，验证 guest→10.0.2.2 数据面）。本轮未安装任何驱动、未创建网桥、未修改物理网卡。既有背景：[TAP 与二层组件调研](tap-bridge-options-research.md)、[原生网桥自动化研究](windows-bridge-native-research.md)、[自动桥接集成路线](automatic-bridge-integration.md)、[暂停时的开发状态](../network-setup.md)。

## 结论

1. **"VMware 式桥接"在有线以太网上等价可达，且仓库里已有一条走到接近终点的路线。** 目标拆开是：虚拟机以独立 MAC 直接出现在物理局域网、从局域网 DHCP 取得地址、局域网设备可直接访问。既有实现的组成是官方签名 TAP 驱动（tap-windows6 9.27.0）+ Windows 原生网桥（ms_bridge）+ Shell `createbridge` 命令自动化 + 独立提权助手与回滚，代码保留在仓库（`native/windows/NetworkSetup`、`server/network-setup`）。2022 年暂停时的差距是**验收未完成**（隔离 TAP 建桥未连续三轮通过、真实 LAN 数据流未测），不是可行性未知。本轮复核：`netsh bridge create` 在 Windows 11 / Server 2025 上依然不存在，官方建桥仍只有 GUI 入口，Shell verb 自动化仍是免自研驱动的唯一自动化路径，该判断在 2026-10 继续成立。
2. **与 VMware 的真实差距有两处，均不可关闭。**
   - **驱动形态**：VMware 的桥接是自研签名 NDIS 协议驱动 vmnetbridge（网卡属性页里的"VMware Bridge Protocol"）直接绑定物理网卡，混杂模式收发并改写以太网头，让每个 guest 以独立 MAC 出现在网段。DeskLab 自研内核桥驱动不现实（EV 代码签名、WHQL、长期安全维护都是产品级负担）；ms_bridge + TAP 在有线上能达到同样的二层效果，只是组成不同。
   - **Wi-Fi**：802.11 常规驱动不支持混杂模式，AP 只向关联站点的 MAC 投递帧；VMware 为此实现了专门的无线 MAC 翻译层。Windows 原生网桥对 Wi-Fi 的支持本来就不稳定。**结论：Wi-Fi 桥接明确不做，无线用户继续 NAT。**
3. **2026 年安全公告已核实，不阻断桥接路线（2026-10-07 复核）。** 公告为 [CVE-2026-81738](https://community.openvpn.net/openvpn/wiki/SecurityAnnouncements)：OpenVPN 2.5.0–2.7.6 on Windows 的**用户态**函数 `write_dhcp_search_str()` 临时缓冲区单字节越界，由构造的 DOMAIN-SEARCH DHCP 条目触发（`dev tap` + dhcp-options 场景），OpenVPN 2.7.7（2026-09-07）已修复，**tap-windows6 驱动本身无需新版本**。DeskLab 的桥接用法只把 QEMU 接入 TAP 设备、不运行 openvpn.exe，也不启用驱动的 DHCP 模拟 ioctl，该代码路径不存在；相关先例（[Black Hat USA 2024 OpenVPN Windows 研究](https://www.pritunl.com)、2025-12 的 CVE-2025-13086 / CVE-2025-12106）同样位于 OpenVPN 用户态而非驱动。保留的注意事项：tap-windows6 自 9.27.0（2024-03）后无新版本、OpenVPN 主线转向 L3 的 Wintun（无以太帧不能桥接），驱动长期无维护是供应链层面的持续风险；若未来出现真正的驱动层公告，需立即重估。
4. **"类 VMware 体验"存在一个成本低一个数量级的替代：局域网发布（NAT + hostfwd 绑定非回环地址）。** slirp 原生支持 `hostfwd=tcp:0.0.0.0:<port>-:<port>`；guest 虽然没有独立 LAN IP，但满足"局域网设备直接访问虚拟机里的服务"这一主要诉求。当前阻塞点全在自身代码：`server/network.ts` 的 `networkArguments()` 把绑定地址硬编码为 `127.0.0.1`，`PortMappings` 的 `hostAddress` 固定、`hasForward` 正则只认回环。需要的改动是：绑定地址参数化、每实例"允许局域网访问"开关（默认关闭，保持现有安全边界承诺）、安装期防火墙规则（安装器本就提权，可为 QEMU 程序建立受限规则）、端口占用检测改为按 0.0.0.0 探测。不做二层、不装驱动、不动宿主网络栈，风险面远小于桥接。本轮真实客体探测已证明 NAT 数据面正常（见下），LAN 侧唯一新变量是防火墙。
5. **建议路线排序**：(a) 先做"局域网发布"开关（小改动、独立价值、可先行发布）——**2026-10-07 已实现**：实例级 `lanPublish` 开关，自定义端口映射按实例改绑 `0.0.0.0`，SSH 转发保持仅本机，见 [网络与 SSH](../network-and-ssh.md)；(b) 有线桥接若重启，按既有集成路线走，先补第 3 条的安全评估，再完成暂停时未通过的验收链；(c) Wi-Fi 桥接不做；(d) SoftEther 维持备选记录，不新增投入。

## 本轮新增证据（2026-10-07，本机）

真实客体探测（Debian 13.6 Server 与 Windows 10 22H2 模板只读覆盖链 + 生产参数启动，`.runtime/checks/guest-probe-*/`）：

- 两类客体内 `curl`/`curl.exe` 访问 `10.0.2.2:<token通道>` 浏览、下载、上传全部成功（共享通道真机验证，详见 [宿主共享调研](host-share-and-driver-delivery-research.md)）。
- 两类客体内到 `10.0.2.2:445` 的 TCP 均连通（`SMB445=OPEN`）：guest→宿主 LanmanServer 的通路成立，为 SMB 挂载式共享与"宿主服务经 NAT 对客体开放"提供了通路证据。
- 副产物：该模板的 `serial-getty@ttyS0` 在系统起来后未输出登录提示（GRUB 串口菜单正常、系统正常启动）；依赖串口的自动化不能想当然，后续自动化验证应优先 tty1/QMP send-key 或 SSH 通道。

## 与当前 DeskLab 的关系

- `server/network.ts`：`networkArguments()` 硬编码回环 hostfwd、`bridged` 直接抛错；`networkCapabilities()` 返回固定 NAT 提示。`shared/network.ts` 仍保留 `BridgeAdapter` 等桥接类型（暂停遗留，重启时可复用）。
- `server/lab.ts`：`checkedNetwork()` 拒绝桥接；`reservedSshPorts()` 已把端口映射、管理端口纳入预留。局域网发布需要同步改动的三处：hostfwd 绑定地址、`PortMappings.hostAddress`/`hasForward` 正则、占用探测地址。
- 暂停时确认过清理：网络助手进程、全部测试 TAP 与测试桥已删除，物理以太网未入桥（[状态记录](../network-setup.md)）。重启不背历史状态包袱。
- 构建侧：`bun run network:build` 的驱动固定下载与签名校验管线仍在，重启时可沿用。

## VMware 机制对照（为什么"照抄"不可能）

VMware Workstation 在 Windows 宿主上的桥接由内核态 `vmnetbridge`（"VMware Bridge Protocol"）实现：作为网络协议组件绑定到物理网卡，把网卡置为混杂模式接收不属于宿主 MAC 的帧，并改写以太网头让每个虚拟机以独立 MAC 收发；VMnet0 默认桥接网卡由 Virtual Network Editor 选择。无线场景因 802.11 无混杂模式而走专门的 MAC 翻译实现，且高度依赖驱动配合——这也是大量"VMnet0 not bridged"故障帖的来源。DeskLab 采用 ms_bridge 路线时，"混杂模式 + 独立 MAC"由 Windows 网桥与 TAP 组合完成，语义等价（有线）。

来源：[VMware 虚拟网络概述](https://docs.vmware.com)、[sanbarrow VMnet 资料](https://sanbarrow.com)、社区故障案例（SuperUser / Broadcom 论坛）。

## 各路线现状一览

| 路线 | 判断 | 说明 |
| --- | --- | --- |
| Windows 原生网桥 + TAP | 可行，首选（半实现） | 差验收；前置 tap-windows6 安全评估（2026 新风险） |
| 自研 NDIS 桥驱动（VMware 式） | 不可行 | EV 签名 / WHQL / 长期维护成本，超出产品定位 |
| SoftEther Local Bridge | 备选保留 | 无新进展；引入常驻服务与第二套驱动栈 |
| Hyper-V 外部虚拟交换机 | 不适用 | QEMU 无 Hyper-V 网卡后端；且要求完整 Hyper-V 角色 |
| Npcap / WinpkFilter | 维持排除 | 产品分发许可 + 需自研帧转发（既有结论不变） |
| Wintun | 不适用 | 仅 L3 TUN，无以太帧，做不了二层桥接 |
| 局域网发布（NAT hostfwd 0.0.0.0） | 推荐，先行 | 非桥接；满足"LAN 访问虚拟机服务"主诉求，改动小 |

## 后续验证优先级

1. **局域网发布 PoC**：一台运行中的 Linux 实例开启映射到 0.0.0.0，从局域网另一设备 curl 其服务；关闭开关即不可达；确认防火墙行为与所需的规则形态。
   - 2026-10-07 单机近似证据（`scripts/checks/lan-publish-probe.ts`，真实 Lab 流程：updateNetwork 设开关 → PortMappings 存映射 → start）：宿主经自身局域网地址（本机为 198.18.0.1 虚拟网卡）连映射端口取到客体 SSH banner，证明 `0.0.0.0` 绑定与非回环转发路径成立。**跨设备实测与防火墙行为仍待真机**。
2. ~~**tap-windows6 公告核实**~~ **已完成（2026-10-07）**：CVE-2026-81738 位于 OpenVPN 用户态、2.7.7 已修复、驱动无需更新、DeskLab 用法不暴露，见结论 3。桥接路线的安全门槛通过，剩余为验收链。
3. （若决定重启）按 [自动桥接集成路线](automatic-bridge-integration.md) 的验证顺序执行：隔离 TAP 连续三轮建桥/撤销 → 独立 QEMU 二层流量 → 真实 LAN DHCP/SSH 与宿主网络恢复 → 多环境矩阵。
