# 构建与 GitHub Actions

## 干净克隆

使用 Windows x64、Bun 1.3.14、Git。准备 QEMU 发行包时还需要 7-Zip；托盘使用 Windows .NET Framework 的 C# 编译器。构建首次访问 npm、QEMU 分发站及 Inno Setup GitHub Release，必须能联网。

```powershell
git clone git@github.com:bilbilmyc/DeskLab.git
cd DeskLab
git switch v1.0.0-rc1
bun install --frozen-lockfile
bun run typecheck
bun test tests
bun run qemu:prepare
bun run package -- --with-qemu
bun run installer
```

`postinstall` 仅创建缺失的生成资源占位模块，解决干净克隆缺少 `server/generated/web.ts` 的问题；不会覆盖现有打包资源。若使用了 `--ignore-scripts`，手动执行 `bun run prepare`。

`qemu:prepare` 下载固定 20260811 Windows QEMU 安装包，校验发布方 SHA512，再用 7-Zip解压到 `.runtime/tools/qemu`，不运行全局安装。也可自行准备完整发行目录，通过 `QEMU_TEST_DIR` 指定后执行 `bun run package -- --with-qemu`。保留 DLL、`share/` 固件和许可证，不能只拷贝一个 QEMU EXE。

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

[Windows build 工作流](../.github/workflows/windows-build.yml)在 `master`、`v*-rc*` 的 push/PR 和手动调度时运行，固定 Windows 2022 runner 与 Bun 1.3.14：

1. 安装锁定依赖、准备生成模块、类型检查。
2. 执行单元测试和仓库文档检查。此时未准备 QEMU、真实 ISO，依赖这些资源的测试按条件跳过。
3. 下载并校验固定 QEMU，编译 Windows EXE 与基础安装包。
4. 用临时数据目录验证成品 API、版本、内嵌网页和正常退出，不启动真实虚拟机。
5. 上传 EXE、安装器、构建清单、SHA256 和说明，保留 14 天。

工作流权限仅 `contents: read`；不签名、不自动建立 tag、不创建 GitHub Release，也不把 RC 标为 stable。Action 使用不可变提交 SHA，Bun 依赖使用冻结锁文件。

**GitHub 默认产物不含独立 Docker Linux 镜像。** 现有引擎构建依赖本机 WHPX，标准托管 runner 不作为其验收环境。普通单元测试、静态编译或基础包启动成功，不代表完整引擎和所有客体安装都已通过硬件验证。

CI 行为参考 [GitHub Actions 产物文档](https://docs.github.com/en/actions/tutorials/store-and-share-data)、[Bun setup action](https://github.com/oven-sh/setup-bun) 和 [QEMU Windows 分发说明](https://qemu.weilnetz.de/w64/)。

## 本机验收

`scripts/checks/` 包含 QEMU/WHPX、API、安装器及浏览器检查。部分浏览器脚本需要另行安装 Playwright，并通过 `PLAYWRIGHT_MODULE_PATH` 指定其模块；它们属于开发测试工具，不是成品运行依赖。历史脚本中可能保留本机路径，迁移时先核对脚本前提，不要连接真实用户数据目录运行破坏性测试。

例如在准备好 QEMU 的专用测试机执行 `bun run smoke`、`bun run test:api`；完整 OS 的 ISO 自动安装、SSH、WHPX 重启和独立 Docker 备份恢复需要另行实机验收。
