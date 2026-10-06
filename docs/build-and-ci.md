# 构建与 GitHub Actions

## 干净克隆

使用 Windows x64、Bun 1.3.14、Git。准备 QEMU 发行包时还需要 Windows 自带的 `curl.exe` 和 7-Zip；托盘使用 Windows .NET Framework 的 C# 编译器。构建首次访问 npm、QEMU 分发站及 Inno Setup GitHub Release，必须能联网。

```powershell
git clone git@github.com:bilbilmyc/DeskLab.git
cd DeskLab
git switch master
bun install --frozen-lockfile
bun run typecheck
bun test tests
bun run qemu:prepare
bun scripts/checks/restore-points-check.ts
bun run package -- --with-qemu
bun run installer
```

`postinstall` 仅创建缺失的生成资源占位模块，解决干净克隆缺少 `server/generated/web.ts` 的问题；不会覆盖现有打包资源。若使用了 `--ignore-scripts`，手动执行 `bun run prepare`。

`qemu:prepare` 下载固定 20260811 Windows QEMU 安装包，校验发布方 SHA512，再用 7-Zip解压到 `.runtime/tools/qemu`，不运行全局安装。也可自行准备完整发行目录，通过 `QEMU_TEST_DIR` 指定后执行 `bun run package -- --with-qemu`。保留 DLL、`share/` 固件和许可证，不能只拷贝一个 QEMU EXE。

QEMU 下载有完整传输时限和最多三次尝试，先写入临时文件，校验成功后才进入缓存。CI 按固定版本与校验值缓存安装包，每次使用缓存仍会重新核对 SHA512，避免重复下载和网络卡住。

网页、图标、托盘、嵌入资源和 EXE 均由构建脚本生成。`bun run installer` 准备固定 Inno Setup 7.1.0 并生成安装器。`dist/installer/DeskLab-Setup.build.json` 记录应用版本、构建时间和两种 EXE 的哈希。

## 完整安装包与独立 Docker 组件

默认干净仓库没有 `dist/engines/docker/`，因此上述命令生成基础安装包。要制作完整构建，在支持 WHPX 的 Windows 开发机执行：

```powershell
bun run qemu:prepare
bun scripts/build/docker-engine/prepare-sources.ts
bun scripts/build/docker-engine/build-image.ts
bun run package -- --with-qemu
bun run installer
```

引擎构建会启动一个独立 Linux 构建虚拟机，下载固定 Ubuntu cloud image 并安装固定 Docker、containerd、Compose 软件包，需要 WHPX、OpenSSH 客户端和网络。会占用构建时间、CPU、内存与数 GB 临时磁盘；产物为 `dist/engines/docker/` 的镜像、工具、manifest 和 notices。资源来源固定在构建脚本中。

安装器发现有效的引擎 manifest 后加入独立 Docker 可选组件。这个镜像不会提交到 Git，也不会上传个人实例、容器数据盘、SSH 私钥或 TLS 凭据。完整镜像的复现流程与验收仍在准生产验证中。

## 云端构建做什么

[Windows build 工作流](../.github/workflows/windows-build.yml)在 `master`、`v*-rc*` 的 push/PR，以及 `v*` 标签推送时自动运行，固定 Windows 2022 runner 与 Bun 1.3.14：

1. 安装锁定依赖、准备生成模块、校验版本与标签、类型检查。
2. 执行单元测试和仓库文档检查，并运行 `schema-upgrade.ts`：用上一个发布标签 `v1.1.0` 的真实代码生成 schema v2 数据，验证升级到 v3、备份一致、未完成重置日志的恢复，以及旧版程序拒绝读取升级后的数据库。此时未准备 QEMU、真实 ISO，依赖这些资源的测试按条件跳过。
3. 下载并校验固定 QEMU，运行 `restore-points-check.ts`。脚本先确认真实 `qemu-img` 可执行，再执行还原点和恢复测试；缺少工具、失败或任何跳过都使门禁失败。随后运行 `restore-points-process.ts`：在元数据提交边界强制结束工作进程，用全新进程验证恢复后的磁盘、EFI 和还原点记录。这些步骤不需要 WHPX 或客体 ISO。
4. 编译 Windows EXE，以临时数据目录验证成品 API、版本、内嵌网页和正常退出，然后构建基础安装包。
5. 安装 Python 3.13、固定 Playwright 1.58.0 及其配套 Chromium。对最终 EXE 和安装包运行还原点浏览器验收、连接恢复界面验收（拦截全部 API，不启动客体系统）及隔离安装、覆盖升级、卸载保留验收。还原点浏览器测试使用真实 QCOW2 块数据；运行状态禁用场景使用 API fixture。
6. 单独上传验收 JSON、定向测试日志和浏览器截图，失败时也保留；只上传指定证据文件，不上传测试磁盘、数据库、凭据或完整测试目录。成功后上传 EXE、带版本名的安装器、构建清单、SHA256 和说明到 Actions，均保留 14 天。
7. 仅标签推送进入发布任务：下载本次构建产物，核对安装包版本及哈希，上传 Release 草稿，核对 GitHub 附件哈希后公开发布。

构建任务只有 `contents: read`；仅标签发布任务使用 `contents: write` 和 GitHub 自动提供的令牌，不需要保存个人 Token。Action 使用不可变提交 SHA，Bun 依赖使用冻结锁文件。分支推送不发布 Release，标签构建不会被后续推送取消；失败可在 Actions 中选择 Re-run jobs，无需创建新提交。

## RC 与正式版

- `v1.0.0-rc1`、`v1.0.0-rc2` 是候选版标签，Release 自动标记为 Pre-release，不设为 Latest。也支持 `v1.0.0-rc.2` 写法，但同一版本系列建议保持命名一致。
- `v1.0.0` 是正式版标签，Release 不带 Pre-release，并由 GitHub 按版本决定 Latest；发布旧维护版本不会强制覆盖更高版本。
- `master` 是集成分支。合并候选分支只会构建，不会自动升级版本或发布正式版；分支名与同名标签是不同的 Git 引用。
- `package.json` 是版本唯一来源；程序界面、API、安装器及附件文件名都使用它。Windows PE 数字版本不带 RC 后缀。
- 标签版本必须与 `package.json` 完全一致。已公开的版本不能被发布脚本覆盖；修复后应使用新版本、新标签。草稿上传失败则可以重跑。

例如准备下一个候选版时，先把 `package.json` 的版本改为 `1.0.0-rc2` 并更新 `CHANGELOG.md`，提交到 `master`。推送后自动构建；通过验收后再推送标签：

```powershell
git push origin master
git tag -a v1.0.0-rc2 -m "DeskLab v1.0.0-rc2"
git push origin refs/tags/v1.0.0-rc2
```

标签推送后自动构建并发布候选版安装包。准备正式版时使用同样流程，把包版本改为 `1.0.0`、标签改为 `v1.0.0`。不要移动已发布的 RC 标签，也不要只修改 Release 标题来冒充正式版本。

**GitHub 默认产物不含独立 Docker Linux 镜像。** 现有引擎构建依赖本机 WHPX，标准托管 runner 不作为其验收环境。普通单元测试、静态编译或基础包启动成功，不代表完整引擎和所有客体安装都已通过硬件验证。

CI 行为参考 [GitHub Actions 产物文档](https://docs.github.com/en/actions/tutorials/store-and-share-data)、[Bun setup action](https://github.com/oven-sh/setup-bun) 和 [QEMU Windows 分发说明](https://qemu.weilnetz.de/w64/)。

## 本机验收

`scripts/checks/` 包含 QEMU/WHPX、API、安装器及浏览器检查。部分浏览器脚本需要另行安装 Playwright，并通过 `PLAYWRIGHT_MODULE_PATH` 指定其模块；它们属于开发测试工具，不是成品运行依赖。历史脚本中可能保留本机路径，迁移时先核对脚本前提，不要连接真实用户数据目录运行破坏性测试。

例如在准备好 QEMU 的专用测试机执行 `bun run smoke`、`bun run test:api`；完整 OS 的 ISO 自动安装、SSH、WHPX 重启和独立 Docker 备份恢复需要另行实机验收。

### 最终候选包证据

必须先完成 EXE 和安装包构建，再执行以下验收；之后若重新构建，应对新产物重新验收：

```powershell
bun scripts/checks/restore-points-check.ts
bun scripts/checks/restore-points-process.ts
bun scripts/checks/schema-upgrade.ts
python -m pip install playwright==1.58.0
python -m playwright install chromium
python scripts/checks/restore-points-ui.py --browser-channel chromium
python scripts/checks/connection-ui.py --browser-channel chromium
bun scripts/checks/installer-smoke.ts
```

开发机可以使用 Python 虚拟环境；已有 Microsoft Edge 时可选择 `--browser-channel msedge`。CI 使用 Playwright 配套 Chromium，避免依赖 runner 上可能更新的 Edge。安装命令与浏览器渠道见 [Playwright CI](https://playwright.dev/python/docs/ci) 和 [浏览器文档](https://playwright.dev/python/docs/browsers)。

`scripts/checks/check-evidence.ts` 在验收开始时读取真实文件，记录程序/安装器/构建清单 SHA-256、版本、basic/full flavor、构建清单时间、验收时间、当前 Git commit 与 dirty 状态。程序和安装器必须与构建清单一致；结束时重新核对哈希，产物变化则验收失败。`sourceAtCheck` 表示验收时的工作区，不把未记录的构建来源推断为该提交，也不向历史结果补填新产物哈希。

浏览器结果位于 `.runtime/checks/restore-points-ui-*/result.json`，连接恢复结果位于 `connection-ui-*/report.json`，安装器结果位于 `.runtime/checks/installer-check-*/result.json`。安装器使用唯一的 `.runtime/checks` 子目录和 `/DESKLABTEST=1`：不创建卸载注册项、不复用真实安装目录、不生成系统快捷方式、不启动用户程序。该测试证明同一最终安装包覆盖安装及卸载的数据保留；跨版本 schema 迁移由 `schema-upgrade.ts` 验证（进程中断证据在 `restore-process-*/result.json`），完整客体启动需要另行实机验收。
