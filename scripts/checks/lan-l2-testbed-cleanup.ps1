$ErrorActionPreference = 'Continue'
$log = 'D:\workspace\bun-demo\.runtime\checks\l2-cleanup.log'
$tapctl = 'D:\workspace\bun-demo\.runtime\build\tapctl\Release\tapctl.exe'
$helper = 'D:\workspace\bun-demo\.runtime\build\native\DeskLab.NetworkSetup-a2d36bbce3c8fdcf.exe'
$out = New-Object System.Collections.Generic.List[string]
foreach ($tap in @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -like 'DeskLab-L2-*' })) {
  $guid = $tap.InterfaceGuid.ToString().Trim('{}')
  $bound = @(Get-NetAdapterBinding -Name $tap.Name -AllBindings | Where-Object { $_.ComponentID -eq 'ms_implat' -and $_.Enabled }).Count -eq 1
  if ($bound) { $out.Add((& $helper --shell removefrombridge $guid 2>&1) -join ' ') }
}
Start-Sleep -Seconds 3
foreach ($bridge in @(Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceDescription -eq 'Microsoft Network Adapter Multiplexor Driver' })) {
  $out.Add((& $helper --shell delete $bridge.InterfaceGuid.ToString().Trim('{}') 2>&1) -join ' ')
  for ($n = 0; $n -lt 15; $n++) {
    if (-not (Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceGuid -eq $bridge.InterfaceGuid })) { break }
    Start-Sleep -Seconds 2
  }
}
foreach ($tap in @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -like 'DeskLab-L2-*' })) {
  $out.Add((& $tapctl delete ('{' + $tap.InterfaceGuid.ToString().Trim('{}') + '}') 2>&1) -join ' ')
}
Start-Sleep -Seconds 2
$tapsLeft = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -like 'DeskLab-L2-*' }).Count
$bridgesLeft = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceDescription -eq 'Microsoft Network Adapter Multiplexor Driver' }).Count
$out.Add("tapsLeft=$tapsLeft bridgesLeft=$bridgesLeft")
Remove-Item 'D:\workspace\bun-demo\.runtime\checks\l2-info.json' -Force -ErrorAction SilentlyContinue
$out | Set-Content -Path $log
