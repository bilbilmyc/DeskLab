import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { installationRecipe, installationRecipeIds } from '../server/install-recipes';

const options = {baseUrl:'http://10.0.2.2:54321/install/vm_TEST-123', hostname:'desk-a1b2c3d4'};
const linuxIds = ['ubuntu-server', 'debian-server', 'rocky-server'] as const;
const windowsIds = ['windows-desktop', 'windows-server'] as const;

test('only the five supported unattended installers are offered', ()=>{
  expect([...installationRecipeIds]).toEqual([...linuxIds, ...windowsIds]);
  for (const id of ['ubuntu-desktop', 'debian-desktop', 'rocky-desktop', '../ubuntu-server', '']) {
    expect(()=>installationRecipe(id, options)).toThrow('尚未提供');
  }
});

test('per-machine URLs and hostnames cannot inject installer or shell instructions', ()=>{
  for (const baseUrl of [
    'http://example.com:54321/install/token', 'https://10.0.2.2:54321/install/token',
    'http://user@10.0.2.2:54321/install/token', 'http://10.0.2.2/install/token',
    options.baseUrl+'?x=1', options.baseUrl+'#fragment', options.baseUrl+'/../token',
    options.baseUrl+"';touch /tmp/x", options.baseUrl+'%27', options.baseUrl+'\n',
  ]) for (const id of installationRecipeIds) expect(()=>installationRecipe(id, {...options, baseUrl})).toThrow();
  for (const hostname of ['-desk', 'desk-', 'desk\nreboot', "desk';reboot", '<desk>', 'desk&reboot', '']) {
    for (const id of installationRecipeIds) expect(()=>installationRecipe(id, {...options, hostname})).toThrow('主机名');
  }
  for (const id of windowsIds) {
    expect(()=>installationRecipe(id, {...options, hostname:'a'.repeat(16)})).toThrow('主机名');
    expect(()=>installationRecipe(id, {...options, hostname:'123456'})).toThrow('主机名');
  }
  expect(()=>installationRecipe('ubuntu-server', {...options, token:'different'})).toThrow('令牌');
  expect(installationRecipe('ubuntu-server', {...options, token:'vm_TEST-123', baseUrl:options.baseUrl+'/'})).toEqual(installationRecipe('ubuntu-server', options));
});

test('generated resources are independent per call and contain no historic provisioning dependencies', ()=>{
  for (const id of installationRecipeIds) {
    const first = installationRecipe(id, options);
    const second = installationRecipe(id, {baseUrl:'http://10.0.2.2:54322/install/next-token', hostname:'desk-deadbeef'});
    const original = JSON.stringify(first), next = JSON.stringify(second);
    expect(original).toContain(options.baseUrl);
    expect(next).toContain('http://10.0.2.2:54322/install/next-token');
    expect(next).not.toContain(options.baseUrl);
    for (const stale of ['43220', 'c5fffd60bc9ebff', '.runtime/tests/provision', '127.0.0.1:9', 'Verify.ps1', 'Ready.ps1']) expect(original).not.toContain(stale);
    for (const path of Object.keys(first.files)) expect(path).toMatch(/^[a-zA-Z0-9.-]+$/);
    first.files['caller-added'] = 'fixture';
    expect(installationRecipe(id, options).files['caller-added']).toBeUndefined();
  }
});

test('Ubuntu uses the server ISO offline, targets the guest disk and powers off after late configuration', ()=>{
  const recipe = installationRecipe('ubuntu-server', options);
  const config = JSON.parse(recipe.files['user-data'].slice('#cloud-config\n'.length)).autoinstall;
  expect(recipe).toMatchObject({kernelPath:'casper/vmlinuz', initrdPath:'casper/initrd', seedLabel:'CIDATA'});
  expect(recipe.append).toContain('autoinstall ds=nocloud');
  expect(config.source).toEqual({id:'ubuntu-server', search_drivers:false});
  expect(config.apt).toEqual({geoip:false, fallback:'offline-install', 'mirror-selection':{primary:[]}});
  expect(config.storage.layout.match).toEqual({path:'/dev/sda'});
  expect(config.identity.hostname).toBe(options.hostname);
  expect(config.identity.password).toStartWith('$6$rounds=10000$');
  expect(config['late-commands']).toEqual([
    ['wget', '-O', '/target/root/desklab-setup.sh', options.baseUrl+'/finish.sh'],
    ['curtin', 'in-target', '--target=/target', '--', 'bash', '/root/desklab-setup.sh'],
  ]);
  expect(config['error-commands'][0].at(-1)).toBe(options.baseUrl+'/failed');
  expect(config.shutdown).toBe('poweroff');
  expect(config.packages).toBeUndefined();
});

test('Debian embeds preseed at initrd root and installs only server packages from its DVD', ()=>{
  const recipe = installationRecipe('debian-server', options), preseed = recipe.files['preseed.cfg'];
  expect(recipe).toMatchObject({kernelPath:'install.amd/vmlinuz', initrdPath:'install.amd/initrd.gz', initrdFiles:{'preseed.cfg':preseed}});
  expect(preseed).toContain('d-i passwd/make-user boolean false');
  expect(preseed).toContain('d-i passwd/root-password-crypted password $6$');
  expect(preseed).toContain('d-i partman-auto/disk string /dev/sda');
  expect(preseed).toContain('d-i apt-setup/use_mirror boolean false');
  expect(preseed).toContain('tasksel tasksel/first multiselect standard, ssh-server');
  expect(preseed).toContain('d-i pkgsel/include string openssh-server curl');
  expect(preseed).not.toMatch(/gnome|kde|desktop/i);
  expect(preseed).toContain('d-i debian-installer/exit/poweroff boolean true');
  expect(preseed).toContain(options.baseUrl+'/failed');
});

test('Rocky uses the matching DVD label, a minimal server and only the fresh guest disk', ()=>{
  const recipe = installationRecipe('rocky-server', options), kickstart = recipe.files['ks.cfg'];
  expect(recipe).toMatchObject({kernelPath:'images/pxeboot/vmlinuz', initrdPath:'images/pxeboot/initrd.img'});
  expect(recipe.append).toContain('inst.stage2=hd:LABEL=Rocky-9-8-x86_64-dvd');
  expect(recipe.append).toContain(`inst.ks=${options.baseUrl}/ks.cfg`);
  expect(kickstart).toContain('ignoredisk --only-use=sda');
  expect(kickstart).toContain('clearpart --all --initlabel --drives=sda');
  expect(kickstart).toContain('@^minimal-environment');
  expect(kickstart).toContain('\npoweroff\ncdrom\n');
  expect(kickstart).toContain('%post --erroronfail');
  expect(kickstart).toContain('%onerror\n');
  expect(kickstart).toContain(options.baseUrl+'/failed');
});

test('Linux completion follows root password and console autologin verification and removes its one-time script', ()=>{
  for (const id of linuxIds) {
    const finish = installationRecipe(id, options).files['finish.sh'];
    expect(finish).toContain("'root:DeskLab0987' | chpasswd");
    expect(finish).toContain('trap failed ERR');
    expect(finish).toContain('passwd -S root');
    expect(finish).toContain('--autologin root --noclear %I $TERM');
    expect(finish).toContain('--autologin root --keep-baud');
    expect(finish).toContain('systemctl set-default multi-user.target');
    const report = finish.indexOf("report installed '");
    expect(report).toBeGreaterThan(finish.indexOf('passwd -S root'));
    expect(report).toBeGreaterThan(finish.indexOf('rm -f -- /root/desklab-setup.sh'));
    expect(finish.slice(report)).not.toMatch(/\b(?:reboot|shutdown|poweroff)\b/);
    expect(finish).not.toContain('ExecStart=/root/');
  }
});

test('Windows waits for verified Administrator desktop and prepares portable EFI before normal shutdown', ()=>{
  for (const id of windowsIds) {
    const recipe = installationRecipe(id, options), finish = recipe.files['Finish.ps1'];
    expect(recipe.seedLabel).toBe('DESKLAB');
    expect(finish).toContain("LogonUser('Administrator', $env:COMPUTERNAME, 'DeskLab0987'");
    expect(finish).toContain('bcdboot.exe C:\\Windows /s S: /f UEFI');
    expect(finish).toContain('S:\\EFI\\Boot\\bootx64.efi');
    expect(finish).toContain('Remove-ItemProperty $path AutoLogonCount');
    expect(finish).toContain('Get-Process explorer');
    expect(finish).not.toMatch(/Register-ScheduledTask|CurrentVersion\\Run|Startup\\/i);
    const installed = finish.indexOf("Send-Report 'installed'");
    expect(installed).toBeGreaterThan(finish.indexOf('LogonUser('));
    expect(installed).toBeGreaterThan(finish.indexOf('if (!$desktop)'));
    expect(finish.indexOf('& shutdown.exe /s /t 3')).toBeGreaterThan(installed);
    expect(finish).toContain("Send-Report 'failed'");
    expect(recipe.files['Autounattend.xml']).not.toContain(options.baseUrl);
  }
});

// Parse only. Never execute either the Windows or Linux guest setup script on
// the host. Windows PowerShell's parser also checks the here-string containing C#.
test.skipIf(process.platform !== 'win32')('Windows seeds parse as XML and their finish scripts parse as PowerShell', ()=>{
  const payload = windowsIds.map(id=>({id, ...installationRecipe(id, options).files}));
  const parser = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rows = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = foreach ($row in $rows) {
  $tokens = $null; $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($row.'Finish.ps1', [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
  [xml]$document = $row.'Autounattend.xml'
  $ns = New-Object Xml.XmlNamespaceManager($document.NameTable)
  $ns.AddNamespace('u', 'urn:schemas-microsoft-com:unattend')
  [ordered]@{
    id=$row.id
    image=$document.SelectSingleNode('//u:MetaData/u:Value', $ns).InnerText
    partition=$document.SelectSingleNode('//u:InstallTo/u:PartitionID', $ns).InnerText
    disk=$document.SelectSingleNode('//u:InstallTo/u:DiskID', $ns).InnerText
    hostname=$document.SelectSingleNode('//u:ComputerName', $ns).InnerText
    user=$document.SelectSingleNode('//u:AutoLogon/u:Username', $ns).InnerText
    password=$document.SelectSingleNode('//u:AutoLogon/u:Password/u:Value', $ns).InnerText
    command=$document.SelectSingleNode('//u:FirstLogonCommands//u:CommandLine', $ns).InnerText
  }
}
ConvertTo-Json -InputObject @($result) -Compress`;
  const result = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')], {stdin:Buffer.from(JSON.stringify(payload)), stdout:'pipe', stderr:'pipe'});
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout.toString().replace(/^\uFEFF/, ''));
  for (const [index, seed] of parsed.entries()) {
    expect(seed).toMatchObject({id:windowsIds[index], image:String(index+1), partition:'3', disk:'0', hostname:options.hostname, user:'Administrator', password:'DeskLab0987'});
    expect(seed.command).toContain('start "" /b powershell.exe');
    expect(seed.command).toContain('-File %d:\\Finish.ps1');
  }
});

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
test.skipIf(!existsSync(bash))('generated Linux finish and installer shell hooks pass Bash syntax checks', ()=>{
  for (const id of linuxIds) {
    const recipe = installationRecipe(id, options);
    const scripts = [recipe.files['finish.sh']];
    if (id === 'debian-server') scripts.push(recipe.files['preseed.cfg'].split('d-i preseed/late_command string ')[1]);
    if (id === 'rocky-server') scripts.push(recipe.files['ks.cfg'].split('%post --erroronfail --log=/root/desklab-kickstart.log\n')[1].split('%end')[0]);
    for (const script of scripts) {
      const result = Bun.spawnSync([bash, '-n'], {stdin:Buffer.from(script), stdout:'pipe', stderr:'pipe'});
      expect(result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
    }
  }
});
