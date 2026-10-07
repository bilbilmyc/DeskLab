$ErrorActionPreference = 'Stop'
$log = 'D:\workspace\bun-demo\.runtime\checks\l2-setup.log'
$info = 'D:\workspace\bun-demo\.runtime\checks\l2-info.json'
$tapctl = 'D:\workspace\bun-demo\.runtime\build\tapctl\Release\tapctl.exe'
$helper = 'D:\workspace\bun-demo\.runtime\build\native\DeskLab.NetworkSetup-a2d36bbce3c8fdcf.exe'
$stamp = Get-Date -Format 'HH:mm:ss'
try {
  $logContent = [System.Collections.Generic.List[string]]::new()
  $logContent.Add("start $stamp")
  $bridge = Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceDescription -eq 'Microsoft Network Adapter Multiplexor Driver' } | Select-Object -First 1
  $taps = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -like 'DeskLab-L2-*' } | Sort-Object Name)
  if (-not $bridge -or $taps.Count -lt 2) {
    # Rebuild from scratch: unjoin and remove leftovers first.
    foreach ($tap in $taps) {
      $bound = @(Get-NetAdapterBinding -Name $tap.Name -AllBindings | Where-Object { $_.ComponentID -eq 'ms_implat' -and $_.Enabled }).Count -eq 1
      if ($bound) { & $helper --shell removefrombridge $tap.InterfaceGuid.ToString().Trim('{}') 2>&1 | Out-Null }
      & $tapctl delete ('{' + $tap.InterfaceGuid.ToString().Trim('{}') + '}') 2>&1 | Out-Null
    }
    if ($bridge) {
      & $helper --shell delete $bridge.InterfaceGuid.ToString().Trim('{}') 2>&1 | Out-Null
      for ($n = 0; $n -lt 15; $n++) { if (-not (Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceGuid -eq $bridge.InterfaceGuid })) { break }; Start-Sleep -Seconds 2 }
    }
    $suffix = (Get-Date -Format 'HHmmss')
    $aName = 'DeskLab-L2-A-' + $suffix; $bName = 'DeskLab-L2-B-' + $suffix
    $outA = & $tapctl create --hwid 'root\tap0901' --name $aName 2>&1
    if ($LASTEXITCODE -ne 0) { throw "tapctl A failed: $outA" }
    $outB = & $tapctl create --hwid 'root\tap0901' --name $bName 2>&1
    if ($LASTEXITCODE -ne 0) { throw "tapctl B failed: $outB" }
    $guidA = [regex]::Match($outA, '[0-9a-fA-F-]{36}').Value
    $guidB = [regex]::Match($outB, '[0-9a-fA-F-]{36}').Value
    $shell = & $helper --shell createbridge $guidA $guidB 2>&1
    $logContent.Add("createbridge: $shell")
    for ($n = 0; $n -lt 30; $n++) {
      $bridge = Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceDescription -eq 'Microsoft Network Adapter Multiplexor Driver' } | Select-Object -First 1
      if ($bridge) { break }; Start-Sleep -Seconds 2
    }
    if (-not $bridge) { throw 'bridge adapter did not appear' }
    $taps = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -in @($aName, $bName) } | Sort-Object Name)
  }
  # Repair path: the bridge may exist with a member missing; add it through the
  # canonical Shell verb only when the menu offers the command.
  foreach ($tap in $taps) {
    $guid = $tap.InterfaceGuid.ToString().Trim('{}')
    $joined = @(Get-NetAdapterBinding -Name $tap.Name -AllBindings | Where-Object { $_.ComponentID -eq 'ms_implat' -and $_.Enabled }).Count -eq 1
    if (-not $joined) {
      $menu = (& $helper --shell probe $guid 2>&1 | ConvertFrom-Json)
      if (@($menu.commands | Where-Object { $_.verb -eq 'addtobridge' -and $_.enabled }).Count -eq 1) {
        $logContent.Add("repairing member $($tap.Name) via addtobridge")
        & $helper --shell addtobridge $guid 2>&1 | Out-Null
      } else { $logContent.Add("member $($tap.Name) unbound and addtobridge not offered") }
    }
    for ($n = 0; $n -lt 20; $n++) {
      $tap = Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceGuid.ToString().Trim('{}') -ieq $guid }
      $joined = @(Get-NetAdapterBinding -Name $tap.Name -AllBindings | Where-Object { $_.ComponentID -eq 'ms_implat' -and $_.Enabled }).Count -eq 1
      if ($joined) { break }; Start-Sleep -Seconds 2
    }
    if (-not $joined) { throw "member $($tap.Name) not bound to bridge" }
  }
  if (-not (Get-NetIPAddress -InterfaceIndex $bridge.ifIndex -IPAddress 10.99.0.1 -ErrorAction SilentlyContinue)) {
    Set-NetIPInterface -InterfaceIndex $bridge.ifIndex -AddressFamily IPv4 -Dhcp Disabled
    New-NetIPAddress -InterfaceIndex $bridge.ifIndex -IPAddress 10.99.0.1 -PrefixLength 24 | Out-Null
  }
  @{ bridgeId = $bridge.InterfaceGuid.ToString().Trim('{}'); bridgeIfIndex = $bridge.ifIndex
     tapA = @{ guid = $taps[0].InterfaceGuid.ToString().Trim('{}'); name = $taps[0].Name }
     tapB = @{ guid = $taps[1].InterfaceGuid.ToString().Trim('{}'); name = $taps[1].Name } } | ConvertTo-Json | Set-Content -Path $info
  $logContent.Add("OK bridge=$($bridge.Name) index=$($bridge.ifIndex) taps=$($taps[0].Name),$($taps[1].Name)")
  $logContent | Set-Content -Path $log
} catch { (($logContent -join "`n") + "`n" + ($_ | Out-String)) | Set-Content -Path $log }
