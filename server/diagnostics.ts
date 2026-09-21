import {access, open, rm, statfs} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {freemem} from 'node:os';
import type {DiagnosticCheck, DiagnosticExport, DiagnosticReport} from '../shared/diagnostics';
import type {Settings} from '../shared/types';
import {executable, freePort, run} from './qemu';
import {windowsVirtualization, type WindowsVirtualization} from './windows-diagnostics';
import {DiagnosticEvents} from './diagnostic-events';
import {version} from '../package.json';

const GiB = 1024 ** 3;
export interface DiagnosticContext {root: string; isoDirectory: string; settings: Settings; requestedPort: number; actualPort: number;}
export function virtualizationChecks(value: WindowsVirtualization, accelerator: Settings['accelerator']): DiagnosticCheck[] {
  const severity = accelerator === 'whpx' ? 'fail' : 'warning';
  return [
    {id: 'firmware', title: '固件虚拟化', status: value.firmware === null ? 'unknown' : value.firmware ? 'pass' : severity,
      detail: value.firmware === null ? '无法读取固件虚拟化状态。' : value.firmware ? '已检测到固件虚拟化或正在运行的虚拟机监控程序。' : '未检测到已启用的固件虚拟化。',
      ...(value.firmware !== true ? {remedy: '在任务管理器的“性能 → CPU”查看虚拟化；必要时进入 BIOS / UEFI 开启 Intel VT-x 或 AMD-V，再重启。'} : {})},
    {id: 'whpx', title: 'Windows 硬件加速', status: value.whpx === null ? 'unknown' : value.whpx ? 'pass' : severity,
      detail: value.whpx === null ? 'Windows Hypervisor Platform API 未能确认可用性。' : value.whpx ? 'Windows API 已确认虚拟机监控程序正在运行。' : 'Windows API 报告虚拟机监控程序未运行。',
      ...(value.whpx !== true ? {remedy: '在“启用或关闭 Windows 功能”中勾选“Windows 虚拟机监控程序平台”，按提示重启后重新检测。受限环境可先尝试 TCG 软件模拟。'} : {})},
  ];
}
export function diskSpaceCheck(id: string, title: string, bytes: number | null): DiagnosticCheck {
  const status = bytes === null ? 'unknown' : bytes < GiB ? 'fail' : bytes < 10 * GiB ? 'warning' : 'pass';
  return {id, title, status, detail: bytes === null ? '无法读取所在磁盘的可用空间。' : `所在磁盘可用 ${(bytes / GiB).toFixed(1)} GiB。`,
    ...(status !== 'pass' ? {remedy: '检查磁盘是否在线并清理空间；新系统安装、模板和下载需要额外空间。这里的 1 / 10 GiB 阈值仅作提醒。'} : {})};
}
async function storageChecks(directory: string, id: string, label: string): Promise<DiagnosticCheck[]> {
  const [space, writable] = await Promise.all([
    statfs(directory).then(s => Number(s.bavail) * Number(s.bsize)).catch(() => null),
    probeDirectoryWrite(directory),
  ]);
  return [diskSpaceCheck(`${id}-space`, `${label}空间`, space),
    {id: `${id}-access`, title: `${label}访问`, status: writable ? 'pass' : 'fail', detail: writable ? '已创建、写入并删除专用临时文件。' : '目录不存在，或临时文件写入 / 清理失败。',
      ...(!writable ? {remedy: '确认磁盘已连接、文件夹权限正确；ISO 目录可在系统镜像设置中重新选择。'} : {})}];
}
export async function probeDirectoryWrite(directory: string): Promise<boolean> {
  // W_OK does not reliably test Windows ACLs. Use one exclusively-created file,
  // never overwrite existing files, and remove only the file owned by this probe.
  const path = join(directory, `.desklab-check-${crypto.randomUUID()}.tmp`);
  let created = false, writable = false;
  try {
    const file = await open(path, 'wx'); created = true;
    try {await file.writeFile('DeskLab readiness check'); await file.sync(); writable = true;}
    finally {await file.close();}
  } catch {writable = false;}
  finally {if (created) try {await rm(path);} catch {writable = false;}}
  return writable;
}
async function engineChecks(settings: Settings): Promise<DiagnosticCheck[]> {
  const [qemu, img] = await Promise.all([executable(settings.qemuPath), executable(settings.qemuPath, true)]);
  const inspect = async (file: string | null) => file ? run(file, ['--version'], 8000).then(() => true).catch(() => false) : false;
  const [qemuOk, imgOk, accelerators, firmware] = await Promise.all([
    inspect(qemu), inspect(img), qemu ? run(qemu, ['-accel', 'help'], 8000).catch(() => '') : '',
    qemu ? Promise.all(['edk2-x86_64-code.fd', 'edk2-i386-vars.fd'].map(name => access(join(dirname(qemu), 'share', name)))).then(() => true).catch(() => false) : false,
  ]);
  const check = (id: string, title: string, ok: boolean, detail: string, remedy: string): DiagnosticCheck => ({id, title, status: ok ? 'pass' : 'fail', detail: ok ? detail : '组件缺失或无法运行。', ...(!ok ? {remedy} : {})});
  const supported = accelerators.split(/\s+/).includes(settings.accelerator);
  return [check('qemu', 'QEMU 引擎', qemuOk, '已成功执行版本查询。', '重新安装完整的 DeskLab 基础包，或在引擎配置中指定可运行的 QEMU 目录。'),
    check('image-tool', '虚拟磁盘工具', imgOk, 'qemu-img 已成功执行版本查询。', '检查 QEMU 目录中的 qemu-img 及依赖 DLL，必要时重新安装。'),
    {id: 'uefi', title: 'UEFI 固件', status: firmware ? 'pass' : 'warning', detail: firmware ? '已找到 UEFI 代码和变量模板。' : '缺少 UEFI 固件，使用 UEFI 的系统无法启动。', ...(!firmware ? {remedy: '使用包含 share/edk2-x86_64-code.fd 和 edk2-i386-vars.fd 的完整 QEMU 包。'} : {})},
    {id: 'accelerator', title: '所选运行模式', status: supported ? settings.accelerator === 'tcg' ? 'warning' : 'pass' : 'fail',
      detail: `当前选择 ${settings.accelerator.toUpperCase()}。${!supported ? '未能确认 QEMU 支持此模式。' : settings.accelerator === 'tcg' ? '软件模拟速度较慢。' : 'QEMU 支持列表不等于实际虚拟机启动成功。'}`,
      remedy: '确认 QEMU 支持所选模式；实际客体的兼容性仍需启动验证。'}];
}
export async function collectDiagnostics(context: DiagnosticContext): Promise<DiagnosticReport> {
  const [windows, engine, data, iso, port] = await Promise.all([
    windowsVirtualization(), engineChecks(context.settings), storageChecks(context.root, 'data', '数据目录'),
    storageChecks(context.isoDirectory, 'iso', 'ISO 目录'), freePort().then(() => true).catch(() => false),
  ]);
  const memory = freemem();
  const checks: DiagnosticCheck[] = [
    {id: 'platform', title: '宿主系统', status: process.platform === 'win32' && process.arch === 'x64' ? 'pass' : 'warning', detail: process.platform === 'win32' && process.arch === 'x64' ? 'Windows x64。' : '当前宿主不在 Windows x64 正式支持范围内。'},
    ...virtualizationChecks(windows, context.settings.accelerator), ...engine, ...data, ...iso,
    {id: 'memory', title: '可用内存', status: memory < 2 * GiB ? 'warning' : 'pass', detail: `当前可用 ${(memory / GiB).toFixed(1)} GiB。`, remedy: '创建时按客体要求分配内存，并为 Windows 宿主保留余量。'},
    {id: 'service-port', title: '管理页面端口', status: context.requestedPort && context.requestedPort !== context.actualPort ? 'warning' : 'pass',
      detail: context.requestedPort && context.requestedPort !== context.actualPort ? '首选端口被占用或无权绑定，服务已自动使用其他端口。' : '管理服务已成功监听本机端口。', remedy: '通过 DeskLab 快捷方式打开当前地址；不必停止其他应用。'},
    {id: 'loopback-port', title: '本机端口分配', status: port ? 'pass' : 'fail', detail: port ? '临时 TCP 回环端口可分配，检查后已释放。' : '无法分配本机 TCP 回环端口。', remedy: '检查本机安全软件或端口限制；具体 SSH / TCP / UDP 映射仍在创建及启动时检查。'},
  ];
  const summary = {pass: 0, warning: 0, fail: 0, unknown: 0};
  for (const check of checks) summary[check.status]++;
  return {schemaVersion: 1, checkedAt: new Date().toISOString(), checks, summary};
}
export class Diagnostics {
  readonly events = new DiagnosticEvents();
  private cached?: {key: string; report: DiagnosticReport};
  private pending?: Promise<DiagnosticReport>;
  constructor(private context: () => DiagnosticContext, private collect = collectDiagnostics) {}
  async check(refresh = false): Promise<DiagnosticReport> {
    // Serialize and coalesce probes without taking the VM operation lock.
    if (this.pending) { await this.pending; return this.check(false); }
    const context = this.context(), key = JSON.stringify(context);
    if (this.cached?.key === key && Date.now() - Date.parse(this.cached.report.checkedAt) < (refresh ? 5000 : 60000)) return this.cached.report;
    this.pending = this.collect(context);
    try { const report = await this.pending; this.cached = {key, report}; return report; }
    finally { this.pending = undefined; }
  }
  async export(): Promise<DiagnosticExport> {
    return {schemaVersion: 1, appVersion: version, exportedAt: new Date().toISOString(), report: await this.check(true), events: this.events.snapshot(),
      scope: '仅包含体检结果和本次服务运行期间最近 100 条受支持操作的状态/错误类别；accepted 表示已受理，不代表后台任务完成。不包含原始日志、路径、实例名称、标识符、请求参数、环境变量、凭据或客体输出。'};
  }
}
