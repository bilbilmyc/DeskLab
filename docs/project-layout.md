# 项目目录约定

根目录只保留源码入口、工具配置与说明。所有 EXE 和安装包位于 `dist/` 下；构建过程不再复制 EXE 到根目录。

```text
app/                    Next.js 页面与全局样式
components/             React 界面组件
server/                 服务端领域逻辑
  generated/            编译生成的网页、引擎与托盘资源入口
shared/                 前后端共享类型和协议
native/windows/         Windows 托盘源代码
installer/              Inno Setup 源码、图标与随包说明
scripts/
  build/                网页、托盘、EXE、安装包构建
  checks/               可重复的集成和界面验证
  iso/                  镜像下载辅助工具
  dev.ts                开发服务入口
tests/                  自动测试；windows/ 为原生托盘测试
docs/                   使用、实现、验证文档
  plans/                Docker 等开发规划
.github/workflows/      GitHub Actions Windows 基础构建
dist/
  app/DeskLab.exe        独立程序
  installer/            安装包及构建清单
  web/                  静态网页输出
.runtime/
  build/                编译中间文件与 TypeScript 缓存
  tools/                QEMU、Inno Setup 等构建工具
  tests/                单元测试的临时数据
  checks/               集成测试数据和报告
  downloads/            构建依赖下载缓存
  archive/              归档的历史脚本、截图、测试数据和旧根目录产物
.next/                  Next.js 自身缓存
.data/                  开发实例的数据（不发布）
iso/                    本机已存在的镜像库（不发布）
```

`bun run build` 输出静态网页到 `dist/web/`；`bun run package` 生成 `dist/app/DeskLab.exe`；`bun run installer` 生成 `dist/installer/DeskLab-Setup.exe`。临时中间产物统一在 `.runtime/build/`；Next.js 的短暂 `out/` 导出由构建脚本收归 `dist/web/`。

已有用户数据、ISO 和虚拟磁盘没有迁移。安装版仍使用其安装目录的 `data/`，与开发工程整理无关。历史文件归档保留原名称与内容；其中脚本可能引用整理前路径，作为记录保存，新的可重复验证使用 `scripts/checks/`。

Git 只跟踪源码、锁文件、必要图标和文档。`iso/` 整体、本机验证截图、`.hallmark/`、凭据、数据库和虚拟磁盘都在忽略范围；构建生成的 `server/generated/web.ts` 也不提交，干净克隆通过 `bun run prepare` 创建占位模块。构建输出通过 Actions artifacts 或正式发行流程分发，不进入源码分支。
