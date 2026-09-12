param([string]$Source=(Join-Path $PSScriptRoot '../../native/windows/NetworkSetup/setup.ps1'))
$ErrorActionPreference='Stop'
$tokens=$null;$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($Source,[Text.Encoding]::UTF8),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw $parseErrors[0].Message}
# Execute the production control flow against an asynchronous device-removal fixture.
# No production top-level statements, driver tools or network cmdlets are executed.
foreach($name in @('Undo','Wait-For')) {
    $node=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    . ([scriptblock]::Create($node.Extent.Text))
}
$bridgeId='11111111-1111-4111-8111-111111111111'
$tapId='22222222-2222-4222-8222-222222222222'
$script:journal=@{pendingName=$null;bridgeId=$bridgeId;beforeIds=@();taps=@(@{id=$tapId;name='DeskLab-Test-fixture'});physical=$null}
$script:phase='ready';$script:queries=0;$script:tapExists=$true;$script:events=@()
function Save-Status($state,$message){$script:events+=('status:'+ $state)}
function Start-Sleep { param($Milliseconds) }
function Adapters { [pscustomobject]@{InterfaceGuid=[Guid]$bridgeId;InterfaceDescription='Microsoft Network Adapter Multiplexor Driver'} }
function Run-Shell($verb,$ids){if($verb -ne 'delete'){throw 'Unexpected action'};$script:phase='deleting';$script:events+='bridge-delete-requested'}
function By-Id($id) {
    if($id -eq $bridgeId -and $script:phase -eq 'deleting') {
        $script:queries++
        if($script:queries -eq 1){throw 'Illegal operation attempted on a registry key that has been marked for deletion.'}
        if($script:queries -lt 3){return [pscustomobject]@{id=$bridgeId}}
        $script:phase='gone';$script:events+='bridge-gone'
    }
    if($id -eq $tapId -and $script:tapExists){return [pscustomobject]@{id=$tapId}}
}
function Get-NetAdapterBinding { @() }
function Fake-Tapctl($action,$id) {
    if($script:phase -ne 'gone'){throw 'Regression: TAP removed while bridge deletion was still pending'}
    if($action -ne 'delete' -or $id -ne ('{'+$tapId+'}')){throw 'Unexpected TAP deletion'}
    $script:tapExists=$false;$script:events+='tap-deleted';$global:LASTEXITCODE=0
}
function Restore-Physical { $script:events+='host-restored' }
$tapctl='Fake-Tapctl'
Undo
if($script:tapExists -or $script:queries -lt 3){throw 'Removal was not verified'}
if($script:events[-1] -ne 'status:rolled-back'){throw 'Rollback did not finish'}
$script:events | ConvertTo-Json -Compress
