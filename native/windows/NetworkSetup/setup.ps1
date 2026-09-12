param([ValidateSet('isolated','prepare','rollback')][string]$Action,[Guid]$Target)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$work=$PSScriptRoot
$journalPath=Join-Path $work 'journal.json'
$statusPath=Join-Path $work 'status.json'
$tapctl=Join-Path $work 'tapctl.exe'
$helper=Join-Path $work 'DeskLab.NetworkSetup.exe'
function Save-Status($state,$message) {
    $value=@{state=$state;message=$message;updatedAt=[DateTime]::UtcNow.ToString('o');operationId=(Split-Path $work -Leaf)}
    $value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath ($statusPath+'.tmp') -Encoding UTF8
    Move-Item -LiteralPath ($statusPath+'.tmp') -Destination $statusPath -Force
}
function Save-Journal { $script:journal | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $journalPath -Encoding UTF8 }
function Adapters { @(Get-NetAdapter -IncludeHidden -ErrorAction Stop) }
function By-Id([string]$id) { @(Adapters | Where-Object {$_.InterfaceGuid.ToString().Trim('{}') -eq $id.Trim('{}')}) }
function Run-Shell([string]$verb,[string[]]$ids) {
    $out=& $helper --shell $verb @ids
    if($LASTEXITCODE -ne 0){throw "Shell $verb failed: $out"}
    $out | Set-Content -LiteralPath (Join-Path $work ('shell-'+$verb+'.json')) -Encoding UTF8
    return $out
}
function Wait-For($condition,$message) {
    $lastError=''
    for($i=0;$i -lt 45;$i++) {
        # NetAdapter's CIM provider can briefly report ERROR_KEY_DELETED during PnP removal.
        # A failed query is never treated as evidence that an adapter is gone.
        try {if(& $condition){return}}catch{$lastError=$_.Exception.Message}
        Start-Sleep -Milliseconds 1000
    }
    throw ($message+$(if($lastError){': '+$lastError}else{''}))
}
function New-Tap([string]$name) {
    $script:journal.pendingName=$name;Save-Journal
    $out=& $tapctl create --hwid 'root\tap0901' --name $name 2>&1
    if($LASTEXITCODE -ne 0){throw "TAP creation failed: $out"}
    $adapter=@(Adapters | Where-Object Name -eq $name)
    if($adapter.Count -ne 1){throw 'Cannot identify new TAP'}
    $id=$adapter[0].InterfaceGuid.ToString().Trim('{}')
    $script:journal.taps+=@{id=$id;name=$name};$script:journal.pendingName=$null;Save-Journal
    return $id
}
function Bridge-Adapters([string[]]$ids) {
    Run-Shell 'probe' $ids | Out-Null
    Run-Shell 'createbridge' $ids | Out-Null
    $excluded=@($script:journal.beforeIds)+@($script:journal.taps | ForEach-Object {$_.id})
    Wait-For { @(Adapters | Where-Object {$_.InterfaceGuid.ToString().Trim('{}') -notin $excluded -and $_.InterfaceDescription -eq 'Microsoft Network Adapter Multiplexor Driver'}).Count -eq 1 } 'No unambiguous bridge appeared'
    $created=@(Adapters | Where-Object {$_.InterfaceGuid.ToString().Trim('{}') -notin $excluded -and $_.InterfaceDescription -eq 'Microsoft Network Adapter Multiplexor Driver'})
    $script:journal.bridgeId=$created[0].InterfaceGuid.ToString().Trim('{}');Save-Journal
    foreach($id in $ids) {
        $adapter=@(By-Id $id)
        if($adapter.Count -ne 1){throw 'Requested bridge member disappeared'}
        $joined=@(Get-NetAdapterBinding -Name $adapter[0].Name -AllBindings | Where-Object {$_.ComponentID -eq 'ms_implat' -and $_.Enabled}).Count -eq 1
        if(!$joined) {
            # Windows may create the bridge while omitting one requested member.
            # Repair only when the actual Shell menu offers the canonical command,
            # and the sole bridge is still the one recorded by this transaction.
            $bridges=@(Adapters | Where-Object InterfaceDescription -eq 'Microsoft Network Adapter Multiplexor Driver')
            if($bridges.Count -ne 1 -or $bridges[0].InterfaceGuid.ToString().Trim('{}') -ne $script:journal.bridgeId){throw 'Bridge identity changed before member repair'}
            $menu=Run-Shell 'probe' @($id) | ConvertFrom-Json
            if(@($menu.commands | Where-Object {$_.verb -eq 'addtobridge' -and $_.enabled}).Count -eq 1){Run-Shell 'addtobridge' @($id) | Out-Null}
        }
        Wait-For { $adapter=@(By-Id $id);$adapter.Count -eq 1 -and @(Get-NetAdapterBinding -Name $adapter[0].Name -AllBindings | Where-Object {$_.ComponentID -eq 'ms_implat' -and $_.Enabled}).Count -eq 1 } 'Bridge member binding not enabled'
    }
}
function Capture-Physical {
    $physical=@(Get-NetAdapter -Physical | Where-Object {$_.InterfaceGuid -eq $Target -and $_.HardwareInterface -and !$_.Virtual -and $_.Status -eq 'Up'})
    if($physical.Count -ne 1){throw 'Selected physical adapter is not connected'}
    $nic=$physical[0]
    if($nic.NdisPhysicalMedium -eq 9 -or $nic.PhysicalMediaType -match '802.11|Wireless'){throw 'Wi-Fi bridging has not passed compatibility validation'}
    if(@(Adapters | Where-Object InterfaceDescription -eq 'Microsoft Network Adapter Multiplexor Driver').Count){throw 'An existing Windows bridge must not be taken over'}
    $ipv4=Get-NetIPInterface -InterfaceIndex $nic.ifIndex -AddressFamily IPv4
    if($ipv4.Dhcp -ne 'Enabled'){throw 'This release supports DHCP physical adapters only; static addresses are preserved without changes'}
    $dnsPath='HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\'+$nic.InterfaceGuid.ToString('B')
    $customDns=(Get-ItemProperty -LiteralPath $dnsPath -Name NameServer -ErrorAction SilentlyContinue).NameServer
    if($customDns){throw 'Custom DNS configuration is not yet supported by automatic bridging'}
    $routes=@(Get-NetRoute -InterfaceIndex $nic.ifIndex -AddressFamily IPv4)
    if(@($routes | Where-Object {$_.Protocol -eq 'NetMgmt'}).Count){throw 'Custom routes are not yet supported by automatic bridging'}
    return @{id=$nic.InterfaceGuid.ToString().Trim('{}');name=$nic.Name;interfaceMetric=$ipv4.InterfaceMetric;automaticMetric=$ipv4.AutomaticMetric.ToString();addresses=@(Get-NetIPAddress -InterfaceIndex $nic.ifIndex | Select-Object IPAddress,PrefixLength,AddressFamily,PrefixOrigin);dns=@(Get-DnsClientServerAddress -InterfaceIndex $nic.ifIndex | Select-Object AddressFamily,ServerAddresses);routes=@($routes | Select-Object DestinationPrefix,NextHop,RouteMetric,Protocol);bindings=@(Get-NetAdapterBinding -Name $nic.Name -AllBindings | Select-Object ComponentID,Enabled)}
}
function Restore-Physical {
    if(!$script:journal.physical){return}
    $saved=$script:journal.physical;$nic=@(By-Id $saved.id)
    if($nic.Count -ne 1){throw 'Original physical adapter is missing'}
    foreach($binding in $saved.bindings) {
        if($binding.ComponentID -in @('ms_bridge','ms_implat')){continue}
        $current=Get-NetAdapterBinding -Name $nic[0].Name -ComponentID $binding.ComponentID -ErrorAction SilentlyContinue
        if($current -and $current.Enabled -ne $binding.Enabled){Set-NetAdapterBinding -Name $nic[0].Name -ComponentID $binding.ComponentID -Enabled $binding.Enabled -ErrorAction Stop | Out-Null}
    }
    Set-NetIPInterface -InterfaceIndex $nic[0].ifIndex -AddressFamily IPv4 -Dhcp Enabled -AutomaticMetric $saved.automaticMetric
    if($saved.automaticMetric -eq 'Disabled'){Set-NetIPInterface -InterfaceIndex $nic[0].ifIndex -AddressFamily IPv4 -InterfaceMetric $saved.interfaceMetric}
    Set-DnsClientServerAddress -InterfaceIndex $nic[0].ifIndex -ResetServerAddresses
    Wait-For { @(Get-NetIPAddress -InterfaceIndex $nic[0].ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*'}).Count -gt 0 } 'Host DHCP address has not recovered'
}
function Undo {
    Save-Status 'rolling-back' '正在撤销本次网络配置'
    if($script:journal.pendingName) {
        $pending=@(Adapters | Where-Object {$_.Name -eq $script:journal.pendingName -and $_.InterfaceDescription -match 'TAP-Windows' -and $_.InterfaceGuid.ToString().Trim('{}') -notin $script:journal.beforeIds})
        if($pending.Count -eq 1) {$script:journal.taps+=@{id=$pending[0].InterfaceGuid.ToString().Trim('{}');name=$pending[0].Name};$script:journal.pendingName=$null;Save-Journal}
        elseif($pending.Count -gt 1){throw 'Ambiguous interrupted TAP creation'}
    }
    # Unjoin owned members before deleting the bridge. Shell's generic Delete can
    # return success without removing an in-use bridge and display a later dialog.
    $memberIds=@($script:journal.taps | ForEach-Object {$_.id})
    if($script:journal.physical){$memberIds+=@($script:journal.physical.id)}
    foreach($memberId in $memberIds) {
        $member=@(By-Id $memberId)
        if($member.Count -eq 1 -and @(Get-NetAdapterBinding -Name $member[0].Name -AllBindings | Where-Object {$_.ComponentID -eq 'ms_implat' -and $_.Enabled}).Count) {
            Run-Shell 'removefrombridge' @($memberId) | Out-Null
            Wait-For { $current=@(By-Id $memberId);$current.Count -eq 0 -or @(Get-NetAdapterBinding -Name $current[0].Name -AllBindings | Where-Object {$_.ComponentID -eq 'ms_implat' -and $_.Enabled}).Count -eq 0 } 'Bridge member has not detached'
        }
    }
    $bridges=@(Adapters | Where-Object {$_.InterfaceDescription -match 'MAC Bridge|Microsoft.*Multiplexor|多路传送器|网桥' -and $_.InterfaceGuid.ToString().Trim('{}') -notin $script:journal.beforeIds})
    foreach($bridge in $bridges) {
        # Only delete the recorded bridge; never act on another application's new adapter.
        if($script:journal.bridgeId -eq $bridge.InterfaceGuid.ToString().Trim('{}')) {
            Run-Shell 'delete' @($script:journal.bridgeId) | Out-Null
            Wait-For { @(By-Id $script:journal.bridgeId).Count -eq 0 } 'Bridge removal has not completed; TAP adapters were retained for recovery'
        }
    }
    foreach($tap in $script:journal.taps) {
        if(@(By-Id $tap.id).Count) { $out=& $tapctl delete ('{'+$tap.id+'}') 2>&1;if($LASTEXITCODE -ne 0){throw "TAP cleanup failed: $out"} }
    }
    Wait-For { @($script:journal.taps | Where-Object {@(By-Id $_.id).Count}).Count -eq 0 } 'TAP adapters remain after cleanup'
    if($script:journal.bridgeId){Wait-For { @(By-Id $script:journal.bridgeId).Count -eq 0 } 'Bridge remains after cleanup'}
    Restore-Physical
    Save-Status 'rolled-back' '本次创建的网卡和网桥已撤销'
}
function Repair-PreviousTests {
    $currentWork=$script:work;$currentJournalPath=$script:journalPath;$currentStatusPath=$script:statusPath
    try {
        foreach($directory in @(Get-ChildItem -LiteralPath (Split-Path $currentWork) -Directory)) {
            if($directory.FullName -eq $currentWork -or $directory.Name -notmatch '^[0-9a-f-]{36}$'){continue}
            $oldJournal=Join-Path $directory.FullName 'journal.json';$oldStatus=Join-Path $directory.FullName 'status.json'
            if(!(Test-Path -LiteralPath $oldJournal) -or !(Test-Path -LiteralPath $oldStatus)){continue}
            $saved=Get-Content -LiteralPath $oldJournal -Raw | ConvertFrom-Json
            $state=Get-Content -LiteralPath $oldStatus -Raw | ConvertFrom-Json
            if($state.state -notin @('needs-recovery','configuring','rolling-back') -or $saved.physical){continue}
            if(@($saved.taps | Where-Object {$_.name -notlike ('DeskLab-Test-*-'+$directory.Name.Substring(0,8))}).Count){throw 'Previous operation contains non-test adapters; recover it explicitly'}
            $script:work=$directory.FullName;$script:journalPath=$oldJournal;$script:statusPath=$oldStatus;$script:journal=$saved
            Undo
        }
    } finally {$script:work=$currentWork;$script:journalPath=$currentJournalPath;$script:statusPath=$currentStatusPath;$script:journal=$null}
}
try {
    if($Action -eq 'rollback') {
        if(!(Test-Path -LiteralPath $journalPath)){throw 'No owned operation journal'}
        $script:journal=Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
        Undo;exit 0
    }
    if(Test-Path -LiteralPath $journalPath){throw 'Operation already exists; use rollback'}
    if($Action -eq 'isolated') {
        Repair-PreviousTests
        if(@(Adapters | Where-Object InterfaceDescription -eq 'Microsoft Network Adapter Multiplexor Driver').Count){throw 'Existing Windows bridge is outside this isolated test; no changes were made'}
    }
    $physical=$null
    if($Action -eq 'prepare') {
        # Never enable a new backend from a successful InvokeCommand alone.
        $proof=@(Get-ChildItem -LiteralPath (Split-Path $work) -Filter status.json -Recurse | ForEach-Object {try{Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json}catch{}} | Where-Object {$_.state -eq 'validated'})
        if(!$proof.Count){throw 'Automatic physical bridging is awaiting isolated rollback validation'}
        $physical=Capture-Physical
    }
    Save-Status 'preparing' '正在校验并安装签名 TAP 驱动'
    foreach($entry in @(@('OemVista.inf','1327AB3A8C50691F04BEA8E2CA356C5B604092A719E219464F8CC4B42E192DE9'),@('tap0901.cat','EE062E5EF2743CEAB10C64830E4CEFE52E35CC1ECE85947AC4E61DDD1C0B05F7'),@('tap0901.sys','581DCAACE05D5C1AC9512457FF50565ACA5D904D2C209BD3FC369CA4D4A0D2B1'))) {
        if((Get-FileHash -LiteralPath (Join-Path $work $entry[0]) -Algorithm SHA256).Hash -ne $entry[1]){throw 'Driver hash mismatch'}
    }
    foreach($name in @('tap0901.cat','tap0901.sys')){if((Get-AuthenticodeSignature -LiteralPath (Join-Path $work $name)).Status -ne 'Valid'){throw 'Driver signature invalid'}}
    $out=& "$env:SystemRoot\System32\pnputil.exe" /add-driver (Join-Path $work 'OemVista.inf') 2>&1
    $out | Set-Content -LiteralPath (Join-Path $work 'driver-install.log')
    if($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010){throw "Driver staging failed: $out"}
    $script:journal=@{action=$Action;physical=$physical;beforeIds=@(Adapters | ForEach-Object {$_.InterfaceGuid.ToString().Trim('{}')});taps=@();bridgeId=$null;pendingName=$null}
    Save-Journal
    $suffix=(Split-Path $work -Leaf).Substring(0,8)
    if($Action -eq 'prepare') {
        $tap=New-Tap ('DeskLab-TAP-'+$suffix)
        Save-Status 'configuring' '正在连接所选有线网卡与专用 TAP'
        Bridge-Adapters @($physical.id,$tap)
        $bridge=@(By-Id $script:journal.bridgeId)[0]
        Set-NetIPInterface -InterfaceIndex $bridge.ifIndex -AddressFamily IPv4 -Dhcp Enabled
        Set-DnsClientServerAddress -InterfaceIndex $bridge.ifIndex -ResetServerAddresses
        Wait-For { @(Get-NetIPAddress -InterfaceIndex $bridge.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*'}).Count -gt 0 } 'Host bridge did not obtain a DHCP address'
        Wait-For { @(Get-NetRoute -InterfaceIndex $bridge.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue).Count -gt 0 } 'Host bridge did not obtain a default route'
        Save-Status 'ready' '专用 TAP 与有线网络桥已准备，宿主机已获得 DHCP 地址';exit 0
    }
    for($round=1;$round -le 3;$round++) {
        $script:journal.taps=@();$script:journal.bridgeId=$null;$script:journal.round=$round;Save-Journal
        $a=New-Tap ('DeskLab-Test-A-'+$round+'-'+$suffix);$b=New-Tap ('DeskLab-Test-B-'+$round+'-'+$suffix)
        Save-Status 'configuring' ('正在验证隔离建桥与撤销，第 '+$round+' / 3 轮')
        Bridge-Adapters @($a,$b)
        Run-Shell 'probe' @($script:journal.bridgeId) | Out-Null
        Undo
    }
    Save-Status 'validated' '连续三轮隔离网卡建桥与撤销验证通过';exit 0
} catch {
    $failure=$_.Exception.Message
    $failure | Set-Content -LiteralPath (Join-Path $work 'last-error.txt') -Encoding UTF8
    if($Action -ne 'rollback' -and $script:journal -and (Test-Path -LiteralPath $journalPath)) {
        try {Undo;Save-Status 'rolled-back' ('配置未完成，已撤销本次修改：'+$failure);exit 1}catch{$failure+='; rollback: '+$_.Exception.Message}
    }
    Save-Status $(if(Test-Path -LiteralPath $journalPath){'needs-recovery'}else{'failed'}) $failure
    exit 1
}
