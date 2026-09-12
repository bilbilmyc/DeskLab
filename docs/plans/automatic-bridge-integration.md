# Windows 全自动桥接：研究结论与集成路线

日期：2026-09-12。目标系统：本机 Windows 10 Pro 19045。状态：完成资料、源码审查和本机只读 Shell 能力验证；尚未安装驱动、执行建桥或变更物理网卡。

后续开发状态：已开始实现并安装官方签名 TAP 驱动，使用独立 TAP 实测建桥/撤销，发现成员绑定和异步恢复问题；未接入物理网卡。上面的状态是研究完成时的历史记录，当前状态见 [自动桥接开发记录](../network-setup.md)。

## 结论

优先验证并集成 **官方签名 TAP 驱动 + DeskLab 原生网络助手 + Windows Shell `createbridge` 命令**。无需复制新版本 netsh 或系统 DLL，也不以鼠标坐标点击作为正常流程。它是经过入口验证的候选，必须完成隔离网卡与真实数据流验证后才能标记为可用。

用户已授权安装所需组件并希望集成，后续工作沿用该授权；首次管理员 UAC 由 Windows 正常呈现。本轮按“先寻找全自动方案”的要求完成研究，没有修改正在使用的联网配置。

## 本机证据

1. `netsh bridge help` 没有 `create/add/list` 子命令。不能仅根据最新文档的“适用于 Windows 10”标题推断可用，后端应探测能力。[Microsoft netsh bridge](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-bridge)
2. `netcfg -q ms_bridge` 返回 installed，只表示相关网络组件存在，不能证明已有网桥。本机 INF 是 `netbrdg.inf`，没有旧工具硬编码的 `netbrdgm.inf`、`netbrdgs.inf`。
3. 原生 C# 探针枚举“网络连接”Shell 文件夹，为两个网卡对象调用 `IShellFolder.GetUIObjectOf`，再用 `IContextMenu.GetCommandString(GCS_VERBW)` 读取多选命令。结果：`label=桥接(&G)`、`verb=createbridge`、`enabled=true`、`HRESULT=0`。
4. 探针没有执行命令。以太网和 VMnet1 只是读取多选菜单的对象，没有被加入网桥；VMware、VPN、WSL 网卡未变更。

证据保存在 `.runtime/checks/bridge-research/`：`ShellBridgeProbe.cs`、编译后的同名 EXE，以及 `shell-menu.json`。

Microsoft 允许为多个对象取得 `IContextMenu`，并提供读取与界面语言无关命令标识的方法。[多对象 Shell 接口](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishellfolder-getuiobjectof)、[命令标识接口](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-icontextmenu-getcommandstring)

这些是公开的通用 Shell 接口，**`createbridge` 本身不是已找到独立官方稳定契约的桥接管理 API**。入口存在仍不能证明创建、添加成员、删除和回滚都能无人干预完成。

## 拟集成流程

用户选择“桥接”和联网的物理网卡。已有可用配置时直接启动，否则显示将创建的 TAP 与目标网卡，启动一次管理员助手。

1. **检测与记录**：按 GUID 确认目标物理网卡、状态和现有网桥；记录 IP/DHCP、DNS、接口 metric、相关路由和协议绑定。不接管第三方网桥，也不把默认路由直接当物理网卡：本机 Meta 和以太网均有默认路由。
2. **准备 TAP**：固定官方驱动包版本，校验摘要和 Authenticode 签名，用系统工具准备驱动，再用源码构建的 tapctl 创建专用网卡。必须指定 `root\tap0901`，不能使用新版 tapctl 默认的 DCO 类型；保留原驱动签名和许可证。[官方 TAP 驱动](https://github.com/OpenVPN/tap-windows6)、[tapctl](https://community.openvpn.net/Pages/Tapctl)
3. **建立桥接**：具有 netsh 创建能力的系统使用系统命令；本机 Win10 在 STA 线程中通过 Shell 多选网卡对象调用 `createbridge`。重新核对 GUID 与名称，读取 canonical verb，不依赖中文标签或硬编码菜单编号。
4. **验证后生效**：重新枚举桥及成员，检查宿主网络；QEMU 接入独立 TAP，验证 DHCP、Windows 到实例 SSH、局域网其他设备到实例 SSH。HRESULT、命令退出码不代替网络验证。
5. **失败恢复**：只撤销本次创建或加入的组件，按记录恢复设置；保存事务日志，使浏览器关闭或主服务重启后可以继续诊断。完整恢复能力通过验收前，不向普通用户开放自动桥接按钮。

正常流程只需首次 UAC 确认，不要求用户在控制面板选网卡。系统可能显示创建进度窗口；如果出现必须手工完成的额外配置页，该系统上的流程不能标记为全自动。

## 模块边界

- `native/windows/NetworkSetup/`：固定的 probe、prepare、status、rollback 操作，短生命周期的管理员助手。
- `server/network-setup/`：状态机、操作日志、受限请求和助手调度。Bun 服务保持普通用户权限。
- `shared/network.ts`：尚未准备、可配置、配置中、可用、需恢复等状态。
- `components/network-fields.tsx`：物理网卡选择、准备进度和结果，保留 NAT 默认值。
- 构建时将助手和所需资源编入 EXE；开发产物继续放 `.runtime/build/`、`dist/`。

助手验证来源、格式、路径与网卡 GUID，拒绝浏览器提交任意脚本、程序路径或下载地址。提权后的日志及回执应写受控位置，避免利用不可信输出路径覆盖文件。

## 验证顺序

1. 已完成：当前 Win10 的 Shell 命令入口只读探测。
2. 两块新建、未接物理网络的 TAP：创建桥、成员检测、幂等、移除、拆桥、提权取消及进程中断后的恢复。
3. 项目自己的隔离测试虚拟机：验证二层流量，不以用户正在运行的 Ubuntu 作为第一次实验。
4. 目标有线网卡与专属 TAP：验证真实 DHCP、双向 SSH、宿主网络、重启恢复与撤销。
5. 不同 Windows 构建、中文/英文网卡名、重命名、多 TAP、同型号设备、VPN/Hyper-V 共存。Wi-Fi 单独验收。

任何关键操作依赖不可控手工交互，或无法恢复原设置，都不能作为默认自动后端。

## 备选与排除

- SoftEther 有 Windows 二层数据通道及 CLI，可作为备用；仍需实测 TAP 兼容、驱动签名、主客体双向通信和常驻资源开销。
- 旧 bridgeutil/bindbridge 与本机驱动模型不匹配，或只操作已有绑定。原版 bridgeutil 无参数也会写系统，不能下载后直接试运行。
- ICS/NAT 不等于桥接。Npcap/WinpkFilter 还涉及产品分发许可和需要自建的数据通道。

详见 [原生路线源码审查](windows-bridge-native-research.md)与 [TAP 和二层组件路线](tap-bridge-options-research.md)。
