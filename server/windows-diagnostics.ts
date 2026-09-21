import {join} from 'node:path';
import {run} from './qemu';

export interface WindowsVirtualization {firmware: boolean | null; whpx: boolean | null;}
// WHvCapabilityCodeHypervisorPresent = 0. This queries the Windows API only;
// it does not create a partition, start a VM or change Windows features.
// https://learn.microsoft.com/virtualization/api/hypervisor-platform/funcs/whvgetcapability
export const virtualizationScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$result = @{ firmware = $null; whpx = $null }
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeskLabWhpProbe {
  [DllImport("WinHvPlatform.dll")]
  public static extern int WHvGetCapability(uint code, out int value, uint size, out uint written);
}
'@
  $present = 0; [uint32]$written = 0
  $hr = [DeskLabWhpProbe]::WHvGetCapability(0, [ref]$present, 4, [ref]$written)
  if ($hr -eq 0 -and $written -eq 4) { $result.whpx = ($present -ne 0) }
} catch {}
try {
  $system = Get-CimInstance Win32_ComputerSystem
  if ($system.HypervisorPresent -eq $true) { $result.firmware = $true }
  else {
    $processors = @(Get-CimInstance Win32_Processor)
    if ($processors.Count -gt 0 -and @($processors | Where-Object { $null -eq $_.VirtualizationFirmwareEnabled }).Count -eq 0) {
      $result.firmware = @($processors | Where-Object { $_.VirtualizationFirmwareEnabled -eq $false }).Count -eq 0
    }
  }
} catch {}
$result | ConvertTo-Json -Compress
`;
export async function windowsVirtualization(): Promise<WindowsVirtualization> {
  if (process.platform !== 'win32') return {firmware: null, whpx: null};
  try {
    const output = await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(virtualizationScript, 'utf16le').toString('base64')], 15000);
    const result = JSON.parse(output);
    return {firmware: typeof result.firmware === 'boolean' ? result.firmware : null, whpx: typeof result.whpx === 'boolean' ? result.whpx : null};
  } catch { return {firmware: null, whpx: null}; }
}
