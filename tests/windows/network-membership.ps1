$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '../../native/windows/NetworkSetup/setup.ps1'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source,[Text.Encoding]::UTF8),[ref]$tokens,[ref]$errors)
if($errors.Count){throw $errors[0].Message}
foreach($name in @('Bridge-Adapters','Wait-For')) {
    $node=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    . ([scriptblock]::Create($node.Extent.Text))
}
$a='11111111-1111-4111-8111-111111111111';$b='22222222-2222-4222-8222-222222222222';$bridge='33333333-3333-4333-8333-333333333333'
function Adapters {
    [pscustomobject]@{InterfaceGuid=[Guid]$a;Name='TAP-A';InterfaceDescription='TAP-Windows Adapter V9'}
    [pscustomobject]@{InterfaceGuid=[Guid]$b;Name='TAP-B';InterfaceDescription='TAP-Windows Adapter V9'}
    [pscustomobject]@{InterfaceGuid=[Guid]$bridge;Name='Bridge';InterfaceDescription='Microsoft Network Adapter Multiplexor Driver'}
}
function By-Id($id) { Adapters | Where-Object {$_.InterfaceGuid -eq [Guid]$id} }
function Save-Journal {}
function Start-Sleep {param($Milliseconds)}
function Get-NetAdapterBinding { param($Name,[switch]$AllBindings);[pscustomobject]@{ComponentID='ms_implat';Enabled=($Name -eq 'TAP-A' -or $script:joined)} }
function Run-Shell($verb,$ids) {
    if($verb -eq 'probe'){return (@{commands=@(@{verb='addtobridge';enabled=$script:available})} | ConvertTo-Json -Compress)}
    if($verb -eq 'addtobridge') {
        if($ids.Count -ne 1 -or $ids[0] -ne $b){throw 'Attempted to repair an unrequested adapter'}
        $script:repairs++;$script:joined=$true
    }
}
foreach($available in @($true,$false)) {
    $script:available=$available;$script:joined=$false;$script:repairs=0
    $script:journal=@{beforeIds=@();taps=@(@{id=$a},@{id=$b});bridgeId=$null}
    $failed=$false
    try {Bridge-Adapters @($a,$b)}catch{$failed=$true}
    if($available -and ($failed -or $script:repairs -ne 1)){throw 'Missing member was not repaired through its advertised command'}
    if(!$available -and (!$failed -or $script:repairs -ne 0)){throw 'Missing Shell command was bypassed or unjoined member was accepted'}
}
'{"repairOffered":true,"missingCommandRejected":true}'
