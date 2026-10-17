param([string]$JavaHome = $env:JAVA_HOME, [switch]$Prepare)
$ErrorActionPreference = 'Stop'
try {
    $service = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/info' -TimeoutSec 1
    if ($service.protocol -eq 1 -and $service.minecraft -eq '1.21.1') {
        if ($Prepare) { throw 'Stop the running preview before preparing changed Java sources.' }
        Write-Output 'WGE preview is already running: http://127.0.0.1:8765/'
        exit 0
    }
} catch {
    if ($Prepare -and $_.Exception.Message -eq 'Stop the running preview before preparing changed Java sources.') { throw }
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
