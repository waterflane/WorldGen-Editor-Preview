param([string]$JavaHome = $env:JAVA_HOME, [switch]$Prepare)
$ErrorActionPreference = 'Stop'
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
