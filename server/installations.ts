import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Machine } from '../shared/types';
import { Store } from './store';
import { isoSources } from './iso-sources';
import { installationRecipe } from './install-recipes';
import { appendInitrdPreseed, createConfigIso, extractIsoFiles } from './install-media';
import { qemuValue } from './validation';

interface PreparedInstall {
  version: 1; recipeId: string; token: string; port: number; generation: string;
  size: number; mtimeMs: number; sha256: string; files: string[];
  kernel?: string; initrd?: string; append?: string; seed?: string;
}
type Report = 'installed'|'failed'|'ready';
const uuid = z.string().uuid();
const filename = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).refine(value=>!/[. ]$/.test(value));
const preparedSchema = z.object({
  version:z.literal(1),recipeId:z.string(),token:z.string().regex(/^[a-f0-9]{64}$/),port:z.number().int().min(1024).max(65535),generation:uuid,
  size:z.number().int().positive(),mtimeMs:z.number().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/),files:z.array(filename).min(1).max(16),
  kernel:z.literal('kernel').optional(),initrd:z.enum(['original-initrd','initrd']).optional(),append:z.string().max(4096).optional(),seed:z.literal('seed.iso').optional(),
}).strict();
const normalized = (path:string)=>process.platform==='win32'?path.toLowerCase():path;
const activePhases = ['preparing','installing','installed','caching'];

/** A loopback, capability-scoped guest endpoint. It never exposes the app API. */
export class Installations {
  private servers = new Map<string, ReturnType<typeof Bun.serve>>();
  constructor(private store: Store, private report: (id:string, event:Report, body:string)=>Promise<void>) {}
  private directory(id:string) { uuid.parse(id); return this.store.managed('machines',id,'install'); }
  private async checkedDirectory(path:string, create=false) {
    try {const info=await lstat(path);if(!info.isDirectory() || info.isSymbolicLink())throw new Error('自动安装目录不能使用符号链接或目录联接');}
    catch(error){if(!create || (error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await this.checkedDirectory(dirname(path));await mkdir(path);}
    if(normalized(await realpath(path))!==normalized(resolve(path)))throw new Error('自动安装目录路径已变更，已拒绝访问');
    return path;
  }
  private async resource(directory:string,name:string,maxBytes=1024*1024) {
    filename.parse(name);await this.checkedDirectory(directory);
    const path=join(directory,name),info=await lstat(path);
    if(!info.isFile() || info.isSymbolicLink() || info.nlink!==1 || info.size>maxBytes || normalized(await realpath(path))!==normalized(resolve(path)))throw new Error('自动安装文件不安全或大小超限，请新建环境重试');
    return {path,info};
  }
  private async readResource(directory:string,name:string,maxBytes=1024*1024) {
    const {path,info}=await this.resource(directory,name,maxBytes),file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try {
      const actual=await file.stat();if(!actual.isFile() || actual.nlink!==1 || actual.ino!==info.ino || actual.dev!==info.dev || actual.size!==info.size)throw new Error('自动安装文件在读取前发生变化');
      const buffer=Buffer.alloc(info.size);let offset=0;
      while(offset<buffer.length){const result=await file.read(buffer,offset,buffer.length-offset,offset);if(!result.bytesRead)throw new Error('自动安装文件被截断');offset+=result.bytesRead;}
      if((await file.stat()).size!==info.size)throw new Error('自动安装文件在读取时发生变化');
      return buffer;
    }
    finally {await file.close();}
  }
  private async manifest(vm:Machine): Promise<PreparedInstall|undefined> {
    const directory=this.directory(vm.id);
    try {await lstat(join(directory,'prepared.json'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    let data:PreparedInstall;
    try {data=preparedSchema.parse(JSON.parse((await this.readResource(directory,'prepared.json',65536)).toString('utf8')));}
    catch(error){throw new Error(`自动安装记录损坏或路径不安全，请新建环境重试：${error instanceof Error?error.message:'无效记录'}`);}
    const source=isoSources.find(item=>item.id===data.recipeId);
    if(!source || data.recipeId!==vm.installation?.recipeId || data.size!==source.bytes || (source.sha256 && data.sha256!==source.sha256))throw new Error('自动安装记录与当前系统模板不一致，请新建环境重试');
    const recipe=installationRecipe(source.id,{baseUrl:`http://10.0.2.2:${data.port}/install/${data.token}`,hostname:`desk-${vm.id.slice(0,8)}`});
    const expected=Object.keys(recipe.files).sort();
    if(JSON.stringify([...data.files].sort())!==JSON.stringify(expected) || data.kernel!==(recipe.kernelPath?'kernel':undefined)
      || data.initrd!==(recipe.initrdPath?(recipe.initrdFiles?.['preseed.cfg']?'initrd':'original-initrd'):undefined)
      || data.seed!==(recipe.seedLabel?'seed.iso':undefined) || data.append!==recipe.append)throw new Error('自动安装文件清单与内置模板不一致，请新建环境重试');
    const generation=await this.checkedDirectory(join(directory,data.generation));
    for(const name of data.files)await this.resource(generation,name);
    if(data.kernel)await this.resource(generation,data.kernel,512*1024*1024);
    if(data.initrd)await this.resource(generation,data.initrd,512*1024*1024);
    if(data.seed)await this.resource(generation,data.seed,17*1024*1024);
    return data;
  }
  private listen(vm:Machine, info:PreparedInstall) {
    if(this.servers.has(vm.id))return;
    const directory=join(this.directory(vm.id),info.generation);
    const prefix=`/install/${info.token}/`;
    const server=Bun.serve({hostname:'127.0.0.1',port:info.port,maxRequestBodySize:16384,
      fetch:async request=>{
        const url=new URL(request.url), host=request.headers.get('host');
        const current=this.store.data.machines.find(item=>item.id===vm.id);
        if(request.headers.has('origin') || (host!==`10.0.2.2:${info.port}` && host!==`127.0.0.1:${info.port}`)
          || !url.pathname.startsWith(prefix) || !current?.installation || current.installation.recipeId!==info.recipeId || !activePhases.includes(current.installation.phase))return new Response('Not found',{status:404});
        const name=url.pathname.slice(prefix.length);
        if(request.method==='GET' && info.files.includes(name)) {
          try {return new Response(await this.readResource(directory,name),{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':'application/octet-stream'}});}
          catch {return new Response('Not found',{status:404});}
        }
        if(request.method==='POST' && ['installed','failed','ready'].includes(name)) {
          try {await this.report(vm.id,name as Report,(await request.text()).slice(0,8192));return new Response('ok');}
          catch {return new Response('Report rejected',{status:409});}
        }
        return new Response('Not found',{status:404});
      }});
    info.port=server.port!;
    this.servers.set(vm.id,server);
  }
  async prepare(vm:Machine) {
    if(!vm.installation || !vm.isoPath)throw new Error('自动安装缺少 ISO');
    const existing=await this.manifest(vm), source=isoSources.find(item=>item.id===vm.installation!.recipeId);
    if(!source)throw new Error('没有可用的自动安装模板');
    const before=await lstat(vm.isoPath);
    if(!before.isFile() || before.isSymbolicLink())throw new Error('安装 ISO 必须是普通文件');
    if(existing) {
      if(existing.recipeId!==source.id || before.size!==existing.size || before.mtimeMs!==existing.mtimeMs)throw new Error('安装 ISO 已变化，请恢复原 ISO 或重新创建环境');
      this.listen(vm,existing);return existing;
    }
    if(before.size!==source.bytes)throw new Error(`此模板需要 ${source.file}，所选 ISO 大小不匹配。请使用系统镜像中的对应版本。`);
    // Validate every newly selected ISO without loading it into memory. Server's
    // unpublished hash is recorded locally, never labelled publisher-verified.
    const hasher=new Bun.CryptoHasher('sha256');
    let bytesSinceYield=0;
    for await(const chunk of Bun.file(vm.isoPath).stream()) {
      hasher.update(chunk);bytesSinceYield+=chunk.byteLength;
      // Cached disk reads can continuously resolve microtasks. Yield to QMP
      // timers and guest callbacks while other systems are booting/installing.
      if(bytesSinceYield>=16*1024*1024){bytesSinceYield=0;await Bun.sleep(0);}
    }
    const sha256=hasher.digest('hex');
    if(source.sha256 && source.sha256!==sha256)throw new Error('ISO 校验失败，请在系统镜像中重新下载对应的原版安装盘');
    const after=await lstat(vm.isoPath);
    if(!after.isFile() || after.isSymbolicLink() || before.ino!==after.ino || before.dev!==after.dev || before.size!==after.size || before.mtimeMs!==after.mtimeMs)throw new Error('ISO 在校验过程中发生变化，请重试');
    const info:PreparedInstall={version:1,recipeId:source.id,token:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),port:0,
      generation:crypto.randomUUID(),size:before.size,mtimeMs:before.mtimeMs,sha256,files:[]};
    await this.checkedDirectory(this.directory(vm.id),true);
    const directory=await this.checkedDirectory(join(this.directory(vm.id),info.generation),true);
    try {
      this.listen(vm,info);
      const recipe=installationRecipe(source.id,{baseUrl:`http://10.0.2.2:${info.port}/install/${info.token}`,hostname:`desk-${vm.id.slice(0,8)}`,sshPublicKey:vm.sshPublicKey});
      for(const [name,value] of Object.entries(recipe.files)) {
        if(!/^[-\w.]+$/.test(name))throw new Error('无效的安装文件名称');
        await Bun.write(join(directory,name),value);
      }
      info.files=Object.keys(recipe.files);
      if(recipe.seedLabel) {info.seed='seed.iso';await createConfigIso(join(directory,info.seed),recipe.seedLabel,recipe.files);}
      if(recipe.kernelPath && recipe.initrdPath) {
        await extractIsoFiles(vm.isoPath,directory,[{isoPath:recipe.kernelPath,outputName:'kernel'},{isoPath:recipe.initrdPath,outputName:'original-initrd'}]);
        info.kernel='kernel'; info.initrd='original-initrd';info.append=recipe.append;
        if(recipe.initrdFiles?.['preseed.cfg']) {
          info.initrd='initrd';await appendInitrdPreseed(join(directory,'original-initrd'),join(directory,'initrd'),recipe.initrdFiles['preseed.cfg']);
        }
      }
      const path=join(this.directory(vm.id),'prepared.json'),temporary=join(this.directory(vm.id),`prepared-${crypto.randomUUID()}.tmp`),file=await open(temporary,'wx',0o600);
      try {await file.writeFile(JSON.stringify(info));await file.sync();}finally {await file.close();}
      try {await this.checkedDirectory(this.directory(vm.id));await link(temporary,path);}finally {await unlink(temporary).catch(()=>{});}
      return info;
    } catch(error) {this.stop(vm.id);throw error;}
  }
  async args(vm:Machine) {
    const info=await this.prepare(vm), directory=join(this.directory(vm.id),info.generation), args:string[]=[];
    if(info.kernel && info.initrd)args.push('-kernel',join(directory,info.kernel),'-initrd',join(directory,info.initrd),'-append',info.append!);
    if(info.seed)args.push('-drive',`file=${qemuValue(join(directory,info.seed))},media=cdrom,index=3,readonly=on`);
    args.push('-serial',`file:${join(this.directory(vm.id),'serial.log')}`);
    return args;
  }
  async recover(vm:Machine) {if(!vm.installation || !activePhases.includes(vm.installation.phase))return;const info=await this.manifest(vm);if(info)this.listen(vm,info);}
  stop(id:string) {this.servers.get(id)?.stop(true);this.servers.delete(id);}
  shutdown() {for(const id of this.servers.keys())this.stop(id);}
}
