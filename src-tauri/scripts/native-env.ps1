# Author: ahui
# Dot-source this file in PowerShell 7 before Cargo or pnpm tauri commands.
# It configures only this process and its children; user/system environment is untouched.
# LLVM 23.1.3 and xwin 0.10.0 SDK files are official user-level downloads.
$ErrorActionPreference = 'Stop'
$nativeLlvmRoot = if ($env:ECG_LLVM_ROOT) { $env:ECG_LLVM_ROOT } else { 'D:\software\llvm\23.1.3\clang+llvm-23.1.3-x86_64-pc-windows-msvc' }
$nativeSysroot = if ($env:ECG_WINDOWS_SYSROOT) { $env:ECG_WINDOWS_SYSROOT } else { 'D:\software\xwin\sdk' }
$nativeCompiler = Join-Path $nativeLlvmRoot 'bin\clang-cl.exe'
$nativeLinker = Join-Path $nativeLlvmRoot 'bin\lld-link.exe'
if (!(Test-Path -LiteralPath $nativeCompiler) -or !(Test-Path -LiteralPath $nativeLinker)) {
    throw 'LLVM clang-cl/lld-link are unavailable. Set ECG_LLVM_ROOT to a portable LLVM installation.'
}
$nativeVcVersion = Get-ChildItem -LiteralPath (Join-Path $nativeSysroot 'VC\Tools\MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$nativeSdkVersion = Get-ChildItem -LiteralPath (Join-Path $nativeSysroot 'Windows Kits\10\Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$nativeVcVersion -or !$nativeSdkVersion) { throw 'xwin MSVC/Windows SDK files are unavailable.' }
$nativeIncludeBase = $nativeSdkVersion.FullName
$nativeLibBase = Join-Path $nativeSysroot ('Windows Kits\10\Lib\' + $nativeSdkVersion.Name)
$env:PATH = (Join-Path $nativeLlvmRoot 'bin') + ';' + (Join-Path $env:USERPROFILE '.cargo\bin') + ';' + $env:PATH
$env:CC = $nativeCompiler
$env:CXX = $nativeCompiler
$env:AR = Join-Path $nativeLlvmRoot 'bin\llvm-lib.exe'
$env:RC = Join-Path $nativeLlvmRoot 'bin\llvm-rc.exe'
$env:CFLAGS = '/winsysroot' + $nativeSysroot
$env:CXXFLAGS = $env:CFLAGS
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $nativeLinker
$env:LIB = @((Join-Path $nativeVcVersion.FullName 'lib\x64'),(Join-Path $nativeLibBase 'ucrt\x64'),(Join-Path $nativeLibBase 'um\x64')) -join ';'
$env:INCLUDE = @((Join-Path $nativeVcVersion.FullName 'include'),(Join-Path $nativeIncludeBase 'ucrt'),(Join-Path $nativeIncludeBase 'um'),(Join-Path $nativeIncludeBase 'shared'),(Join-Path $nativeIncludeBase 'winrt'),(Join-Path $nativeIncludeBase 'cppwinrt')) -join ';'
