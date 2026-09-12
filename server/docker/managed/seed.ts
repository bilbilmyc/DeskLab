import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createConfigIso} from '../../install-media';
import type {Credentials} from './credentials';

export async function createEngineSeed(path:string,engineId:string,dataId:string,credentials:Credentials,allowFormat:boolean){
 if(!/^[a-f0-9-]{36}$/.test(engineId)||!/^[a-f0-9-]{36}$/.test(dataId))throw new Error('无效的引擎/数据盘身份');
 const diskCheck=`#!/bin/sh
set -eu
test "$(findmnt -n -o UUID --target /mnt/desklab-data)" = '${dataId}'
`;
 const setup=`#!/bin/bash
set -euo pipefail
device=/dev/disk/by-id/virtio-desklab-data
for n in $(seq 1 60); do test -b "$device" && break; sleep 1; done
test -b "$device"
uuid=$(blkid -s UUID -o value "$device" || true)
if [ -z "$uuid" ]; then
 ${allowFormat?'test -z "$(blkid -o value "$device" || true)"; mkfs.ext4 -q -U '+dataId+' -L DeskLabData "$device"':'echo "Data disk is missing its filesystem; refusing to format" >&2; exit 1'}
fi
test "$(blkid -s UUID -o value "$device")" = '${dataId}'
mkdir -p /mnt/desklab-data
grep -q '^UUID=${dataId} ' /etc/fstab || echo 'UUID=${dataId} /mnt/desklab-data ext4 defaults 0 2' >> /etc/fstab
mountpoint -q /mnt/desklab-data || mount /mnt/desklab-data
/usr/local/sbin/desklab-disk-check
mkdir -p /mnt/desklab-data/docker /mnt/desklab-data/containerd
systemctl disable docker.service docker.socket || true
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service || true
systemctl daemon-reload
systemctl enable containerd.service desklab-docker.service
systemctl restart containerd.service
systemctl restart desklab-docker.service
systemctl start qemu-guest-agent.service
`;
 const dockerUnit=`[Unit]
Description=DeskLab Docker Engine
After=network-online.target containerd.service
Wants=network-online.target
Requires=containerd.service
RequiresMountsFor=/mnt/desklab-data
[Service]
Type=notify
ExecStartPre=/usr/local/sbin/desklab-disk-check
ExecStart=/usr/bin/dockerd --config-file=/etc/docker/daemon.json --containerd=/run/containerd/containerd.sock
Restart=on-failure
RestartSec=3
TimeoutStartSec=120
TimeoutStopSec=90
LimitNOFILE=infinity
LimitNPROC=infinity
Delegate=yes
KillMode=process
[Install]
WantedBy=multi-user.target
`;
 const file=(path:string,content:string,permissions='0600')=>({path,content,permissions});
 const config={hostname:'desklab-engine',manage_etc_hosts:true,users:[],disable_root:true,ssh_pwauth:false,growpart:{mode:'auto',devices:['/'],ignore_growroot_disabled:true},resize_rootfs:true,
  write_files:[
   file('/etc/docker/ca.pem',await readFile(join(credentials.directory,'ca.pem'),'utf8')),
   file('/etc/docker/server.pem',await readFile(join(credentials.directory,'server.pem'),'utf8')),
   file('/etc/docker/server-key.pem',await readFile(join(credentials.directory,'server-key.pem'),'utf8')),
   file('/etc/docker/daemon.json',JSON.stringify({'data-root':'/mnt/desklab-data/docker',hosts:['unix:///var/run/docker.sock','tcp://0.0.0.0:2376'],tlsverify:true,tlscacert:'/etc/docker/ca.pem',tlscert:'/etc/docker/server.pem',tlskey:'/etc/docker/server-key.pem',labels:[`io.desklab.engine=${engineId}`,`io.desklab.data=${dataId}`],'log-driver':'json-file','log-opts':{'max-size':'10m','max-file':'3'},'live-restore':false})),
   file('/etc/containerd/config.toml','version = 2\nroot = "/mnt/desklab-data/containerd"\nstate = "/run/containerd"\n'),
   file('/usr/local/sbin/desklab-disk-check',diskCheck,'0700'),file('/usr/local/sbin/desklab-initialize',setup,'0700'),
   file('/etc/systemd/system/desklab-docker.service',dockerUnit,'0644'),
   file('/etc/systemd/system/containerd.service.d/desklab.conf','[Unit]\nRequiresMountsFor=/mnt/desklab-data\n[Service]\nExecStartPre=/usr/local/sbin/desklab-disk-check\n','0644')
  ],runcmd:[['bash','/usr/local/sbin/desklab-initialize']]};
 await createConfigIso(path,'CIDATA',{'meta-data':JSON.stringify({'instance-id':engineId+'-'+credentials.generation,'local-hostname':'desklab-engine'}),'user-data':'#cloud-config\n'+JSON.stringify(config)});
}
