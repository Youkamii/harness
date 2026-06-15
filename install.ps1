#!/usr/bin/env pwsh
# 하네스 설치 (Windows) — install.sh 의 PowerShell 대응판. PC당 1번만 실행.
# 이후 평소 사용은 아무 폴더에서 `claude`. 하네스를 수정한 뒤에는 `harness update`.
$ErrorActionPreference = 'Stop'

$Src = $PSScriptRoot
$Dst = Join-Path $env:USERPROFILE '.claude'
$Bin = Join-Path $env:USERPROFILE '.local\bin'

# 0) 전제 확인: node 필요 (훅·오케스트레이터·설정병합이 전부 Node)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'node 가 PATH 에 없습니다. Node.js 를 설치한 뒤 다시 실행하세요.'
  exit 1
}

# 1) 훅/스킬/에이전트를 전역으로 복사
New-Item -ItemType Directory -Force -Path `
  (Join-Path $Dst 'hooks'), (Join-Path $Dst 'skills'), (Join-Path $Dst 'agents'), $Bin | Out-Null
Copy-Item -Force    (Join-Path $Src '.claude\hooks\*.js')  (Join-Path $Dst 'hooks')
Copy-Item -Recurse -Force (Join-Path $Src '.claude\skills\*') (Join-Path $Dst 'skills')
Copy-Item -Force    (Join-Path $Src '.claude\agents\*.md') (Join-Path $Dst 'agents')
Write-Output "OK 훅/스킬/에이전트 -> $Dst"

# 2) 전역 설정에 훅 등록 + 승인/차단 규칙 병합 (Node, 크로스플랫폼. 기존 설정 보존)
#    merge-global-settings.mjs 가 Windows 에서는 훅 명령을 절대경로로 등록한다.
node (Join-Path $Src 'scripts\merge-global-settings.mjs')

# 3) 표준 규칙(CLAUDE.md) — 이미 있으면 덮어쓰지 않음
$ClaudeMd = Join-Path $Dst 'CLAUDE.md'
if (Test-Path $ClaudeMd) {
  if (-not (Select-String -Path $ClaudeMd -Pattern '하네스 표준 규칙' -Quiet)) {
    Write-Output "주의: $ClaudeMd 가 이미 있어 보존했습니다. 필요하면 $Src\CLAUDE.md 와 수동 병합하세요."
  }
} else {
  Copy-Item -Force (Join-Path $Src 'CLAUDE.md') $ClaudeMd
  Write-Output "OK 표준 규칙 -> $ClaudeMd"
}

# 4) 전역 harness 명령 설치 — bin\harness.ps1 을 호출하는 .cmd shim
#    (.cmd 는 PowerShell·cmd 양쪽에서 `harness` 로 호출되고, ExecutionPolicy 를 우회한다)
$Shim = Join-Path $Bin 'harness.cmd'
$Ps1  = Join-Path $Src 'bin\harness.ps1'
"@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$Ps1`" %*`r`n" |
  Set-Content -Path $Shim -Encoding ascii -NoNewline
Write-Output "OK 명령어 -> $Shim"

# 5) 사용자 PATH 에 ~/.local/bin 추가 (영구. 이미 있으면 생략)
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($UserPath -split ';') -notcontains $Bin) {
  [Environment]::SetEnvironmentVariable('Path', "$Bin;$UserPath", 'User')
  Write-Output "OK 사용자 PATH 에 $Bin 추가 — 새 터미널부터 적용됩니다."
}

Write-Output ''
Write-Output '설치 완료. 사용법:'
Write-Output '  - 평소: 아무 폴더에서 claude 실행 (하네스 자동 적용)'
Write-Output '  - 그 외: harness help   (새 터미널에서)'

