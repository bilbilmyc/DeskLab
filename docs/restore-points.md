# 虚拟机多还原点

此功能包含在本地开发构建 `1.2.0-rc1` 中，尚未发布；已发布的 v1.1.0 不包含它。

## 保存和恢复

1. 在客体系统内正常关机，等待 DeskLab 显示“已关闭”。首次安装须先完成安装，并在更多操作中弹出 ISO。
2. 打开“测试环境 → 更多操作 → 还原点”，填写名称，例如“依赖已安装”“升级测试前”，点击“创建还原点”。
3. 需要回退时，选择一个还原点，点击“恢复”，阅读覆盖提示，再点击“确认恢复”。恢复后环境保持关闭，可手动启动。
4. 不再需要的还原点可以单独删除；删除还原点不删除当前系统盘或其他还原点。删除整个环境会一起删除该环境的全部还原点。

创建、恢复和删除都要求环境关闭、没有未确认的运行进程。创建和恢复还要求自动安装已完成。处理磁盘时请保持 DeskLab 运行；其他磁盘操作会排队，重新打开页面也能看到当前处理状态。大磁盘可能需要几分钟。

## 保存内容与空间

还原点保存独立的系统磁盘副本、当时已有的 UEFI 变量，以及磁盘容量、启动方式和 SSH 授权信息。若尚未首次启动 UEFI，变量文件可能不存在，恢复后首次启动会使用固件默认变量。

CPU、内存、实例名称和端口映射保留当前设置；恢复会卸下当前 ISO。还原点不包含运行内存、外置 ISO、宿主目录或 Docker 引擎数据。网络配置与客体里恢复出的服务配置可能不同，恢复后需要自行核对。

每个还原点保存为独立 QCOW2 文件，不依赖其他还原点的磁盘链。创建时合并源磁盘及其模板依赖，空间占用随已写入的数据增加；恢复时也要为临时副本保留足够空间。界面显示保存文件的大小。原有“恢复初始状态”仍回到当前模板，多个还原点另行管理。

文件在 `data/machines/<实例 ID>/restore-points/<还原点 ID>/` 下，记录保存在 SQLite 的实例文档中。正常关闭实例并退出程序后，备份完整数据目录；仅备份 SQLite 不会备份磁盘和还原点。

## 中断与数据版本

创建和删除通过暂存目录及事务记录保护；恢复先校验 SHA-256、复制新磁盘，再替换工作磁盘并提交记录。恢复前后的 UEFI 变量使用不同文件，避免磁盘与启动信息不一致。若进程在提交前中断，下次启动回滚到旧磁盘；提交后中断则保留新磁盘并清理回滚文件。未完成恢复前禁止重新打开磁盘。该机制处理进程中断，不能代替断电保护或异地备份。

此开发版把元数据版本升级到 **schema v3**，升级前保存一致的 SQLite 备份到 `data/backups/before-restore-points-v3-*.sqlite`。旧版程序会拒绝读取升级后的数据库；不要仅替换旧 EXE 或只恢复数据库来降级，磁盘可能已变化。需要回退版本时，应使用升级前完整数据目录备份。

## 开发验证

- `bun test tests/restore-points.test.ts`：状态和确认校验、升级备份、各事务阶段中断恢复、真实 QCOW2/UEFI 往返恢复、数据库写入失败回滚、文件损坏、已提交文件被外部删除的阻断保护及删除边界。真实镜像用例在找不到 QEMU 时跳过。
- `bun test tests`、`bun run typecheck`：全量回归和类型检查。验证使用 `.runtime` 下的隔离数据，不指向安装版的数据目录。
- `bun scripts/checks/restore-points-check.ts` 与 `bun scripts/checks/restore-points-process.ts`：CI 门禁。前者要求真实 `qemu-img` 且不允许任何跳过；后者在元数据提交边界强制结束工作进程，用全新进程验证 create/restore/delete 共 6 种中断场景的恢复结果，证据保存在 `.runtime/checks/restore-process-*/result.json`。
- `bun scripts/checks/schema-upgrade.ts`：从 `v1.1.0` 标签提取上一版真实代码生成 schema v2 数据，验证升级 v3、升级前备份、未完成重置日志的恢复和旧版程序拒绝读取，证据保存在 `.runtime/checks/schema-upgrade-*/result.json`。
- 构建后运行 `python scripts/checks/restore-points-ui.py`，需要开发环境安装 Python Playwright、Microsoft Edge，并准备本地 QEMU 工具（包括 qemu-io）。脚本在隔离目录生成真实磁盘，验证四种窗口宽度下的创建、取消确认、实际块数据恢复、删除和键盘焦点，结果与截图保存在 `.runtime/checks/restore-points-ui-*`。`python scripts/checks/connection-ui.py` 验证断开重连时的界面状态，全部 API 被拦截，不启动客体系统。
- 完整客体实机验收：`bun scripts/checks/restore-points-guest.ts linux|windows PREPARED_QCOW2`。需要准备自动登录（root/Administrator）的客体磁盘、WHPX 和打包产物（`DESKLAB_TEST_EXE`，默认 `dist/app/DeskLab.exe`）。脚本执行冷启动写入标记、创建还原点、改变状态、恢复并验证标记、SSH 密钥和源镜像不变，结果保存在 `.runtime/checks/restore-guest-<kind>-*`。该验收不在 CI 运行，发布正式版前应至少对 Linux 客体完成一次。
