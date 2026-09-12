import {authorizeKeyCommand,checkedPublicKey} from '../shared/ssh';
export const installationRecipeIds = ['ubuntu-server', 'debian-server', 'rocky-server', 'windows-desktop', 'windows-server'] as const;
export type InstallationRecipeId = typeof installationRecipeIds[number];
export interface InstallationRecipe {
  files: Record<string, string>;
  kernelPath?: string; initrdPath?: string; append?: string;
  seedLabel?: string; initrdFiles?: Record<string, string>;
}
export interface InstallationRecipeOptions { baseUrl: string; hostname: string; token?: string; sshPublicKey?:string; }

const password = 'DeskLab0987';
// SHA512-crypt of the deliberately shared, user-requested local lab password.
const passwordHash = '$6$rounds=10000$DeskLabInstall$JnMq.FJ5ODoiidm/Uf3RvfQ53CEbFMHNGzltf2r3ZX85cJurCkmoZR4uGpGqDjivBGqO.KTQy0lvAmhGPe.hn0';
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/** Pure seed/config generation. The caller must attach only the new guest disk. */
export function installationRecipe(id: string, options: InstallationRecipeOptions): InstallationRecipe {
  if (!(installationRecipeIds as readonly string[]).includes(id)) throw new Error('此系统尚未提供自动安装配方');
  const windows = id.startsWith('windows-');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(options.hostname) || (windows && (options.hostname.length > 15 || /^\d+$/.test(options.hostname)))) throw new Error('安装主机名必须使用合法的英文、数字或连字符；Windows 最多 15 个字符');
  let url: URL;
  try { url = new URL(options.baseUrl); } catch { throw new Error('安装回调地址无效'); }
  // Keep kernel arguments, shell, YAML and XML confined to a per-VM local route.
  // Reject encoded separators and URL normalization rather than accepting shell text.
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  if (url.protocol !== 'http:' || url.hostname !== '10.0.2.2' || !url.port || url.username || url.password || url.search || url.hash || !/^\/install\/[a-z0-9_-]+\/?$/i.test(url.pathname) || !/^http:\/\/10\.0\.2\.2:\d+\/install\/[a-z0-9_-]+$/i.test(baseUrl)) throw new Error('安装回调地址必须是带独立令牌的本机 guest HTTP 地址');
  if (options.token !== undefined && options.token !== baseUrl.split('/').at(-1)) throw new Error('安装令牌与回调地址不一致');
  if (windows) return windowsRecipe(id as 'windows-desktop'|'windows-server', baseUrl, options.hostname);
  const recipe=id==='ubuntu-server'?ubuntuRecipe(baseUrl,options.hostname):id==='debian-server'?debianRecipe(baseUrl,options.hostname):rockyRecipe(baseUrl,options.hostname);
  if(options.sshPublicKey) {
    const key=checkedPublicKey(options.sshPublicKey);
    recipe.files['finish.sh']=recipe.files['finish.sh'].replace('mkdir -p /etc/ssh/sshd_config.d',authorizeKeyCommand(key)+'\nmkdir -p /etc/ssh/sshd_config.d').replace('PermitRootLogin yes\\nPasswordAuthentication yes\\n','PermitRootLogin prohibit-password\\nPasswordAuthentication no\\nPubkeyAuthentication yes\\n').replace('ssh_pwauth: true','ssh_pwauth: false');
  }
  return recipe;
}

function linuxFinish(baseUrl: string) {
  return String.raw`#!/bin/bash
set -Eeuo pipefail
BASE_URL=${shell(baseUrl)}
report() {
  local event="$1" body="$2" attempt
  for attempt in 1 2 3 4 5; do
    if curl -fsS --connect-timeout 5 --max-time 10 -H 'Content-Type: application/json' --data "$body" "$BASE_URL/$event" >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
failed() {
  local status=$?
  trap - ERR
  report failed "{\"event\":\"failed\",\"message\":\"Linux final configuration failed\",\"exitCode\":$status}" || true
  exit "$status"
}
trap failed ERR
printf '%s\n' 'root:${password}' | chpasswd
chage -M -1 -E -1 root
usermod -s /bin/bash root
mkdir -p /etc/systemd/system/getty@tty1.service.d /etc/systemd/system/serial-getty@ttyS0.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<'DESKLAB_GETTY'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear %I $TERM
DESKLAB_GETTY
cat > /etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf <<'DESKLAB_SERIAL'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --keep-baud 115200,38400,9600 %I $TERM
DESKLAB_SERIAL
mkdir -p /etc/ssh/sshd_config.d
printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/00-desklab.conf
if [ -d /etc/cloud/cloud.cfg.d ]; then
  printf 'disable_root: false\nssh_pwauth: true\n' > /etc/cloud/cloud.cfg.d/99-desklab-root.cfg
fi
if systemctl list-unit-files ssh.service --no-legend | grep -q '^ssh.service'; then systemctl enable ssh; else systemctl enable sshd; fi
systemctl enable getty@tty1.service serial-getty@ttyS0.service
systemctl set-default multi-user.target
if command -v restorecon >/dev/null; then restorecon -RF /etc/systemd/system /etc/ssh /root; fi
test "$(id -u root)" = 0
passwd -S root | grep -Eq '^root (P|PS) '
grep -q -- '--autologin root' /etc/systemd/system/getty@tty1.service.d/autologin.conf
grep -q -- '--autologin root' /etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf
printf 'DeskLab installation configured\n' > /root/desklab-configured.txt
# The callback is one-time and must not become a startup task in cached clones.
rm -f -- /root/desklab-setup.sh
sync
report installed '{"event":"installed","user":"root","automaticLogin":true}'
trap - ERR
# The installer powers off only after this script and its HTTP request return.
`;
}

// https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html
function ubuntuRecipe(baseUrl: string, hostname: string): InstallationRecipe {
  const config = {autoinstall:{version:1, 'refresh-installer':{update:false}, locale:'en_US.UTF-8', keyboard:{layout:'us'}, timezone:'Asia/Shanghai',
    source:{id:'ubuntu-server', search_drivers:false}, identity:{hostname, username:'desklab', realname:'DeskLab', password:passwordHash},
    ssh:{'install-server':true, 'allow-pw':true},
    // An empty candidate list selects offline fallback without probing the public Internet.
    apt:{geoip:false, fallback:'offline-install', 'mirror-selection':{primary:[]}},
    storage:{layout:{name:'direct', match:{path:'/dev/sda'}}},
    'late-commands':[
      ['wget', '-O', '/target/root/desklab-setup.sh', `${baseUrl}/finish.sh`],
      ['curtin', 'in-target', '--target=/target', '--', 'bash', '/root/desklab-setup.sh'],
    ],
    'error-commands':[['curl', '-fsS', '--max-time', '15', '-H', 'Content-Type: application/json', '--data', '{"event":"failed","message":"Ubuntu installation failed; inspect the installer console"}', `${baseUrl}/failed`]],
    shutdown:'poweroff',
  }};
  return {files:{'user-data':`#cloud-config\n${JSON.stringify(config, null, 2)}\n`, 'meta-data':`instance-id: desklab-${hostname}\nlocal-hostname: ${hostname}\n`, 'finish.sh':linuxFinish(baseUrl)},
    kernelPath:'casper/vmlinuz', initrdPath:'casper/initrd', append:'autoinstall ds=nocloud console=tty0 console=ttyS0,115200n8 ---', seedLabel:'CIDATA'};
}

// https://www.debian.org/releases/stable/amd64/apbs04.en.html
// https://www.debian.org/releases/stable/amd64/apbs05.en.html
function debianRecipe(baseUrl: string, hostname: string): InstallationRecipe {
  const late = `wget -O /target/root/desklab-setup.sh ${shell(`${baseUrl}/finish.sh`)} && in-target /bin/bash /root/desklab-setup.sh || { wget -q -O /dev/null --post-data=${shell('{"event":"failed","message":"Debian final configuration failed"}')} ${shell(`${baseUrl}/failed`)}; exit 1; }`;
  const preseed = `d-i debian-installer/locale string en_US.UTF-8
d-i keyboard-configuration/xkb-keymap select us
d-i netcfg/choose_interface select auto
d-i netcfg/get_hostname string ${hostname}
d-i netcfg/get_domain string local
d-i netcfg/hostname string ${hostname}
d-i hw-detect/load_firmware boolean true
d-i passwd/root-login boolean true
d-i passwd/make-user boolean false
d-i passwd/root-password-crypted password ${passwordHash}
d-i clock-setup/utc boolean true
d-i time/zone string Asia/Shanghai
d-i clock-setup/ntp boolean false
d-i partman-auto/disk string /dev/sda
d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman-lvm/device_remove_lvm boolean true
d-i partman-md/device_remove_md boolean true
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i apt-setup/use_mirror boolean false
d-i apt-setup/cdrom/set-first boolean false
d-i apt-setup/cdrom/set-next boolean false
d-i apt-setup/cdrom/set-failed boolean false
d-i apt-setup/services-select multiselect
tasksel tasksel/first multiselect standard, ssh-server
d-i pkgsel/include string openssh-server curl
d-i pkgsel/upgrade select none
popularity-contest popularity-contest/participate boolean false
d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string /dev/sda
d-i finish-install/reboot_in_progress note
d-i debian-installer/exit/poweroff boolean true
d-i preseed/late_command string ${late}
`;
  return {files:{'preseed.cfg':preseed, 'finish.sh':linuxFinish(baseUrl)}, kernelPath:'install.amd/vmlinuz', initrdPath:'install.amd/initrd.gz',
    initrdFiles:{'preseed.cfg':preseed}, append:'auto=true priority=critical vga=normal console=tty0 console=ttyS0,115200n8 ---'};
}

// https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/automatically_installing_rhel/kickstart-script-file-format-reference_rhel-installer
function rockyRecipe(baseUrl: string, hostname: string): InstallationRecipe {
  const kickstart = `text
eula --agreed
lang en_US.UTF-8
keyboard us
timezone Asia/Shanghai --utc
rootpw --iscrypted ${passwordHash}
network --bootproto=dhcp --device=link --activate --hostname=${hostname}
selinux --enforcing
firewall --enabled --service=ssh
services --enabled=sshd
ignoredisk --only-use=sda
zerombr
clearpart --all --initlabel --drives=sda
bootloader --location=mbr --boot-drive=sda
part / --fstype=xfs --size=8192 --grow --ondisk=sda
part swap --size=1024 --ondisk=sda
poweroff
cdrom
%packages
@^minimal-environment
openssh-server
curl
%end
%post --erroronfail --log=/root/desklab-kickstart.log
set -eu
curl -fsS --connect-timeout 5 --max-time 30 ${shell(`${baseUrl}/finish.sh`)} -o /root/desklab-setup.sh
bash /root/desklab-setup.sh
%end
%onerror
curl -fsS --max-time 15 -H 'Content-Type: application/json' --data '{"event":"failed","message":"Rocky installation failed; inspect the installer console"}' ${shell(`${baseUrl}/failed`)} || true
%end
`;
  return {files:{'ks.cfg':kickstart, 'finish.sh':linuxFinish(baseUrl)}, kernelPath:'images/pxeboot/vmlinuz', initrdPath:'images/pxeboot/initrd.img',
    append:`inst.stage2=hd:LABEL=Rocky-9-8-x86_64-dvd inst.ks=${baseUrl}/ks.cfg ip=dhcp console=tty0 console=ttyS0,115200n8 inst.text`};
}

function windowsFinish(baseUrl: string) {
  return String.raw`$ErrorActionPreference = 'Stop'
$baseUrl = '${baseUrl}'
function Send-Report([string]$event, [hashtable]$details) {
  $details.event = $event
  $body = [Text.Encoding]::UTF8.GetBytes(($details | ConvertTo-Json -Compress))
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + '/' + $event) -Method POST -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 10 | Out-Null; return }
    catch { if ($attempt -eq 4) { throw }; Start-Sleep -Seconds 2 }
  }
}
try {
  $admin = Get-LocalUser | Where-Object { $_.SID.Value -match '-500$' }
  if (!$admin) { throw 'Built-in Administrator account was not found' }
  if ($admin.Name -ne 'Administrator') { Rename-LocalUser -Name $admin.Name -NewName 'Administrator' }
  Enable-LocalUser -Name 'Administrator'
  Set-LocalUser -Name 'Administrator' -Password (ConvertTo-SecureString '${password}' -AsPlainText -Force) -PasswordNeverExpires $true
  $path = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $path AutoAdminLogon '1'
  Set-ItemProperty $path DefaultUserName 'Administrator'
  Set-ItemProperty $path DefaultDomainName $env:COMPUTERNAME
  Set-ItemProperty $path DefaultPassword '${password}'
  Set-ItemProperty $path ForceAutoLogon '1'
  Remove-ItemProperty $path AutoLogonCount -ErrorAction SilentlyContinue
  if (!(Test-Path 'HKLM:\SOFTWARE\Microsoft\ServerManager')) { New-Item 'HKLM:\SOFTWARE\Microsoft\ServerManager' | Out-Null }
  Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\ServerManager' DoNotOpenServerManagerAtLogon 1
  $policy = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  if (!(Test-Path $policy)) { New-Item $policy | Out-Null }
  Set-ItemProperty $policy DisableCAD 1
  & powercfg.exe /change monitor-timeout-ac 0
  & powercfg.exe /change standby-timeout-ac 0
  & powercfg.exe /hibernate off
  & mountvol.exe S: /s
  if ($LASTEXITCODE -ne 0) { throw 'Cannot mount the guest EFI partition' }
  try {
    & bcdboot.exe C:\Windows /s S: /f UEFI | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare guest EFI boot files' }
    if (!(Test-Path 'S:\EFI\Boot')) { New-Item -ItemType Directory 'S:\EFI\Boot' | Out-Null }
    Copy-Item 'S:\EFI\Microsoft\Boot\bootmgfw.efi' 'S:\EFI\Boot\bootx64.efi' -Force
    if (!(Test-Path 'S:\EFI\Boot\bootx64.efi')) { throw 'EFI fallback boot file is missing' }
  } finally { & mountvol.exe S: /d }
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DeskLabLogon {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool LogonUser(string user, string domain, string password, int logonType, int provider, out IntPtr token);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
  $handle = [IntPtr]::Zero
  if (![DeskLabLogon]::LogonUser('Administrator', $env:COMPUTERNAME, '${password}', 2, 0, [ref]$handle)) { throw 'Administrator password verification failed' }
  [DeskLabLogon]::CloseHandle($handle) | Out-Null
  if ($env:USERNAME -ne 'Administrator' -or !(Get-LocalUser -Name 'Administrator').Enabled) { throw 'Administrator automatic login was not established' }
  $login = Get-ItemProperty $path
  if ($login.AutoAdminLogon -ne '1' -or $login.DefaultUserName -ne 'Administrator' -or $login.DefaultPassword -ne '${password}') { throw 'Automatic login settings are incomplete' }
  $session = (Get-Process -Id $PID).SessionId
  $desktop = $null
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $desktop = Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }
    if ($desktop) { break }; Start-Sleep -Seconds 2
  }
  if (!$desktop) { throw 'The initial Windows desktop did not become ready' }
  # The only callback script is on the removable seed disk. No task/startup entry
  # is installed in Windows, so cached clones never contact this installation URL.
  if (!(Test-Path 'C:\DeskLab')) { New-Item -ItemType Directory -Path 'C:\DeskLab' | Out-Null }
  'Configuration and Administrator password verified' | Set-Content 'C:\DeskLab\configured.txt'
  Send-Report 'installed' @{user='Administrator'; automaticLogin=$true; passwordVerified=$true; explorer=$true}
  & shutdown.exe /s /t 3 /d p:4:1
  if ($LASTEXITCODE -ne 0) { throw 'Windows could not schedule normal shutdown' }
} catch {
  try { Send-Report 'failed' @{message=$_.Exception.Message} } catch { }
  exit 1
}
`;
}

// https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-shell-setup-firstlogoncommands
// https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcdboot-command-line-options-techref-di
function windowsRecipe(id: 'windows-desktop'|'windows-server', baseUrl: string, hostname: string): InstallationRecipe {
  const locale = id === 'windows-server' ? 'zh-CN' : 'en-US', index = id === 'windows-server' ? 2 : 1;
  // Launch asynchronously: FirstLogonCommands runs before Explorer, which the
  // completion script must observe before reporting a usable Windows desktop.
  const command = String.raw`cmd /c for %d in (D E F G H I J K L M N O P Q R S T U V W X Y Z) do @if exist %d:\Finish.ps1 start "" /b powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File %d:\Finish.ps1`;
  const component = 'processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"';
  const international = `<InputLocale>0409:00000409</InputLocale><SystemLocale>${locale}</SystemLocale><UILanguage>${locale}</UILanguage><UserLocale>${locale}</UserLocale>`;
  const unattended = `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
 <settings pass="windowsPE">
  <component name="Microsoft-Windows-International-Core-WinPE" ${component}><SetupUILanguage><UILanguage>${locale}</UILanguage></SetupUILanguage>${international}</component>
  <component name="Microsoft-Windows-Setup" ${component}>
   <DiskConfiguration><Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions>
    <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>100</Size></CreatePartition>
    <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
    <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
   </CreatePartitions><ModifyPartitions>
    <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
    <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
   </ModifyPartitions></Disk><WillShowUI>OnError</WillShowUI></DiskConfiguration>
   <ImageInstall><OSImage><InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>${index}</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo><WillShowUI>OnError</WillShowUI></OSImage></ImageInstall>
   <UserData><AcceptEula>true</AcceptEula><FullName>DeskLab</FullName><Organization>DeskLab</Organization></UserData>
  </component>
 </settings>
 <settings pass="specialize">
  <component name="Microsoft-Windows-Shell-Setup" ${component}><ComputerName>${xml(hostname)}</ComputerName><TimeZone>China Standard Time</TimeZone></component>
  <component name="Microsoft-Windows-Deployment" ${component}><RunSynchronous><RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>cmd /c net user Administrator /active:yes</Path></RunSynchronousCommand></RunSynchronous></component>
 </settings>
 <settings pass="oobeSystem">
  <component name="Microsoft-Windows-International-Core" ${component}>${international}</component>
  <component name="Microsoft-Windows-Shell-Setup" ${component}>
   <UserAccounts><AdministratorPassword><Value>${password}</Value><PlainText>true</PlainText></AdministratorPassword></UserAccounts>
   <AutoLogon><Password><Value>${password}</Value><PlainText>true</PlainText></Password><Enabled>true</Enabled><LogonCount>999999</LogonCount><Username>Administrator</Username></AutoLogon>
   <OOBE><HideEULAPage>true</HideEULAPage><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><NetworkLocation>Work</NetworkLocation><ProtectYourPC>3</ProtectYourPC></OOBE>
   <FirstLogonCommands><SynchronousCommand wcm:action="add"><Order>1</Order><Description>Finish DeskLab configuration</Description><CommandLine>${xml(command)}</CommandLine><RequiresUserInput>false</RequiresUserInput></SynchronousCommand></FirstLogonCommands>
  </component>
 </settings>
</unattend>
`;
  return {files:{'Autounattend.xml':unattended, 'Finish.ps1':windowsFinish(baseUrl)}, seedLabel:'DESKLAB'};
}
