import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, stat, rename, realpath, readFile } from 'node:fs/promises';
import { isAbsolute, join, dirname, relative, resolve } from 'node:path';
import { cpus, freemem, totalmem } from 'node:os';
import type { Host, IsoLibrary, IsoResource, LabSnapshot, Machine, Template } from '../shared/types';
import { Store, type Journal } from './store';
import { processAlive } from './process-lock';
import { executable, run, freePort, qmp, watchQmp, type QmpEvent } from './qemu';
import { createInput, importInput, settingsInput, saveTemplateInput, updateTemplateInput, qemuValue, networkInput } from './validation';
import { uefiDrives } from './firmware';
import { systemImages } from './bundle';
import { builtinDefinition, migrateBuiltinTemplates, templateCatalogue, templateDiskExists } from './catalog';
import { isoSources } from './iso-sources';
import { IsoDownloads } from './iso-downloads';
import { Installations } from './installations';
import {allocateSshPort, ensureSshForward} from './ssh-network';
import {networkArguments} from './network';
import {storedPorts,portAvailable,managementPorts} from './ports';
import type {MachineNetwork} from '../shared/network';
import {SshKeys} from './ssh-keys';
import {validateSelectedIso} from './iso-inspection';

interface Runtime {child?: ChildProcess; pid?: number; verified: boolean; vncPort: number; qmpPort: number; eventPort?: number; closeEvents?: () => void; handlingShutdown?: boolean; watchingBoot?:boolean; log: string; exited: boolean;}
export class Lab {
  runtime = new Map<string, Runtime>();
  private queue: Promise<unknown> = Promise.resolve();
  private hostCache?: {time: number; value: Host};
  private shuttingDown = false;
  private installations: Installations;
  readonly sshKeys:SshKeys;
  private downloads = new IsoDownloads(isoSources.flatMap(source=>source.url ? [{id:source.id,file:source.file,url:source.url,bytes:source.bytes,sha256:source.sha256}] : []));
  constructor(public store: Store, private defaultIsoDirectory?: string) {
    this.sshKeys=new SshKeys(store.root);
    this.installations=new Installations(store,(id,event,body)=>this.exclusive(async()=>{
      const vm=this.get(id), install=vm.installation;
      if(!install || !this.runtime.has(id) || !['installing','installed'].includes(install.phase))throw new Error('安装任务已结束');
      if(event==='installed') {install.phase='installed';install.message='系统已配置完成，正在等待安全关机并保存基础系统。';}
      if(event==='failed') {install.phase='failed';install.message='自动安装未完成，请打开系统查看详情，或删除此环境后重新安装。';vm.error=body.slice(0,2000);}
      await this.store.save();
    }));
  }
  isoDirectory() { return this.store.data.settings.isoDirectory || this.defaultIsoDirectory || join(this.store.root,'iso'); }
  async recover() {
    await migrateBuiltinTemplates(this.store.data.templates, this.isoDirectory());
    for (const vm of this.store.data.machines) {
      let installationError:string|undefined;
      if(vm.installation && !['ready','pending','failed'].includes(vm.installation.phase)) {
        try {await this.installations.recover(vm);}
        catch(error){installationError=`无法恢复这个自动安装任务：${error instanceof Error?error.message:String(error)}`;vm.installation.phase='failed';vm.installation.message=installationError;}
      }
      if (vm.session) {
        if(!vm.session.pid) {try {const pid=Number((await readFile(this.store.managed('machines',vm.id,'qemu.pid'),'utf8')).trim());if(Number.isSafeInteger(pid)&&pid>0)vm.session.pid=pid;}catch{}}
        try {
          const identity = await qmp(vm.session.qmpPort,'query-name') as {name: string};
          if (identity.name !== `DeskLab-${vm.id}`) throw new Error('进程身份不匹配');
          const runtime: Runtime={...vm.session,verified:true,log:'',exited:false};
          this.runtime.set(vm.id,runtime); vm.state='running'; vm.error=undefined;
          await this.observe(vm.id,runtime);
          let status=await qmp(runtime.qmpPort,'query-status') as {status:string;running:boolean};
          if(status.status==='prelaunch'&&runtime.eventPort){await qmp(runtime.qmpPort,'cont');status=await qmp(runtime.qmpPort,'query-status') as typeof status;}
          if(!status.running){vm.state='error';vm.error=`虚拟机停在 ${status.status} 状态。此前的退出原因无法确认，请关闭后重新启动。磁盘仍受保护。`;}
          else {
            this.watchWindowsInstallBoot(vm,runtime);
            if(vm.family!=='windows'&&(vm.network?.mode!=='bridged'||(vm.installation&&vm.installation.phase!=='ready'))) {
              try {vm.sshPort=await ensureSshForward(runtime.qmpPort,vm.sshPort,this.reservedSshPorts(vm.id));vm.session!.sshPort=vm.sshPort;vm.sshError=undefined;}
              catch(error){vm.session!.sshPort=undefined;vm.sshError=error instanceof Error?error.message:String(error);}
            }
          }
        } catch {
          this.runtime.get(vm.id)?.closeEvents?.();this.runtime.delete(vm.id);
          if (!vm.session.pid || processAlive(vm.session.pid)) {
            this.runtime.set(vm.id,{...vm.session,verified:false,log:'',exited:false}); vm.state='error'; vm.error='无法确认上次虚拟机的退出状态，已锁定磁盘操作。请确认该环境的 QEMU 进程已退出后再恢复；不要直接删除磁盘。';
          } else {vm.state='stopped'; vm.session=undefined;}
        }
      } else vm.state='stopped';
      if(installationError)vm.error=installationError;
      // New installs have no legacy data. For an old record, inspect its actual disk before allowing template deletion.
      if (!vm.backingResolved) {
        const img = await executable(this.store.data.settings.qemuPath,true);
        if (img && !this.runtime.has(vm.id)) {
          const info = JSON.parse(await run(img,['info','--output=json',this.disk(vm.id)]));
          if (info['full-backing-filename']) vm.backingTemplateId=this.store.data.templates.find(t=>this.base(t.id).toLowerCase()===String(info['full-backing-filename']).toLowerCase())?.id;
          vm.backingResolved=!info['full-backing-filename']||!!vm.backingTemplateId;
        }
      }
    }
    await this.store.save();
    for(const vm of this.store.data.machines)if(!this.runtime.has(vm.id) && ['installed','caching'].includes(vm.installation?.phase ?? ''))await this.finishInstallation(vm.id);
  }
  async refreshRecovered() {
    for (const [id,runtime] of this.runtime) {
      if(runtime.handlingShutdown)continue;
      if(runtime.eventPort&&!runtime.closeEvents)await this.observe(id,runtime).catch(()=>{});
      try {
        const status=await qmp(runtime.qmpPort,'query-status') as {status:string;running:boolean};
        const vm=this.get(id);
        if(!status.running&&vm.state==='running'){
          vm.state='error';vm.error=`虚拟机已暂停（${status.status}）。${runtime.log || '请关闭后重新启动。'}`;await this.store.save();
        }
      } catch {}
      if (runtime.child) continue;
      try {await this.checkedRuntime(id);const status=await qmp(runtime.qmpPort,'query-status') as {running:boolean};if(this.get(id).state==='error'&&status.running){this.get(id).state='running';this.get(id).error=undefined;await this.store.save();}}
      catch {if (runtime.pid && !processAlive(runtime.pid)) {this.runtime.delete(id); const vm=this.get(id); vm.state='stopped';vm.session=undefined;await this.store.save();await this.finishInstallation(id);}}
    }
  }
  private async observe(id: string, runtime: Runtime) {
    if(!runtime.eventPort || runtime.closeEvents)return;
    runtime.closeEvents=await watchQmp(runtime.eventPort,event=>{
      if(event.event==='SHUTDOWN'&&event.data?.guest){
        void this.exclusive(()=>this.guestShutdown(id,runtime,event)).catch(async error=>{
          const vm=this.get(id);vm.state='error';vm.error=String(error);await this.store.save();
        });
      }
    },()=>{runtime.closeEvents=undefined;});
  }
  private async guestShutdown(id: string, runtime: Runtime, event: QmpEvent) {
    if(this.runtime.get(id)!==runtime||runtime.handlingShutdown||this.shuttingDown)return;
    runtime.handlingShutdown=true;
    const vm=this.get(id), restart=event.data?.reason==='guest-reset'&&vm.state!=='stopping';
    try {
    if(!runtime.pid)throw new Error('无法确认虚拟化进程 PID，已停止自动重启以保护磁盘');
    if(vm.installation?.phase==='installed' && event.data?.reason==='guest-shutdown')vm.installation.shutdownConfirmed=true;
    vm.state=restart?'starting':'stopping';await this.store.save();
    await qmp(runtime.qmpPort,'quit');
    for(let n=0;n<150&&processAlive(runtime.pid);n++)await Bun.sleep(100);
    if(processAlive(runtime.pid))throw new Error('客体已退出，但虚拟化进程尚未结束，已停止自动重启以保护磁盘');
    runtime.closeEvents?.();this.runtime.delete(id);vm.session=undefined;vm.state='stopped';await this.store.save();
    if(vm.installation?.phase==='installed')await this.finishInstallation(id);
    else if(restart&&!this.shuttingDown)await this.start(id);
    } finally { runtime.handlingShutdown=false; }
  }
  async checkedRuntime(id:string) {
    const runtime=this.runtime.get(id);if(!runtime||runtime.exited)throw new Error('环境当前未运行');
    const identity=await qmp(runtime.qmpPort,'query-name') as {name:string};
    if(identity.name!==`DeskLab-${id}`){runtime.verified=false;throw new Error('虚拟机进程身份不匹配，已拒绝控制连接');}
    runtime.verified=true;return runtime;
  }
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action); this.queue = next.catch(() => {}); return next;
  }
  get(id: string) { const vm = this.store.data.machines.find(x => x.id === id); if (!vm) throw new Error('环境不存在'); return vm; }
  disk(id: string) { return this.store.managed('machines', id, 'disk.qcow2'); }
  base(id: string) { return this.store.managed('templates', id, 'base.qcow2'); }
  async tools() {
    const qemu = await executable(this.store.data.settings.qemuPath), img = await executable(this.store.data.settings.qemuPath, true);
    if (!qemu || !img) throw new Error('未找到 QEMU。请在本机设置中配置包含 qemu-system-x86_64 和 qemu-img 的目录。');
    return {qemu, img};
  }
  async host(): Promise<Host> {
    if (this.hostCache && Date.now() - this.hostCache.time < 30000) return {...this.hostCache.value, freeMemory: freemem()};
    const qemu = await executable(this.store.data.settings.qemuPath), img = await executable(this.store.data.settings.qemuPath, true);
    let version: string | undefined, accelerators: string[] = [];
    if (qemu) {
      try { version = (await run(qemu, ['--version'], 8000)).split('\n')[0]; accelerators = (await run(qemu, ['-accel', 'help'], 8000)).split(/\s+/).filter(x => ['whpx', 'tcg', 'kvm', 'hvf'].includes(x)); } catch {}
    }
    const value: Host = {platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? '未知', threads: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), qemuFound: !!version, imageToolFound: !!img, qemuVersion: version, accelerators, dataDirectory: this.store.root,databasePath:this.store.db.path};
    this.hostCache = {time: Date.now(), value}; return value;
  }
  async images() { return systemImages(this.isoDirectory(), this.store.data.templates, this.store.root); }
  async catalogue() { return templateCatalogue(this.store.data.templates, this.store.root); }
  async isoLibrary(): Promise<IsoLibrary> {
    const directory=this.isoDirectory(), scannedAt=new Date().toISOString();
    let error:string|undefined;
    const images=await this.images().catch(()=>{error='无法读取 ISO 目录，请检查文件夹是否存在、移动硬盘是否连接，或重新选择目录。';return [];});
    try {if(!(await stat(directory)).isDirectory())throw new Error();}catch{error='ISO 目录不存在或无法访问，请在下方选择文件夹并保存。';}
    const jobs=await this.downloads.list(directory).catch(cause=>{error ??= cause instanceof Error ? cause.message : '无法读取下载进度，请检查 ISO 目录。';return [];});
    const resources:IsoResource[]=await Promise.all(isoSources.map(async source=>{
      const image=images.find(image=>image.file.toLowerCase()===source.file.toLowerCase());
      const localBytes=image?await stat(image.isoPath).then(file=>file.size).catch(()=>undefined):undefined;
      const valid=localBytes===source.bytes;
      return {id:source.id,name:source.name,family:source.family,firmware:source.firmware,file:source.file,bytes:source.bytes,url:source.url,unavailableReason:source.unavailableReason,sourcePage:source.sourcePage,hasChecksum:!!source.sha256,
        isoPath:valid?image?.isoPath:undefined,localBytes,issue:localBytes!==undefined&&!valid?'同名文件大小不完整。请移走该文件或选择其他下载目录后重试。':undefined,download:jobs.find(job=>job.id===source.id)};
    }));
    return {directory,scannedAt,error,resources};
  }
  async downloadIso(id:string) {
    if(this.shuttingDown)throw new Error('DeskLab 正在退出，请重新打开后下载。');
    const source=isoSources.find(source=>source.id===id);
    if(!source?.url)throw new Error(source?.unavailableReason || '该系统暂时没有可用下载地址。');
    return this.downloads.start(id,this.isoDirectory());
  }
  async pauseIso(id:string) { return this.downloads.pause(id,this.isoDirectory()); }
  async snapshot(): Promise<LabSnapshot> { return {...this.store.data, host: {...await this.host(), isoDirectory: this.isoDirectory()}, images: await this.images().catch(()=>[]), catalogue: await this.catalogue(), isoLibrary:await this.isoLibrary(),sshKey:await this.sshKeys.info()}; }
  async settings(input: unknown) {
    const update=settingsInput.parse(input);
    if(update.isoDirectory!==undefined) {
      if(update.isoDirectory && !isAbsolute(update.isoDirectory))throw new Error('请选择文件夹，或填写 ISO 目录的完整路径。');
      const next=update.isoDirectory ? resolve(update.isoDirectory) : this.defaultIsoDirectory || join(this.store.root,'iso');
      if(resolve(next).toLowerCase()!==resolve(this.isoDirectory()).toLowerCase() && this.downloads.hasActive())throw new Error('请先暂停正在下载或排队的镜像，再更换 ISO 目录。');
      try {await mkdir(next,{recursive:true});if(!(await stat(next)).isDirectory())throw new Error();}
      catch {throw new Error('无法使用此 ISO 目录，请选择可访问的文件夹。');}
      if(update.isoDirectory)update.isoDirectory=await realpath(next);
    }
    this.store.data.settings={...this.store.data.settings,...Object.fromEntries(Object.entries(update).filter(([,value])=>value!==undefined))};
    this.hostCache=undefined;await this.store.save();return this.host();
  }
  async source(path: string, extension: RegExp) {
    if (!isAbsolute(path) || !extension.test(path)) throw new Error('请输入本机镜像文件的绝对路径');
    const target = await realpath(path);
    if (!(await stat(target)).isFile()) throw new Error('镜像路径必须指向文件');
    return target;
  }
  async create(input: unknown) {
    const {freshInstall, recipeId, isoTypeConfirmed, ...data} = createInput.parse(input);
    await this.checkedNetwork(data.network);
    const recipe=recipeId?builtinDefinition(recipeId):undefined;
    if(recipe && (data.family!==recipe.family || data.firmware!==recipe.firmware || data.diskGB<recipe.diskGB || data.memory<recipe.memory))throw new Error('自动安装的系统类型、启动方式、内存和磁盘必须符合所选模板的要求');
    if (data.cpus > cpus().length) throw new Error('分配的 CPU 数超过本机逻辑处理器数量');
    if (data.memory * 1048576 > totalmem()) throw new Error('分配的内存超过本机总内存');
    let template = data.templateId ? this.store.data.templates.find(x => x.id === data.templateId) : undefined;
    if (data.templateId && !template) throw new Error('模板不存在');
    if (template && !await templateDiskExists(this.store.root, template)) throw new Error('模板的系统磁盘未准备好，请先在模板库中导入配套磁盘');
    const sourceIso = data.isoPath ? await this.source(data.isoPath, /\.iso$/i) : undefined;
    if (sourceIso && !freshInstall && !recipeId) {
      for (const image of await this.images()) {
        if (image.templateId && await realpath(image.isoPath) === sourceIso) {
          template = this.store.data.templates.find(x => x.id === image.templateId);
          data.templateId = template?.id;
          break;
        }
      }
    }
    const iso = template ? undefined : sourceIso;
    // Reject wrong or unconfirmed media before allocating any instance or disk.
    if(iso)await validateSelectedIso(iso,data.family,recipeId,isoTypeConfirmed);
    if(template&&data.diskGB<template.diskGB)throw new Error(`模板系统盘至少需要 ${template.diskGB} GB，只能保持或扩大容量`);
    const {img}=await this.tools();
    const id = crypto.randomUUID(), dir = this.store.managed('machines', id);
    await mkdir(dir, {recursive: true});
    try {
      if (template) await run(img, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', relative(dir, this.base(template.id)), this.disk(id), `${data.diskGB}G`]);
      else await run(img, ['create', '-f', 'qcow2', this.disk(id), `${data.diskGB}G`]);
      const vm: Machine = {id, ...data, firmware: template ? template.firmware ?? 'bios' : data.firmware, backingResolved:true, backingTemplateId: template?.id, family: template?.family ?? data.family, isoPath: iso, state: 'stopped', createdAt: new Date().toISOString()};
      if(vm.family!=='windows') {
        const key=await this.sshKeys.ensure();vm.sshPublicKey=key.publicKey;
        vm.sshKeyFingerprint=recipeId?key.fingerprint:template?.sshKeyFingerprint;
      }
      if(recipeId)vm.installation={recipeId,phase:'pending',message:'首次使用此系统，启动后将自动安装。',startedAt:new Date().toISOString()};
      this.store.data.machines.push(vm); await this.store.save(); return vm;
    } catch (e) { await rm(dir, {recursive: true, force: true}); throw e; }
  }
  private reservedSshPorts(id: string) {
    return [...this.store.data.machines.filter(vm=>vm.id!==id).flatMap(vm=>vm.sshPort?[vm.sshPort]:[]),...storedPorts(this.store).filter(p=>p.protocol==='tcp').map(p=>p.hostPort),...managementPorts(this.store)];
  }
  private async checkedNetwork(network:MachineNetwork|undefined,_id?:string) {
    if(network?.mode==='bridged')throw new Error('桥接功能已停用，请先在连接与网络中切换为 NAT');
    return undefined;
  }
  async updateNetwork(id:string,input:unknown) {
    const vm=this.get(id),network=networkInput.parse(input);
    const old=vm.network??{mode:'nat'};
    if(old.mode!==network.mode)this.requireStopped(id);
    await this.checkedNetwork(network,id);vm.network=network;await this.store.save();return vm;
  }
  async start(id: string) {
    if(this.shuttingDown)throw new Error('DeskLab 正在退出，不能启动环境');
    const vm = this.get(id);
    if (this.runtime.has(id)) throw new Error('环境已启动或正在启动');
    if(['installed','caching'].includes(vm.installation?.phase ?? '')) {
      if(!vm.installation?.shutdownConfirmed)throw new Error('安装收尾被中断，无法确认系统完整性。请保留磁盘排查，或删除此测试环境后重新安装。');
      return this.finishInstallation(id);
    }
    const {qemu} = await this.tools();
    if (vm.memory * 1048576 > freemem() * 0.9) throw new Error('当前可用内存不足，请关闭其他环境或应用后重试');
    const vncPort = await freePort();
    let qmpPort = await freePort(); while (qmpPort === vncPort) qmpPort = await freePort();
    const acceleration = this.store.data.settings.accelerator;
    const managedReboot = acceleration === 'whpx' && vm.family === 'windows';
    const managedEvents=managedReboot || (!!vm.installation && vm.installation.phase!=='ready');
    let eventPort: number | undefined;
    if(managedEvents){do {eventPort=await freePort();}while(eventPort===qmpPort||eventPort===vncPort);}
    const uefi = vm.firmware === 'uefi';
    let installArgs:string[]=[];
    const installing=!!vm.installation && vm.installation.phase!=='ready';
    if(installing) {
      vm.installation!.phase='preparing';vm.installation!.message='正在校验原版 ISO 并准备自动安装配置…';await this.store.save();
      try {installArgs=await this.installations.args(vm);}
      catch(error){vm.installation!.phase='failed';vm.installation!.message=error instanceof Error?error.message:'准备安装失败';vm.error=vm.installation!.message;await this.store.save();throw error;}
    }
    // Automatic installation uses the existing private callback channel. The
    // requested LAN bridge takes over only after installation finishes.
    const network=installing?{mode:'nat' as const}:vm.network;
    const adapter=await this.checkedNetwork(network,id);
    const mappings=storedPorts(this.store,vm.id).filter(p=>p.ownerType==='vm');
    for(const mapping of mappings)if(!await portAvailable(mapping.hostPort,mapping.protocol))throw new Error(`映射“${mapping.label}”的端口 ${mapping.hostPort} 已被占用`);
    const sshPort=vm.family==='windows'||network?.mode==='bridged'?undefined:await allocateSshPort(vm.sshPort,[...this.reservedSshPorts(vm.id),vncPort,qmpPort,...(eventPort?[eventPort]:[])]);
    vm.sshPort=sshPort;vm.sshError=undefined;
    const args = ['-name', `DeskLab-${vm.id}`, '-machine', uefi ? 'q35,pic=off' : 'pc', '-accel', acceleration, '-cpu', uefi && vm.family === 'windows' ? 'Westmere' : 'max', '-m', String(vm.memory), '-smp', String(vm.cpus),
      '-drive', `file=${qemuValue(this.disk(id))},format=qcow2,if=ide`, ...networkArguments(network,sshPort,adapter,'02:'+id.replaceAll('-','').slice(0,10).match(/../g)!.join(':'),mappings),
      '-vga', 'std', '-display', 'none', '-vnc', `127.0.0.1:${vncPort - 5900}`,
      '-qmp', `tcp:127.0.0.1:${qmpPort},server=on,wait=off`, '-pidfile',this.store.managed('machines',id,'qemu.pid'), '-usb', '-device', 'usb-tablet'];
    if (uefi) args.push(...await uefiDrives(qemu, this.store.managed('machines', id, `uefi-${vm.diskGeneration ?? 'initial'}.fd`)));
    if (vm.family === 'windows') args.push('-rtc', 'base=localtime');
    // Windows 10 WHPX cannot reliably reset its partition. After a guest-requested
    // reset, release the old process and boot the unchanged disk in a new partition.
    if(managedEvents)args.push('-action',managedReboot?'reboot=shutdown,shutdown=pause':'shutdown=pause','-S','-qmp',`tcp:127.0.0.1:${eventPort},server=on,wait=off`);
    if (vm.isoPath) { await this.source(vm.isoPath, /\.iso$/i); args.push('-cdrom', vm.isoPath, '-boot', installing&&vm.family==='windows'?'order=cd,menu=on':'order=d,menu=on'); }
    else args.push('-boot', 'order=c,menu=on');
    args.push(...installArgs);
    if(installing){vm.installation!.phase='installing';vm.installation!.message='正在自动安装系统并配置登录，完成后会自动进入系统。';}
    vm.state = 'starting'; vm.error = undefined; vm.session = {vncPort,qmpPort,eventPort,sshPort}; await this.store.save();
    if(this.shuttingDown){vm.state='stopped';vm.session=undefined;await this.store.save();throw new Error('DeskLab 正在退出，已取消启动');}
    // QEMU first probes relative keyboard-map names in its working directory.
    // C:\Windows contains an en-US directory, which otherwise shadows the
    // bundled en-us map when DeskLab is launched from an arbitrary shortcut.
    const child = spawn(qemu, args, {cwd:dirname(qemu),windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    const runtime: Runtime = {child, pid: child.pid, verified:true, vncPort, qmpPort, eventPort, log: '', exited: false};
    this.runtime.set(id, runtime);
    const append = (d: Buffer) => { runtime.log = (runtime.log + d.toString()).slice(-32000); };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    child.on('error', e => { runtime.log += e.message; });
    child.on('close', code => {
      runtime.exited = true;
      runtime.closeEvents?.();
      void this.exclusive(async () => {
        if (this.runtime.get(id) !== runtime) return;
        this.runtime.delete(id);
        const current = this.get(id); current.session=undefined;
        current.state = code === 0 ? 'stopped' : 'error';
        if (code !== 0) current.error = runtime.log || `QEMU 退出，代码 ${code}`;
        await this.store.save();
        if(code===0)await this.finishInstallation(id);
      }).catch(error=>console.error('保存环境退出状态失败：',error));
    });
    vm.session.pid=child.pid; await this.store.save();
    let lastError: unknown;
    for (let attempt = 0; attempt < 40 && !runtime.exited; attempt++) {
      try { await qmp(qmpPort, 'query-status');await this.observe(id,runtime);if(managedEvents)await qmp(qmpPort,'cont'); vm.state = 'running'; await this.store.save();
        this.watchWindowsInstallBoot(vm,runtime);
        return vm; }
      catch (e) { lastError = e; await Bun.sleep(250); }
    }
    child.kill(); vm.state = 'error';
    vm.error = runtime.log || `启动失败：${String(lastError)}。请检查 Windows Hypervisor Platform 是否启用，或在设置中选择软件模拟诊断。`;
    await this.store.save(); throw new Error(vm.error);
  }
  async power(id: string, force = false) {
    const vm = this.get(id), runtime = await this.checkedRuntime(id);
    await qmp(runtime.qmpPort, force ? 'quit' : 'system_powerdown');
    vm.state = 'stopping'; await this.store.save(); return vm;
  }
  private async windowsInstallBoot(id:string,runtime:Runtime) {
    // Empty Windows disks fall back to the DVD, whose stock bootloader asks for
    // one key. Installed disks boot first, so guest reboots do not reformat them.
    for(let n=0;n<360;n++) {
      await Bun.sleep(500);
      if(this.runtime.get(id)!==runtime || runtime.exited || this.get(id).installation?.phase!=='installing')return;
      if((await stat(this.disk(id))).size>=1048576)return;
      const log=Bun.file(this.store.managed('machines',id,'install','serial.log'));
      const tail=await log.slice(Math.max(0,log.size-8192)).text().catch(()=>'');
      // Some Microsoft bootloaders draw the prompt only on the framebuffer.
      // OVMF still reports starting the DVD over serial before that prompt.
      if(!tail.includes('Press any key to boot from CD or DVD') && !/BdsDxe: starting Boot[0-9A-F]+ "UEFI QEMU DVD-ROM /i.test(tail))continue;
      for(let key=0;key<30;key++) {
        if(this.runtime.get(id)!==runtime || runtime.exited || this.get(id).installation?.phase!=='installing')return;
        if((await stat(this.disk(id))).size>=1048576)return;
        await qmp(runtime.qmpPort,'send-key',{keys:[{type:'qcode',data:'spc'}],'hold-time':100});
        await Bun.sleep(500);
      }
      return;
    }
    throw new Error('等待 Windows 安装光盘启动超时。请关闭这个空白环境后重新启动；ISO 和磁盘已保留。');
  }
  private watchWindowsInstallBoot(vm:Machine,runtime:Runtime) {
    if(vm.family!=='windows' || vm.installation?.phase!=='installing' || runtime.watchingBoot)return;
    runtime.watchingBoot=true;
    void this.windowsInstallBoot(vm.id,runtime).catch(error=>this.exclusive(async()=>{
      if(this.runtime.get(vm.id)!==runtime || vm.installation?.phase!=='installing' || this.shuttingDown)return;
      vm.error=error instanceof Error?error.message:String(error);vm.installation.message=vm.error;
      await this.store.save();
    })).catch(error=>console.error('保存 Windows 安装提示失败：',error));
  }
  private async finishInstallation(id:string): Promise<Machine> {
    const vm=this.get(id), install=vm.installation;
    if(!install || !['installed','caching'].includes(install.phase) || this.runtime.has(id) || this.shuttingDown)return vm;
    if(!install.shutdownConfirmed) {
      install.message='安装收尾期间被中断，尚未确认正常关机。请保留此磁盘排查，或删除这个测试环境后重新安装。';
      vm.error=install.message;await this.store.save();return vm;
    }
    install.phase='caching';install.message='正在保存基础系统，以后创建同类环境无需重复安装。';await this.store.save();
    try {
      const definition=builtinDefinition(install.recipeId)!;
      const entry=(await this.catalogue()).find(item=>item.id===install.recipeId);
      const base=entry?.templateId?this.store.data.templates.find(item=>item.id===entry.templateId)!:
        await this.convertTemplate(this.disk(id),definition.name,vm.family,vm.firmware,{builtinId:definition.id,description:definition.description,memory:definition.memory,cpus:definition.cpus,loginHint:definition.loginHint,sshKeyFingerprint:vm.sshKeyFingerprint});
      vm.templateId=base.id;vm.isoPath=undefined;install.phase='ready';install.message='系统已准备好，以后可以直接启动。';vm.error=undefined;
      await this.store.save();this.installations.stop(id);
      if(!this.shuttingDown)await this.start(id);
      return vm;
    } catch(error) {install.message='保存基础系统失败，系统磁盘已保留。点击启动环境重试。';vm.error=String(error);await this.store.save();throw error;}
  }
  requireStopped(id: string) { const vm = this.get(id); if (this.runtime.has(id)) throw new Error('请先关闭环境，再执行此操作'); return vm; }
  async eject(id: string) { const vm = this.requireStopped(id); if(vm.installation && vm.installation.phase!=='ready')throw new Error('自动安装仍需要此 ISO，请等待安装完成');vm.isoPath = undefined; await this.store.save(); return vm; }
  async reset(id: string) {
    const vm = this.requireStopped(id), {img} = await this.tools();
    if (!vm.templateId) throw new Error('此环境还没有初始模板。请先完成安装并保存模板。');
    const next = this.store.managed('machines', id, 'reset.qcow2');
    const previous = this.store.managed('machines', id, 'previous.qcow2');
    const record: Journal = {type:'reset',kind:'machines',id,transaction:crypto.randomUUID()};
    await this.store.journal(record);
    try {
      await run(img, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', relative(dirname(next), this.base(vm.templateId)), next, `${vm.diskGB}G`]);
      await rename(this.disk(id), previous); await rename(next, this.disk(id));
      vm.state = 'stopped'; vm.error = undefined; vm.backingTemplateId = vm.templateId; vm.diskGeneration=record.transaction;
      await this.store.save(); await this.store.recoverFiles(); return vm;
    } catch (error) {await this.store.recoverFiles(); throw error;}
  }
  async remove(id: string) {
    this.requireStopped(id);
    await this.deleteRecord('machines',id);
  }
  async saveTemplate(id: string, input: unknown) {
    const vm = this.requireStopped(id);
    if(vm.installation && vm.installation.phase!=='ready')throw new Error('请等待自动安装完成后再保存模板');
    const data = saveTemplateInput.parse(typeof input === 'string' ? {name:input} : input);
    const sourceTemplate = this.store.data.templates.find(item => item.id === vm.templateId);
    const template = await this.convertTemplate(this.disk(id), data.name, vm.family, vm.firmware, {
      description:data.description, memory:data.memory ?? vm.memory, cpus:data.cpus ?? vm.cpus,
      sshKeyFingerprint:vm.sshKeyFingerprint,
      loginHint:data.loginHint ?? sourceTemplate?.loginHint ?? '请使用保存此模板时设置的账号登录。',
    });
    // The installed disk becomes the restore point. Detach its installer so the
    // original environment also boots into the saved system on its next launch.
    vm.templateId = template.id; vm.isoPath = undefined; await this.store.save(); return template;
  }
  async importTemplate(input: unknown) {
    const data = importInput.parse(input);
    const builtin = data.builtinId ? builtinDefinition(data.builtinId) : undefined;
    if (builtin) {
      if (data.family !== builtin.family || data.firmware !== builtin.firmware) throw new Error('配套磁盘的系统类型和启动方式必须与所选系统自带模板一致');
      if ((await this.catalogue()).find(item => item.id === builtin.id)?.templateId) throw new Error('这个系统自带模板已准备好，可直接创建环境');
    }
    const path = await this.source(data.path, /\.(qcow2|img|raw|vmdk|vhdx|vdi)$/i);
    return this.convertTemplate(path, data.name, data.family, data.firmware, {
      builtinId:data.builtinId, description:data.description ?? builtin?.description,
      memory:data.memory ?? builtin?.memory ?? 4096, cpus:data.cpus ?? builtin?.cpus ?? 2,
      loginHint:data.loginHint ?? '请使用原镜像的账号登录；导入不会修改系统账号或密码。',
    });
  }
  private async convertTemplate(source: string, name: string, family: Template['family'], firmware: Template['firmware'] = 'bios',
    details: Pick<Template, 'builtinId'|'description'|'memory'|'cpus'|'loginHint'|'sshKeyFingerprint'> = {}) {
    const {img} = await this.tools();
    const info = JSON.parse(await run(img, ['info', '--output=json', source]));
    const id = crypto.randomUUID(), dir = this.store.managed('templates', id);
    await mkdir(dir, {recursive: true});
    try {
      await run(img, ['convert', '-O', 'qcow2', source, this.base(id)], 600000);
      const template: Template = {id, name, family, firmware, ...details, diskGB: Math.ceil(info['virtual-size'] / 1073741824), createdAt: new Date().toISOString()};
      this.store.data.templates.push(template); await this.store.save(); return template;
    } catch (e) { await rm(dir, {recursive: true, force: true}); throw e; }
  }
  async updateTemplate(id: string, input: unknown) {
    const template = this.store.data.templates.find(item => item.id === id);
    if (!template) throw new Error('模板不存在');
    if (template.builtinId) throw new Error('系统自带模板不能直接修改。请创建环境，完成配置后保存为自己的模板。');
    const changes = updateTemplateInput.parse(input);
    Object.assign(template, Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)));
    await this.store.save(); return template;
  }
  async removeTemplate(id: string) {
    const template = this.store.data.templates.find(item => item.id === id);
    if (template?.builtinId) throw new Error('系统自带模板不能删除。自己的模板可以在「我的模板」中管理。');
    if(this.store.data.machines.some(x=>!x.backingResolved)) throw new Error('还有环境的磁盘依赖未确认。请关闭全部环境、配置 QEMU 后重新启动 DeskLab，再删除模板。');
    if (this.store.data.machines.some(x => x.templateId === id || x.backingTemplateId === id)) throw new Error('此模板仍被环境或差分磁盘使用，请先删除依赖环境');
    if (!template) throw new Error('模板不存在');
    await this.deleteRecord('templates',id);
  }
  private async deleteRecord(kind: 'machines'|'templates',id: string) {
    if(kind==='machines')this.installations.stop(id);
    const record: Journal={type:'delete',kind,id,transaction:crypto.randomUUID()};
    await mkdir(this.store.managed('trash'),{recursive:true}); await this.store.journal(record);
    try {
      await rename(this.store.managed(kind,id),this.store.managed('trash',record.transaction));
      if(kind==='machines') this.store.data.machines=this.store.data.machines.filter(x=>x.id!==id);
      else this.store.data.templates=this.store.data.templates.filter(x=>x.id!==id);
      await this.store.save(); await this.store.recoverFiles();
    } catch(error) {await this.store.recoverFiles();throw error;}
  }
  async shutdown() {
    this.shuttingDown=true;
    try { await this.downloads.shutdown(); }
    finally { await this.exclusive(()=>this.shutdownProcesses());this.installations.shutdown(); }
  }
  private async shutdownProcesses() {
    await Promise.all([...this.runtime.entries()].map(async ([id,runtime]) => {
      try { await this.checkedRuntime(id);await qmp(runtime.qmpPort, 'quit'); } catch { runtime.child?.kill(); }
      for(let i=0;i<50 && !runtime.exited && processAlive(runtime.pid);i++) await Bun.sleep(100);
      if (processAlive(runtime.pid) && runtime.child) {runtime.child.kill(); for(let i=0;i<50&&!runtime.exited;i++) await Bun.sleep(100);}
    }));
  }
}
