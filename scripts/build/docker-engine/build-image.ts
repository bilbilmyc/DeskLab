import {mkdir,mkdtemp,readFile,copyFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {prepareSources,sha256} from './prepare-sources';
import {SshKeys} from '../../../server/ssh-keys';
import {createConfigIso} from '../../../server/install-media';
import {executable,freePort,run,qmp} from '../../../server/qemu';
import {uefiDrives} from '../../../server/firmware';
import {qemuValue} from '../../../server/validation';

const {base}=await prepareSources();await mkdir('.runtime/build/docker-engine',{recursive:true});
const root=await mkdtemp(resolve('.runtime/build/docker-engine/build-'));
const qemu=(await executable(''))!,img=(await executable('',true))!;
const key=await new SshKeys(join(root,'client')).ensure(),hostKey=await new SshKeys(join(root,'host')).ensure();
const sshPort=await freePort(),qmpPort=await freePort(),disk=join(root,'system.qcow2');
await run(img,['create','-f','qcow2','-F','qcow2','-b',base,disk]);await run(img,['resize',disk,'12G']);
const install=`#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl qemu-guest-agent
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable' > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y --no-install-recommends docker-ce=5:29.7.2-1~ubuntu.24.04~noble docker-ce-cli=5:29.7.2-1~ubuntu.24.04~noble containerd.io=2.3.5-1~ubuntu.24.04~noble docker-compose-plugin=5.5.1-1~ubuntu.24.04~noble
systemctl stop docker docker.socket containerd
systemctl disable docker docker.socket containerd
mkdir -p /usr/share/desklab
dpkg-query -W -f='\${binary:Package}\t\${Version}\n' > /usr/share/desklab/packages.tsv
cp -a /usr/share/doc /usr/share/desklab/package-docs
apt-get clean
rm -rf /var/lib/apt/lists/*
touch /usr/share/desklab/build-ready
`;
await createConfigIso(join(root,'seed.iso'),'CIDATA',{
 'meta-data':JSON.stringify({'instance-id':'build-'+crypto.randomUUID(),'local-hostname':'desklab-builder'}),
 'user-data':'#cloud-config\n'+JSON.stringify({users:[{name:'builder',groups:['sudo'],shell:'/bin/bash',sudo:['ALL=(ALL) NOPASSWD:ALL'],ssh_authorized_keys:[key.publicKey]}],ssh_pwauth:false,disable_root:true,ssh_keys:{ed25519_private:await readFile(hostKey.privateKeyPath,'utf8'),ed25519_public:hostKey.publicKey},write_files:[{path:'/usr/local/sbin/desklab-build',permissions:'0700',content:install}],runcmd:[['bash','/usr/local/sbin/desklab-build']]})
});
await Bun.write(join(root,'known_hosts'),`[127.0.0.1]:${sshPort} ${hostKey.publicKey}\n`);
const sshArgs=['-F','NUL','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${join(root,'known_hosts')}`,'-o','ConnectTimeout=5','-i',key.privateKeyPath,'-p',String(sshPort),'builder@127.0.0.1'];
const args=['-name','DeskLab-Docker-Builder','-machine','q35','-accel','whpx','-cpu','max','-m','2048','-smp','2',...await uefiDrives(qemu,join(root,'uefi.fd')),'-drive',`file=${qemuValue(disk)},if=virtio,format=qcow2`,'-nic',`user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${sshPort}-:22`,'-drive',`file=${qemuValue(join(root,'seed.iso'))},if=virtio,format=raw,readonly=on`,'-smbios','type=1,serial=ds=nocloud','-display','none','-serial',`file:${join(root,'serial.log')}`,'-qmp',`tcp:127.0.0.1:${qmpPort},server=on,wait=off`];
const child=spawn(qemu,args,{cwd:dirname(qemu),windowsHide:true,stdio:['ignore','pipe','pipe']});child.stderr.on('data',d=>process.stderr.write(d));
await Bun.write(join(root,'build.json'),JSON.stringify({pid:child.pid,sshPort,qmpPort,root,key:key.privateKeyPath}));console.log('Builder '+JSON.stringify({root,pid:child.pid,sshPort}));
try {
 let ready=false;
 for(let i=0;i<240;i++){
  if(child.exitCode!==null)throw new Error('Builder QEMU exited: '+child.exitCode);
  try {ready=(await run('ssh.exe',[...sshArgs,'test -f /usr/share/desklab/build-ready && echo ready'],10000)).trim()==='ready';}catch{}
  if(ready)break;if(i%6===0)console.log('Waiting for Linux/Docker provisioning');await Bun.sleep(5000);
 }
 if(!ready)throw new Error('Builder provisioning did not finish; see serial.log');
 const manifest=await run('ssh.exe',[...sshArgs,'cat /usr/share/desklab/packages.tsv']);
 const output=resolve('dist/engines/docker');await mkdir(output,{recursive:true});await Bun.write(join(output,'packages.tsv'),manifest+'\n');
 const seal=`sudo sh -c 'systemctl stop docker docker.socket containerd; rm -rf /var/lib/docker /var/lib/containerd /var/lib/cloud; rm -f /etc/ssh/ssh_host_* /etc/machine-id /var/lib/dbus/machine-id /usr/local/sbin/desklab-build; rm -rf /home/builder /root/.ssh; userdel builder; cloud-init clean --logs --machine-id; sync; shutdown -h now'`;
 await run('ssh.exe',[...sshArgs,seal],15000).catch(()=>{});
 for(let i=0;i<120&&child.exitCode===null;i++)await Bun.sleep(500);if(child.exitCode===null)throw new Error('Builder did not shut down cleanly');
 await run(img,['convert','-O','qcow2','-c',disk,join(output,'system.qcow2')],600000);
 const files=['system.qcow2','tools/docker.exe','tools/cli-plugins/docker-compose.exe'];const hashes:Record<string,string>={};for(const name of files)hashes[name]=await sha256(join(output,name));
 await Bun.write(join(output,'manifest.json'),JSON.stringify({version:1,id:'ubuntu24-docker29.7.2-v1',os:'Ubuntu Minimal 24.04',architecture:'amd64',docker:'29.7.2',compose:'5.5.1',builtAt:new Date().toISOString(),baseUrl:'https://cloud-images.ubuntu.com/minimal/releases/noble/release-20260905/ubuntu-24.04-minimal-cloudimg-amd64.img',baseSha256:'46b0dbaffa6950a7da5ff2dc5ed34c46084610b3b6d1fae8f1ec2d7e953984a3',files:hashes},null,2));
 console.log('Engine image built: '+output);
}finally{if(child.exitCode===null)await qmp(qmpPort,'system_powerdown').catch(()=>{});}
