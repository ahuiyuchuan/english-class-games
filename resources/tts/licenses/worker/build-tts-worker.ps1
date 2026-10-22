# Build the project-owned adapter against the reviewed sherpa-onnx 1.13.8 SDK.
# Author: ahui. SPDX-License-Identifier: GPL-3.0-only.
# Pass the extracted official shared-MT SDK and the corresponding desktop-source root.
# This script changes only its process environment; third-party libraries stay unmodified.
param(
    [Parameter(Mandatory = $true)][string]$SherpaRoot,
    [string]$ProjectRoot = (Get-Location).Path
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$SherpaRoot = (Resolve-Path -LiteralPath $SherpaRoot).Path
. (Join-Path $ProjectRoot 'src-tauri/scripts/native-env.ps1')
$workerSource = Join-Path $ProjectRoot 'scripts/tts-worker.cpp'
$workerObject = Join-Path $ProjectRoot 'resources/tts/bin/tts-worker.obj'
$workerExe = Join-Path $ProjectRoot 'resources/tts/bin/tts-worker.exe'
$workerLibrary = Join-Path $SherpaRoot 'lib'
& $env:CC /nologo /O2 /MT /EHsc /std:c++17 /utf-8 "/I$SherpaRoot/include" $workerSource "/Fo$workerObject" "/Fe$workerExe" /link "/LIBPATH:$workerLibrary" sherpa-onnx-c-api.lib kernel32.lib /MANIFEST:NO
if ($LASTEXITCODE -ne 0) { throw 'Speech worker build failed' }
Copy-Item -LiteralPath (Join-Path $workerLibrary 'sherpa-onnx-c-api.dll') -Destination (Join-Path $ProjectRoot 'resources/tts/bin')
# Only the known intermediate file is removed; source and upstream binaries remain.
Remove-Item -LiteralPath $workerObject
