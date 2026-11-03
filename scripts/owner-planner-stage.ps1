param(
    [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedScopeSha256,
    [switch]$InspectOnly
)
$ErrorActionPreference = 'Stop'
function Write-Once([string]$Path, $Value) {
    $Bytes=[Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 8 -Compress))
    $Stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $Stream.Write($Bytes,0,$Bytes.Length); $Stream.Flush() } finally { $Stream.Dispose() }
}
function Now-Ms { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
$Key=$null; $Child=$null; $Dispatched=$false; $Attempted=$false
try {
    $Release=(Resolve-Path -LiteralPath $ReleaseDirectory).Path
    $ScopePath=Join-Path $Release 'scope.json'
    if ((Get-FileHash -LiteralPath $ScopePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedScopeSha256) { throw 'Scope mismatch' }
    $Scope=Get-Content -LiteralPath $ScopePath -Raw | ConvertFrom-Json
    $Authority=Get-Content -LiteralPath (Join-Path $Release 'staging-authority.json') -Raw | ConvertFrom-Json
    if ($Authority.approved -ne $true -or $Authority.scopeSha256 -ne $ExpectedScopeSha256 -or
        $Scope.expiresAt -le (Now-Ms) -or
        (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Scope.stageScriptSha256) { throw 'Unapproved or stale staging' }
    $InventoryPath=Join-Path $Release 'source-inventory.json'
    if ((Get-FileHash -LiteralPath $InventoryPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Scope.sourceInventorySha256) { throw 'Inventory mismatch' }
    $Inventory=Get-Content -LiteralPath $InventoryPath -Raw | ConvertFrom-Json
    $RootPrefix=[IO.Path]::GetFullPath($Scope.canonicalRoot).TrimEnd('\') + '\'
    if ($Inventory.PSObject.Properties.Count -lt 1) { throw 'Empty inventory' }
    foreach ($Entry in $Inventory.PSObject.Properties) {
        $SourcePath=[IO.Path]::GetFullPath((Join-Path $Scope.canonicalRoot $Entry.Name))
        if (-not $SourcePath.StartsWith($RootPrefix,[StringComparison]::OrdinalIgnoreCase) -or
            $Entry.Name -match '(^|[/\\])\.env(\.|$)' -or $Entry.Value -notmatch '^[a-f0-9]{64}$' -or
            (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Entry.Value) { throw 'Source mismatch' }
    }
    if ($InspectOnly) { Write-Output 'INSPECT_PASS_NO_KEY_NO_PROCESS'; exit 0 }
    if ([Console]::IsInputRedirected) { throw 'Owner console required' }
    Write-Once (Join-Path $Release 'staging-attempt.json') @{ scopeSha256=$ExpectedScopeSha256; atMs=(Now-Ms); maximumManualAttempts=1; secretRecorded=$false }
    $Attempted=$true
    $Key=Read-Host 'Enter the selected Gemini key privately (hidden; no API window has started)' -AsSecureString
    if ($Key.Length -lt 16 -or $Key.Length -gt 256 -or $Scope.expiresAt -le (Now-Ms)) { throw 'Private input refused or expired' }
    $Key.MakeReadOnly()
    $Info=New-Object System.Diagnostics.ProcessStartInfo
    $Info.FileName='C:\Program Files\nodejs\node.exe'
    $Info.WorkingDirectory=$Scope.canonicalRoot
    $Info.Arguments='--import tsx "scripts/owner-planner-runtime.ts" "' + $Release + '" "' + $ExpectedScopeSha256 + '"'
    $Info.UseShellExecute=$false; $Info.CreateNoWindow=$true
    $Info.RedirectStandardInput=$true; $Info.RedirectStandardOutput=$true; $Info.RedirectStandardError=$true
    $Info.EnvironmentVariables.Clear()
    foreach ($Name in @('SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP')) {
        $Value=[Environment]::GetEnvironmentVariable($Name)
        if ($Value) { $Info.EnvironmentVariables[$Name]=$Value }
    }
    $Info.EnvironmentVariables['NEXT_TELEMETRY_DISABLED']='1'
    $Child=New-Object System.Diagnostics.Process; $Child.StartInfo=$Info
    if (-not $Child.Start()) { throw 'Owner runtime failed to start' }
    $OutDrain=$Child.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $ErrDrain=$Child.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $ReadyUntil=[Math]::Min((Now-Ms)+900000,[long]$Scope.expiresAt)
    Write-Output 'Key staged privately. Waiting up to 15 minutes for exact process-bound activation. Do not run another attempt.'
    while ((Now-Ms) -lt $ReadyUntil -and -not $Child.HasExited) {
        $RequestPath=Join-Path $Release 'key-request.json'
        if (Test-Path -LiteralPath $RequestPath) {
            $Ready=Get-Content -LiteralPath (Join-Path $Release 'ready.json') -Raw | ConvertFrom-Json
            $Request=Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
            $Activation=Get-Content -LiteralPath (Join-Path $Release 'activation.json') -Raw | ConvertFrom-Json
            if ($Request.pid -ne $Child.Id -or $Ready.pid -ne $Child.Id -or $Activation.pid -ne $Child.Id -or
                $Ready.nonce -ne $Request.nonce -or $Ready.nonce -ne $Activation.nonce -or
                $Request.scopeSha256 -ne $ExpectedScopeSha256 -or $Activation.scopeSha256 -ne $ExpectedScopeSha256 -or
                $Activation.approved -ne $true -or $Request.grantSha256 -ne $Activation.grantSha256 -or
                $Request.windowEnd -gt $Scope.expiresAt -or $Request.windowEnd-(Now-Ms) -lt 10000) { throw 'Runtime binding refused' }
            $Pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Key)
            try { $Child.StandardInput.WriteLine([Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)); $Child.StandardInput.Flush() }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer); $Key.Dispose(); $Key=$null }
            $Child.StandardInput.Close(); $Dispatched=$true
            Write-Once (Join-Path $Release 'owner-handoff.json') @{ pid=$Child.Id; nonce=$Ready.nonce; grantSha256=$Activation.grantSha256; atMs=(Now-Ms); secretRecorded=$false }
            $Remaining=[long]$Request.windowEnd-(Now-Ms)
            # No extra grace period after the absolute provider approval deadline.
            if ($Remaining -le 0 -or -not $Child.WaitForExit([int][Math]::Min($Remaining,300000))) { throw 'Exact window expired; outcome uncertain' }
            $OutDrain.Wait(); $ErrDrain.Wait(); $Code=$Child.ExitCode
            Write-Once (Join-Path $Release 'owner-result.json') @{ status='PROCESS_EXITED_REQUIRES_EVIDENCE_READBACK'; exit=$Code; pid=$Child.Id; atMs=(Now-Ms) }
            Write-Output ('Bounded process exited ' + $Code + '. Preserve evidence; do not retry automatically.')
            exit $Code
        }
        Start-Sleep -Milliseconds 100
    }
    throw 'No valid activation or runtime stopped'
} catch {
    if ($Attempted -and -not (Test-Path -LiteralPath (Join-Path $Release 'owner-result.json'))) {
        Write-Once (Join-Path $Release 'owner-result.json') @{ status='STOPPED_NO_AUTOMATIC_RETRY'; secretHandedOff=$Dispatched; atMs=(Now-Ms) }
    }
    Write-Output 'Owner staging stopped. No secret content logged. Preserve records and any lock; no automatic retry.'
    exit 1
} finally {
    if ($null -ne $Key) { $Key.Dispose(); $Key=$null }
    if ($null -ne $Child) {
        try { if (-not $Child.HasExited) { $Child.Kill() } } catch { }
        $Child.Dispose()
    }
}
