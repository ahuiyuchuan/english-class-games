<#
.SYNOPSIS
  使用已安装的 Windows 桌面语音预制发行示例录音，不改变应用的 WinRT 配音引擎。
.DESCRIPTION
  需要 PowerShell 7 和实际安装的 en-US / zh-CN SAPI 音色；缺少任一音色则明确失败，
  不联网安装资源、不改注册表、不生成假声音。输出位于 examples/source-audio，供
  build-examples.mjs 以“导入录音”绑定并生成真实离线课件。运行前确认此目录用于示例。
  同名输出属于可重新生成的示例资源；脚本不操作教师资料库。
.EXAMPLE
  pwsh -NoProfile -File scripts/prepare-example-audio.ps1
.NOTES
  Author: ahui. 文件与 JSON 使用 UTF-8 无 BOM、LF；WAV 为实际 PCM 音频。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$exampleAudioDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'examples/source-audio'
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.Directory]::CreateDirectory($exampleAudioDirectory) | Out-Null

# 语料与课件文案必须精确对应，录音仅用于演示导入与携带，不作为 WinRT 合成成功证据。
$items = @(
  @{ file = 'knowledge.wav'; text = 'knowledge'; language = 'en-US' },
  @{ file = 'challenge.wav'; text = 'challenge'; language = 'en-US' },
  @{ file = 'responsibility.wav'; text = 'responsibility'; language = 'en-US' },
  @{ file = 'cooperation.wav'; text = 'cooperation'; language = 'en-US' },
  @{ file = 'perseverance.wav'; text = 'perseverance'; language = 'en-US' },
  @{ file = 'take-part-in.wav'; text = 'take part in'; language = 'en-US' },
  @{ file = 'opening.wav'; text = '准备好，跟着节奏开口。'; language = 'zh-CN' },
  @{ file = 'closing.wav'; text = '练习完成，回顾今天的重点词。'; language = 'zh-CN' }
)
$speaker = New-Object -ComObject SAPI.SpVoice
try {
  $voices = @($speaker.GetVoices())
  $selectedVoices = @{}
  foreach ($language in @('en-US', 'zh-CN')) {
    $languageId = if ($language -eq 'en-US') { '409' } else { '804' }
    $match = $voices | Where-Object { $_.GetAttribute('Language').Split(';') -contains $languageId } | Select-Object -First 1
    if ($null -eq $match) {
      throw "没有已安装的 $language SAPI 音色，未制作完整示例；请提供对应录音后再生成。"
    }
    $selectedVoices[$language] = $match
  }

  foreach ($item in $items) {
    $stream = New-Object -ComObject SAPI.SpFileStream
    try {
      # SAPI SAFT22kHz16BitMono=22；原始采样信息仍由示例构建器读取 WAV 核对。
      $stream.Format.Type = 22
      $stream.Open((Join-Path $exampleAudioDirectory $item.file), 3, $false)
      $speaker.Voice = $selectedVoices[$item.language]
      $speaker.Rate = 0
      $speaker.Volume = 100
      $speaker.AudioOutputStream = $stream
      [void]$speaker.Speak($item.text, 0)
      $stream.Close()
      $item.voiceName = $selectedVoices[$item.language].GetDescription()
      $item.sha256 = (Get-FileHash -LiteralPath (Join-Path $exampleAudioDirectory $item.file) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    finally {
      [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($stream) | Out-Null
    }
  }
}
finally {
  [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($speaker) | Out-Null
}

$manifest = [ordered]@{
  author = 'ahui'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  source = 'Pre-generated recordings from installed Windows SAPI desktop voices'
  binding = 'recording'
  note = 'These recordings do not prove availability of an English WinRT voice.'
  items = $items
}
$json = ($manifest | ConvertTo-Json -Depth 5).Replace("`r`n", "`n") + "`n"
[System.IO.File]::WriteAllText((Join-Path $exampleAudioDirectory 'source.json'), $json, $utf8WithoutBom)
Write-Output "已制作 $($items.Count) 项实际录音：$exampleAudioDirectory"
