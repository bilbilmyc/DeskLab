import type {MachineNetwork} from './network';
import type {SshKeyInfo} from './ssh';
export type Family = 'windows' | 'ubuntu' | 'debian' | 'rocky' | 'linux';
export type Firmware = 'bios' | 'uefi';
export type VmState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export interface Installation {
  recipeId: string;
  phase: 'pending'|'preparing'|'installing'|'installed'|'caching'|'ready'|'failed';
  message: string; startedAt: string; shutdownConfirmed?: boolean;
}
export interface Machine {
  id: string; name: string; family: Family; memory: number; cpus: number; diskGB: number;
  templateId?: string; backingTemplateId?: string; isoPath?: string; createdAt: string; state: VmState; error?: string;
  network?:MachineNetwork; sshPublicKey?:string; sshKeyFingerprint?:string;
  sshPort?: number; sshError?: string;
  diskGeneration?: string; session?: {pid?: number; qmpPort: number; vncPort: number; eventPort?: number; sshPort?: number};
  backingResolved?: boolean; firmware?: Firmware;
  installation?: Installation;
}
export interface Template {
  id: string; name: string; family: Family; diskGB: number; createdAt: string; firmware?: Firmware;
  builtinId?: string; description?: string; memory?: number; cpus?: number; loginHint?: string; sshKeyFingerprint?:string;
}
export interface BuiltinTemplate {
  id: string; name: string; family: Family; description: string; interface: 'terminal' | 'desktop';
  memory: number; cpus: number; diskGB: number; firmware: Firmware; loginHint: string; templateId?: string; autoInstall?: boolean;
}
export interface Settings { qemuPath: string; accelerator: 'whpx' | 'tcg'; isoDirectory?: string; }
export interface IsoDownload {
  id:string; file:string; directory:string; status:'queued'|'downloading'|'verifying'|'paused'|'completed'|'error';
  received:number; total:number; speed:number; eta?:number; error?:string; verified?:boolean;
}
export interface IsoResource {
  id:string; name:string; family:Family; firmware:Firmware; file:string; bytes:number;
  url?:string; unavailableReason?:string; sourcePage?:string; hasChecksum:boolean;
  isoPath?:string; localBytes?:number; issue?:string; download?:IsoDownload;
}
export interface IsoLibrary { directory:string; scannedAt:string; error?:string; resources:IsoResource[]; }
export interface SystemImage { file: string; name: string; family: Family; isoPath: string; templateId?: string; firmware: Firmware; }
export interface Host {
  platform: string; arch: string; cpu: string; threads: number; totalMemory: number; freeMemory: number;
  qemuFound: boolean; imageToolFound: boolean; qemuVersion?: string; accelerators: string[];
  dataDirectory: string; isoDirectory?: string;databasePath?:string;
}
export interface LabSnapshot { machines: Machine[]; templates: Template[]; settings: Settings; host: Host; images?: SystemImage[]; catalogue: BuiltinTemplate[]; isoLibrary?:IsoLibrary; sshKey?:SshKeyInfo; }
export const families: {id: Family; name: string; mark: string; description: string; url: string}[] = [
  {id: 'windows', name: 'Windows', mark: 'W', description: 'Windows 10 / Server · 图形桌面', url: 'https://www.microsoft.com/software-download/windows10'},
  {id: 'ubuntu', name: 'Ubuntu', mark: 'U', description: '桌面应用与开发环境', url: 'https://ubuntu.com/download/desktop'},
  {id: 'debian', name: 'Debian', mark: 'D', description: '纯净系统与软件兼容测试', url: 'https://www.debian.org/distrib/'},
  {id: 'rocky', name: 'Rocky Linux', mark: 'R', description: '企业 Linux 与服务测试', url: 'https://rockylinux.org/download'},
  {id: 'linux', name: '其他 Linux', mark: 'L', description: '从自定义 x86_64 镜像安装', url: 'https://www.qemu.org/docs/master/system/target-i386.html'},
];
