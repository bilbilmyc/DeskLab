# Windows 10 原生网桥自动化可行性研究

日期：2026-09-12。目标系统：当前宿主机 Windows 10 19045。本文只做资料、源码与本机 INF 只读检查，未安装驱动、未创建网桥、未修改物理网卡。

## 结论

目前没有找到可直接安装、并有足够证据证明支持 Windows 10 19045 的原生网桥 CLI。已有 `netcfg`、`INetCfg`、HNetCfg COM 不能据此认定具备完整的“创建桥 + 添加成员 + 主机 IP 迁移”接口。网上的旧 `bridgeutil` 确有 SetupAPI + INetCfg 实现，但它依赖 Windows 7 时代的 INF/硬件 ID，与本机 Windows 10 实现不匹配，而且无参数运行也会尝试更改系统。

下一步最值得验证的是 **Windows 网络连接 Shell 扩展的多选上下文命令**：由程序提供两个精确网卡 PIDL，通过系统已有菜单处理器触发桥接。它不依赖坐标或中文菜单字符串，但仍属于系统 Shell 行为自动化，不能包装成微软公开承诺兼容的 bridge API。主任务已完成只读探测：两个网卡对象的多选菜单返回 canonical verb `createbridge`，enabled=true，HRESULT=0；未调用执行方法。证据在 `.runtime/checks/bridge-research/shell-menu.json`。入口存在不等于建桥、DHCP 和回滚已验证，完整方案见 [集成路线](automatic-bridge-integration.md)。

## 1. netcfg 和 INetCfg 能做什么

[INetCfg 官方接口](https://learn.microsoft.com/en-us/previous-versions/windows/hardware/network/ff547694(v=vs.85)) 提供枚举网络组件、获取组件与绑定路径、提交网络配置等基础能力。接口定义本身没有 `CreateBridge`。可以用它编写纯读取探针；存在 `ms_bridge` 组件不等于存在可供虚拟机使用的桥网卡。

本机只读检查发现 `C:\Windows\INF\netbrdg.inf` 的 `ms_bridge` 属于 `NetService`，`Characteristics=0x40000`（`NCF_LW_FILTER`），`Ndi\Service=MsBridge`，`UpperRange=noupper`、`LowerRange=nolower`、`FilterMediaTypes=ms_implatform`。它是 NDIS 筛选组件。该目录没有旧方案所需的 `netbrdgm.inf`、`netbrdgs.inf`。因此不能把 `netcfg -q ms_bridge` 的“已安装”当作桥创建完成，也不能只把旧代码的 INF 文件名替换为 `netbrdg.inf`：组件类型与驱动模型也不同。

[当前 netsh bridge 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-bridge) 已写有 create/add/destroy，但页面 Applies-to 广泛涵盖多个版本，不能证明这些子命令在每个版本都存在。本机主任务已确认帮助输出没有 create；应以运行时能力探测决定可用后端，不能将新版系统 DLL 或 netsh 复制到 Windows 10 当作安装方案。

## 2. HNetCfg / Netman COM 不是现成的创建桥接口

[INetSharingManager](https://learn.microsoft.com/en-us/windows/win32/api/netcon/nn-netcon-inetsharingmanager) 公开接口用于连接枚举、共享配置与端口映射；[INetSharingConfiguration](https://learn.microsoft.com/en-us/windows/win32/api/netcon/nn-netcon-inetsharingconfiguration) 的 EnableSharing 是 ICS。ICS 不能满足“虚拟机从物理局域网直接获得地址”的二层桥接要求。

[INetConnection](https://learn.microsoft.com/en-us/windows/win32/api/netcon/nn-netcon-inetconnection) 公开的是连接、断开、删除、重命名、复制和获取属性等方法，没有将两个连接合成为桥的方法。本次审阅未发现 HNetCfg/Netman 的公开完整建桥接口；这里的结论是公开接口证据不足，不是声称系统内部不存在实现。

## 3. Benjamin Kalytta 的 Network Bridging Utility

原作者 [项目主页](https://sourceforge.net/projects/networkbridgingutility/) 标注 Beta、最后更新 2016-05-08，仍把 Windows 8/8.1 支持列为 TODO；[使用说明](https://sourceforge.net/p/networkbridgingutility/wiki/Home/) 有 `/install`、`/attach`、`/detach`、`/uninstall`。本次读取的是 [SVN code-0，revision 11](https://svn.code.sf.net/p/networkbridgingutility/code-0/) 的 trunk 源码，而不是二手教程或不明镜像二进制。

[BridgeHelper.h](https://svn.code.sf.net/p/networkbridgingutility/code-0/trunk/BridgeHelper.h) 的真实实现：

- 硬编码 `c:\windows\inf\netbrdgm.inf` / `ms_bridgemp` 作为桥网卡，`netbrdgs.inf` / `ms_Bridge` 作为桥驱动。
- `InstallDriver` 使用 SetupDiCreateDeviceInfo、SPDRP_HARDWAREID、单 INF 驱动列表、DIF_REGISTERDEVICE 与 DiInstallDevice 创建并安装设备。
- `BridgeToAdapter` 用 INetCfgComponentBindings 绑定桥，然后解除成员上的其他协议、服务、客户端绑定；解除桥时重新绑定所有可绑定组件，没有恢复“原先哪些被禁用”的快照。
- 静默安装相关的 SetupSetNonInteractiveMode 代码被注释掉，源码仍有非交互安装 TODO。
- 部分连续操作覆盖前一个 HRESULT，不能把最终成功输出视作每一步都成功。

**无参数运行不是只读。** [bridgeutil.cpp](https://svn.code.sf.net/p/networkbridgingutility/code-0/trunk/bridgeutil.cpp) 在解析参数前就调用 WlanHostedNetworkInitSettings、WlanHostedNetworkSetProperty（enable=true），并无条件调用 InstallDriver 安装桥驱动。之后才进入参数或帮助逻辑。不能为了看帮助、版本或适配器列表就执行原版 EXE。

许可：SourceForge 元数据列出 BSD License、Microsoft Public License，但本次读取的 trunk 没有 LICENSE 文件，所读主源码没有完整许可授予文本。集成或重分发前需取得对应发布包的准确许可与来源校验；当前证据不足以自行指定为 BSD-2-Clause 或宣称可直接捆绑。

判定：可用来理解旧实现，不宜集成到当前 Windows 10 产品。没有执行原版程序；也没有靠改文件名、添加 `netcfg -i ms_bridge` 去试探主网卡。

## 4. OurVirt bindbridge

读取 [OurGrid/OurVirt 工具目录](https://github.com/OurGrid/OurVirt/tree/master/tools/win32/bindbridge)，最近涉及该目录的提交为 `a3ef019ee4aa656ff19a383e4ec3c0c2399bb56a`。

[main.cpp](https://github.com/OurGrid/OurVirt/blob/master/tools/win32/bindbridge/main.cpp) 接收 `<bridgeId> <deviceId> <bind|unbind>`；[binding.cpp](https://github.com/OurGrid/OurVirt/blob/master/tools/win32/bindbridge/binding.cpp) 查找已有绑定路径并调用 `Enable`、`INetCfg::Apply`。它没有建桥入口。路径没有找到时部分分支仍返回 0，主程序也会打印“已绑定”，因此产品不能仅检查它的退出码。

目录 [LICENSE](https://github.com/OurGrid/OurVirt/blob/master/tools/win32/bindbridge/LICENSE) 是 Apache-2.0；部分源文件保留 Microsoft BindView 版权头，若实际复用应保留来源声明并核对原始样例许可。无参只打印 Usage 并返回 1；可从中参考自研只读 INetCfg 探针，但不能用其填补创建网桥缺口。

检索到的其他名为 NetBridge 的项目多数是 TCP 库、代理转发或 overlay VPN，未发现能解决当前原生桥创建问题的同名 CLI。名称相似不代表具备二层建桥能力。

## 5. 可继续验证的 Shell 路线

微软公开的 [IShellFolder::GetUIObjectOf](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishellfolder-getuiobjectof) 支持对多个 PIDL 取得 IContextMenu；[IContextMenu::GetCommandString](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-icontextmenu-getcommandstring) 可返回语言无关的 canonical verb。这些通用 Shell 接口有文档，但“网络连接桥接菜单命令”的内部契约和无人值守行为尚未由这些文档保证。

建议分阶段验证：

1. 只读 probe：读取 OS/build、`netsh bridge` 帮助、桥组件/网卡/驱动信息，按 GUID 取得两个网络连接 PIDL，仅枚举共同菜单、检查命令是否启用并读取 verb。禁止调用桥接命令、安装驱动或提交 INetCfg 配置。主任务正在实现这一阶段。
2. 在可还原的 Windows 10 测试机上创建两个专用 TAP，再对这两个精确对象调用菜单命令。成功标准是桥适配器、两个成员关系及双向以太帧转发都成立；不能只看 HRESULT。TAP 驱动是系统级安装，隔离 TAP 测试也不是完全零影响，宜在快照测试机上完成。
3. 验证删除、重启后恢复、创建中断、静态 IP/DNS、已有 VPN/桥，以及是否会出现必须由人处理的额外对话框。只有该阶段通过，才能给 Windows 10 标记“自动配置可用”。
4. 最后验证物理以太网加入、宿主机连通性恢复、来宾 DHCP/SSH、局域网访问。需要独立的恢复执行路径与原始网卡配置快照，不照搬旧工具“全部重新绑定”的恢复方法。

建议产品后端顺序：运行时确有能力的原生 netsh；经过测试的 Windows 10 Shell 后端；能力不足则明确显示不可自动配置。当前还不能承诺“安装一个命令即可全自动桥接”。
