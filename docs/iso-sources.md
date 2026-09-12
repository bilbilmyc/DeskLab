# 内置 ISO 下载源核验

核验时间：2026-09-12 09:43（Asia/Shanghai）。下载清单位于 `server/iso-sources.ts`，随 Bun 编译进入程序，不需要先有 `iso/manifest.json`。清单对应现有 8 套系统，版本、文件名、字节数和已知 SHA256 均与原 `iso/manifest.json` 一致。

这些下载文件是原版安装 ISO。下载完成不等于得到已安装好、已设置账号的模板磁盘；已准备好的模板可以直接创建环境，只有 ISO 时需要进入安装流程。

## 实际检查范围

本次对最终清单的每个 URL 发起 HTTPS `HEAD` 和 `Range: bytes=0-0` 请求，收到全部 8 项 `200` / `206` 响应；`Content-Length`、`Content-Range` 中的总长度与清单及本地文件大小一致。收到响应后立即取消响应体，没有重复下载整张 ISO。这确认了核验时的可访问性、文件长度和范围请求支持，不代表此轮重新校验过整张远程 ISO。

7 个非空 SHA256 从发布方 HTTPS 校验文件重新核对；Ubuntu Desktop 使用仍提供该版本的官方域名镜像校验清单，并与此前保存的官方校验文件一致。Windows Server 保留 `sha256: null`，原因见下文。本次没有验证 GPG 签名，不应把核验描述为签名验证。

完整 HTTP 记录在本机 `.runtime/iso-source-verification/final-sources.json`；原地址与备用地址探测分别在 `probe.json`、`alternates.json`。校验来源的本次副本也在该目录。此前已下载文件的实际 SHA256 记录在 `iso/SHA256SUMS.local`，此前保存的发布方校验文件在 `iso/checksums/`。

## 固定版本来源

### Ubuntu 24.04.5 Server

- 文件：`ubuntu-24.04.5-live-server-amd64.iso`，4,080,486,400 字节。
- [下载地址（上海交大镜像）](https://ftp.sjtu.edu.cn/ubuntu-cd/24.04.5/ubuntu-24.04.5-live-server-amd64.iso)，采用固定 `24.04.5` 目录。
- SHA256：`97f3d7ffb032c3eb3b23d2c8be9cc76e60c2c1f2c0146ba5ba9fe01cafae0fd8`，与 [Ubuntu 官方 SHA256SUMS](https://releases.ubuntu.com/24.04.5/SHA256SUMS) 相符。
- 最终探测：HEAD 200；Range 206，`bytes 0-0/4080486400`。

### Debian 13.6 Server

- 文件：`debian-13.6.0-amd64-DVD-1.iso`，3,992,977,408 字节。这是 DVD 安装盘，安装时选择无桌面的服务器配置。
- [下载地址（Debian 官方）](https://cdimage.debian.org/debian-cd/13.6.0/amd64/iso-dvd/debian-13.6.0-amd64-DVD-1.iso)，使用固定 `13.6.0` 目录，替代原 `current` 目录。
- SHA256：`e97736b7f49af22497c8df95e381ea5025faf3575af4b7ca6d5f40971265364e`，与 [该版本官方 SHA256SUMS](https://cdimage.debian.org/debian-cd/13.6.0/amd64/iso-dvd/SHA256SUMS) 相符。
- 最终探测：HEAD 200；Range 206，`bytes 0-0/3992977408`。官方入口在本次请求中转至 `gemmei.ftp.acc.umu.se`。

### Rocky Linux 9.8 Server

- 文件：`Rocky-9.8-x86_64-minimal.iso`，2,755,067,904 字节。
- [下载地址（Rocky 官方）](https://download.rockylinux.org/pub/rocky/9.8/isos/x86_64/Rocky-9.8-x86_64-minimal.iso)，使用固定 `9.8` 目录。
- SHA256：`d338032cd1cdd41c67139f2f71b4c832c8e4a21943106519db9c7137df7a63d4`，与 [官方 CHECKSUM](https://download.rockylinux.org/pub/rocky/9.8/isos/x86_64/CHECKSUM) 相符。
- 官方 CHECKSUM 的 Minimal 字节数注释为 `1480048640`，与 HTTP 总长度和现有文件大小不符。清单保留实际字节数 `2755067904`，使用对应的 SHA256 值，不使用该注释作为下载总大小。
- 最终探测：HEAD 200；Range 206，`bytes 0-0/2755067904`。

### Windows 10 Enterprise 22H2

- 文件：`Windows_10_Enterprise_22H2_Evaluation_en-us_x64.iso`，5,550,497,792 字节，英文 x64 评估版。
- [下载地址（微软 CDN）](https://software-static.download.prss.microsoft.com/dbazure/988969d5-f34g-4e03-ac9d-1f9786c66750/19045.2006.220908-0225.22h2_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso)。固定构建为 `19045.2006.220908-0225`。
- SHA256：`ef7312733a9f5d7d51cfa04ac497671995674ca5e1058d5164d6028f0938d668`，对应 [微软校验 PDF](https://download.microsoft.com/download/c/1/1/c11d2ca5-967c-45c0-bc7d-2d9ca3f1fe07/Windows10Enterprise22H2HashValues.pdf) 中的 Enterprise 22H2 Eval EN-US DVD9 / x64。
- 本次下载的校验 PDF 共 108,817 字节，SHA256 为 `f3bd80fa94b823244d68b88d6c325ce9d83e7d81a08996efe9af307628e896b1`，与本地此前读取的 PDF 完全相同。原 Windows 10 Evaluation Center 页面现已跳转到 Windows 博客，因此清单来源链接直接使用仍可访问的微软校验 PDF。
- 最终探测：HEAD 200；Range 206，`bytes 0-0/5550497792`。

### Windows Server 2022

- 文件：`Windows_Server_2022_Evaluation_zh-cn_x64.iso`，5,478,957,056 字节，简体中文 x64 评估版。
- [微软 Evaluation Center](https://www.microsoft.com/en-us/evalcenter/download-windows-server-2022) 的 Chinese (Simplified) ISO 入口跳转至 [固定构建 CDN 地址](https://software-static.download.prss.microsoft.com/dbazure/988969d5-f34g-4e03-ac9d-1f9786c66756/20348.1787.230607-0640.fe_release_svc_refresh_SERVER_EVAL_x64FRE_zh-cn.iso)。清单固定到 `20348.1787.230607-0640`，避免 fwlink 将来指向不同构建。
- 未找到该文件的公开微软 SHA256，清单明确为 `null`。已有文件的本地 SHA256 可以用于比对本地副本，但不能冒充微软公布的哈希。界面不得将该项表述为“已通过官方 SHA256 校验”；HTTPS 来源和字节数检查不等价于发布方哈希校验。
- 最终探测：HEAD 200；Range 206，`bytes 0-0/5478957056`。

### Ubuntu 24.04.5 Desktop

- 文件：`ubuntu-24.04.5-desktop-amd64.iso`，6,312,734,720 字节。
- 原上海交大 `24.04` 地址及 Ubuntu 主站固定版本地址在本次检查返回 404；当前主站 `SHA256SUMS` 也没有该 Desktop 文件。无法仅凭这些响应确定原因。
- [Ubuntu 官方域名镜像 nl3 的固定版本目录](https://nl3.releases.ubuntu.com/releases/24.04.5/) 仍列出同一文件，改用其 [ISO 地址](https://nl3.releases.ubuntu.com/releases/24.04.5/ubuntu-24.04.5-desktop-amd64.iso)。没有更换系统版本。
- SHA256：`63bed7c60c252d5563742b19204ff228ef9f7f10ac0a060159897ab423b6c398`，与 [镜像 SHA256SUMS](https://nl3.releases.ubuntu.com/releases/24.04.5/SHA256SUMS)、此前保存的主站校验文件和既有清单一致。
- 最终探测：HEAD 200；Range 206，`bytes 0-0/6312734720`。如果此镜像随后下线，应报告该版本暂时无法下载，保留加载用户已有 ISO 的入口；不要静默改用其他 Ubuntu 版本或取消哈希检查。

### Debian 13.6 GNOME

- 文件：`debian-live-13.6.0-amd64-gnome.iso`，3,800,989,696 字节。
- [下载地址（Debian 官方）](https://cdimage.debian.org/debian-cd/13.6.0-live/amd64/iso-hybrid/debian-live-13.6.0-amd64-gnome.iso)，使用固定 `13.6.0-live` 目录，替代原 `current-live` 目录。
- SHA256：`1aa47465568cfc259b93ea7687a510d7f109df766daabbc69139ed99a25a71c9`，与 [该版本官方 SHA256SUMS](https://cdimage.debian.org/debian-cd/13.6.0-live/amd64/iso-hybrid/SHA256SUMS) 相符。
- 最终探测：HEAD 200；Range 206，`bytes 0-0/3800989696`。官方入口在本次请求中转至 `chuangtzu.ftp.acc.umu.se`。

### Rocky Linux 9.8 Workstation

- 文件：`Rocky-9.8-Workstation-x86_64-20260525.0.iso`，2,653,243,392 字节。
- [下载地址（Rocky 官方）](https://download.rockylinux.org/pub/rocky/9.8/live/x86_64/Rocky-9.8-Workstation-x86_64-20260525.0.iso)，使用固定 `9.8` 目录及构建名。
- SHA256：`1a6d3d5fcfa855d0ded006ea24e112fd5ea3656b74da886ea97724df5772fe87`，与 [官方 CHECKSUM](https://download.rockylinux.org/pub/rocky/9.8/live/x86_64/Rocky-9.8-Workstation-x86_64-20260525.0.iso.CHECKSUM) 相符。
- 最终探测：HEAD 200；Range 206，`bytes 0-0/2653243392`。

## 后续维护约束

- 若指定版本找不到可信的可用来源，可移除该项 `url` 并填写 `unavailableReason`；保留文件名、版本及哈希，仍可识别已有本地 ISO。
- 下载接收后应检查完整字节数；非空 `sha256` 必须匹配后才作为完成文件交给安装流程。范围请求的响应状态和范围位置也需核对，不能把服务器返回的完整文件直接追加到断点文件。
- 版本升级需要单独更新模板定义、安装兼容性验证和发布方哈希，不能只把 URL 指向 `latest`。
