import {mkdir,lstat,chmod,readFile,writeFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {run} from './qemu';
import {checkedPublicKey,type SshKeyInfo} from '../shared/ssh';

export class SshKeys {
  private pending?:Promise<SshKeyInfo>;
  private cached?:SshKeyInfo;
  constructor(private root:string) {}
  async info():Promise<SshKeyInfo|undefined> {
    if(this.cached)return this.cached;
    const path=join(this.root,'ssh','id_ed25519');
    if(!await Bun.file(path).exists()||!await Bun.file(path+'.pub').exists())return;
    const publicKey=checkedPublicKey(await readFile(path+'.pub','utf8'));
    const fingerprint='SHA256:'+createHash('sha256').update(Buffer.from(publicKey.split(' ')[1],'base64')).digest('base64').replace(/=+$/,'');
    return this.cached={publicKey,fingerprint,privateKeyPath:path};
  }
  ensure() {
    if(!this.pending)this.pending=this.generate().finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  private async generate() {
    const existing=await this.info();if(existing)return existing;
    const directory=join(this.root,'ssh');await mkdir(directory,{recursive:true,mode:0o700});
    if((await lstat(directory)).isSymbolicLink()||(await realpath(directory)).toLowerCase()!==resolve(directory).toLowerCase())throw new Error('SSH 密钥目录不能是链接');
    if(process.platform==='win32') {
      const literal="'"+directory.replaceAll("'","''")+"'";
      const script=`$ErrorActionPreference='Stop'; $path=${literal}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($path,$acl)`;
      await run(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
    }else await chmod(directory,0o700);
    const generator=Bun.which('ssh-keygen')??(process.platform==='win32'?join(process.env.SystemRoot??'C:\\Windows','System32','OpenSSH','ssh-keygen.exe'):'ssh-keygen');
    const path=join(directory,'id_ed25519');
    if(!await Bun.file(path).exists())await run(generator,['-q','-t','ed25519','-N','','-C','DeskLab-local','-f',path]);
    else if((await lstat(path)).isSymbolicLink())throw new Error('SSH 私钥不能是链接');
    if(!await Bun.file(path+'.pub').exists())await writeFile(path+'.pub',(await run(generator,['-y','-f',path]))+' DeskLab-local\n',{mode:0o644});
    if(process.platform!=='win32')await chmod(path,0o600);
    const info=await this.info();if(!info)throw new Error('生成 SSH 密钥失败，请检查 Windows OpenSSH 客户端');return info;
  }
}
