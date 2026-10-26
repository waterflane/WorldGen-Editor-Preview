param([string]$JavaHome = $env:JAVA_HOME, [switch]$Prepare)
$ErrorActionPreference = 'Stop'
$service = $null
try {
    $service = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/info' -TimeoutSec 1
} catch { }
if ($service) {
    if ($Prepare) { throw 'Stop the running preview before preparing changed Java sources.' }
    if ($service.protocol -ne 2 -or $service.minecraft -ne '1.21.1' -or $service.capabilities -notcontains 'ocean_temperature_v1' -or $service.capabilities -notcontains 'island_outline_v1') {
        throw 'The running Java preview is outdated. Stop it, run start-preview.ps1 -Prepare, then reopen the preview.'
    }
    Write-Output 'WGE preview is already running: http://127.0.0.1:8765/'
    exit 0
}
$modRoot = Join-Path $PSScriptRoot '../WorldGen Editor'
$argumentsFile = Join-Path $modRoot 'preview-engine/build/runtime/java.args'
$savedJava = Join-Path $modRoot 'preview-engine/build/runtime/java.path'
if (!$JavaHome -and (Test-Path -LiteralPath $savedJava)) { $JavaHome = (Get-Content -LiteralPath $savedJava -Raw).Trim() }
$javaCommand = if ($JavaHome) { Join-Path $JavaHome 'bin/java.exe' } else { 'java' }
if ($JavaHome) { $env:JAVA_HOME = $JavaHome }
if ($Prepare -or !(Test-Path -LiteralPath $argumentsFile)) {
    Push-Location $modRoot
    try { & './gradlew.bat' ':preview-engine:preparePreview' '--no-daemon'; if ($LASTEXITCODE) { throw 'Preview preparation failed' } }
    finally { Pop-Location }
}
& $javaCommand "@$argumentsFile" $PSScriptRoot
exit $LASTEXITCODE
