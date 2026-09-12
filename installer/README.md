# Windows 安装包

先运行 `bun run package` 生成最终 `dist/app/DeskLab.exe`，再运行 `bun scripts/build/installer.ts`。产物是 `dist/installer/DeskLab-Setup.exe`；`DeskLab-Setup.build.json` 记录源 EXE、安装包和编译器的 SHA-256。

`bun scripts/build/installer.ts --prepare` 只准备构建工具。脚本下载固定版本的官方 Inno Setup 7.1.0，核对官方 GitHub release asset 的 SHA-256，再使用其 `/PORTABLE=1 /CURRENTUSER` 模式准备到 `.runtime/tools/inno-setup-7.1.0`。不修改 PATH、不注册全局编译器。

安装向导使用 Inno Setup 7 内置简体中文翻译，允许选择目录，例如 `D:\apps\DeskLab`，创建开始菜单入口及可选桌面快捷方式，并可在完成后打开程序。安装按当前用户进行，无需管理员权限；所选目录必须允许当前用户写入。

基础安装内容为 EXE、`DeskLab.ico`、`desklab.install.json`、小体积模板目录说明，以及空的 `iso` / `data` 目录。不会复制源码工作区的 `.data` 或客体 ISO/用户磁盘。若构建前已准备 `dist/engines/docker/manifest.json`，安装器还会加入独立 Docker 预装 Linux 组件；GitHub Actions 默认不包含该组件。程序通过安装标记将数据保存到安装目录旁的 `data`。

Windows 图标以 `public/icon.svg` 为品牌源。`bun scripts/build/generate-icon.ts` 可独立生成 16、20、24、32、48、64、128、256 像素的 `installer/DeskLab.ico`；普通 `bun run package` 也会自动更新它。EXE、安装程序和卸载程序使用该图标，快捷方式与卸载入口明确引用安装目录中的 ICO。版本来自 `package.json`，EXE 的产品名称、公司和说明使用 DeskLab。

打包设置 `compile.windows.hideConsole: true`。由于本机 Bun 1.3.14 的 API 与 CLI 实测仍生成 Console 子系统，`scripts/build/finalize-windows-executable.ts` 在打包后验证 MZ/PE、AMD64、边界与未签名状态，再将生成的 EXE 设为 Windows GUI 子系统，并修正 Bun 遗留图标组对小尺寸图标的引用。此步骤限制在项目生成目录内执行，必须位于代码签名之前；不修改全局 Bun 或用户安装的 EXE。启动错误由应用自己的日志与提示处理。

升级只更新程序与内置说明，不覆盖用户环境。卸载不递归清理安装目录，保留 `data`、`iso`、`templates`。这些内容可以在确认不再需要时由用户自行删除。

独立验证可指定 `DESKLAB_INSTALLER_OUTPUT` 输出到 `.runtime`，避免覆盖最终发布产物。`DESKLAB_INSTALLER_EXE` 可指定待测 EXE。用以下参数将安装包静默装入独立测试目录，且不创建快捷方式、卸载注册项或自动启动程序：

```powershell
& .\DeskLab-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /DESKLABTEST=1 /DIR="D:\workspace\bun-demo\.runtime\installer-test\DeskLab"
```

普通安装不要传 `DESKLABTEST`。此参数仅用于隔离安装/升级/卸载测试；测试使用安装目录中的 `unins000.exe`，无需修改注册表。

`bun scripts/checks/installer-smoke.ts` 自动完成以上隔离验证，在 `.runtime/installer-check-*` 生成日志。它会写入测试用配置、磁盘和 ISO 文件，执行覆盖升级与卸载，然后比对内容哈希确保文件保留。通过 `DESKLAB_INSTALLER_TEST_SETUP` 可以选择要验证的安装包。测试不会启动 DeskLab。

参考：[官方发行页](https://jrsoftware.org/isdl.php)、[官方便携模式实现](https://github.com/jrsoftware/issrc/blob/is-7_1_0/isportable.iss)、[保留目录选项](https://jrsoftware.org/ishelp/topic_dirssection.htm)、[静默安装参数](https://jrsoftware.org/ishelp/topic_setupcmdline.htm)。
