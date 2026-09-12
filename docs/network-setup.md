# Windows 自动桥接开发状态

> 已按用户要求暂停桥接，产品仅保留 NAT。界面已移除桥接准备入口，`/api/network/setup` 返回 410，服务端助手调度被禁用，正常打包不再构建或内置网络助手、TAP 驱动和 tapctl。以下为保留的实验记录，不代表当前产品支持这些功能。
>
> 停用时确认：网络助手进程已退出，所有 DeskLab 测试 TAP 和测试桥均已清理，物理以太网未加入网桥。实验代码保留用于以后研究，不再自动运行。

## 已集成

- 普通权限服务检测物理网卡，排除 VPN、VMware、WSL 等虚拟接口。
- `GET /api/network/setup` 返回配置状态；受本地 token 与 Origin 校验保护的 POST 仅接受固定操作和 GUID。
- 独立 C# 助手通过 Windows UAC 提权。TAP 驱动和 tapctl 都随助手内置；不接受网页提供的脚本、下载地址或输出路径。
- 官方 TAP-Windows6 9.27.0 驱动包固定 SHA-256，并在提权后再次检查 INF/CAT/SYS 摘要和 CAT/SYS 的 Authenticode 签名。
- tapctl 由 OpenVPN 2.7.7 固定提交构建，明确使用 `root\tap0901`。许可证、完整 tapctl 对应源码及构建配置随助手打包。
- 配置日志位于 `%ProgramData%\DeskLab.NetworkSetup\<operation GUID>`，仅管理员和 SYSTEM 可写。关闭浏览器不影响助手执行。
- 网卡选择只显示可用的桥接 TAP，不显示隔离测试 TAP。状态面板提供检测、结果、恢复与刷新。

## 当前准入限制

**自动物理桥接尚未开放。** API 的 `canPrepare` 固定为 false，准备操作在服务端拒绝。不能把此版本说明为“一键桥接已完成”。

原生助手已实现 DHCP 有线网卡的快照、配置和恢复分支，但仍属于待验收代码。静态 IP、自定义 DNS/路由、Wi-Fi、已有第三方 Windows 网桥均在修改前拒绝。需要先完成隔离建桥与撤销，再验证独立 QEMU 的二层流量、真实 LAN DHCP/SSH 和宿主网络恢复，才可开放此分支。

本机实测为 Windows 10 Pro 19045。已有两次创建测试桥的记录；第一轮测试桥和 TAP 曾完成清理，后续完整复测发现 Windows 的异步撤销和成员检测问题，目前继续调试。没有将联网的物理网卡加入测试桥，用户正在运行的安装版服务和 Ubuntu 没有被替换或停止。

2026-09-12 16:30 的复核：操作 `68ca0d24-3b21-4bef-bea8-daa78a9d64fd` 成功清理了前两次残留；新测试发现 Windows 仅加入一块 TAP，随后自动撤销成功。实时枚举确认测试 TAP/桥均不存在，以太网 `ms_implat` 仍为 false。因此恢复链路已有实际成功证据，但完整建桥仍未通过。后续助手在菜单实际提供 `addtobridge` 时才补加遗漏成员，并要求一次授权中连续三轮创建/撤销都成功；尚不能以该代码已实现代替本机验证结果。

## 已确认的 Windows 行为

1. Shell 的 `createbridge`、`removefrombridge` 都能按 canonical verb 发现；不能硬编码中文标签或菜单编号。
2. Win10 的实际成员绑定是 `ms_implat`。`ms_bridge` 在网桥本身，不能用它检测 TAP 成员。
3. `InvokeCommand` 返回成功不代表网桥已删除。必须解绑成员、等待设备状态，再删除 TAP；测试中出现过“配置网桥时出现异常错误”系统弹窗。
4. PnP 移除期间 CIM 可能短暂返回“registry key ... marked for deletion”。轮询必须重试，查询失败不能当作设备已经不存在。
5. 已桥接 TAP 可能不出现在 .NET Framework 的 IP 网卡枚举里。Shell 对象选择从已验证 GUID 对应的网络连接注册表项读取名称，再要求 Shell 唯一匹配。
6. Windows PowerShell 5 的嵌入脚本必须带 UTF-8 BOM，否则中文状态可能乱码，甚至影响脚本解析。

## 构建与检查

`bun run network:build` 下载固定版本的官方驱动包，核对摘要，获取固定上游提交并构建 tapctl，然后生成带内容摘要的助手 EXE。需要 Visual Studio C++ 工具、Windows SDK、CMake、Git 和系统 .NET Framework C# 编译器。

构建目录：`.runtime/downloads/network/`、`.runtime/build/tapctl/`、`.runtime/build/native/`、`.runtime/build/network-licenses/`。分发输出仍集中在 `dist/app/` 和 `dist/installer/`。

`bun test tests/network-setup.test.ts` 包含请求边界、日志路径、物理桥接准入和真实撤销控制流的异步测试替身。旧撤销代码在同一测试替身上因提前删除 TAP 失败；新顺序通过。该测试不能替代 Windows 真网卡验收。

`bun scripts/checks/desktop-service-smoke.ts` 检查打包服务、托盘、NAT SSH 转发、网络配置 API 鉴权与界面。原生驱动操作需要单独 UAC，不能由这些无提权测试冒充完成。
