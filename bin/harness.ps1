#!/usr/bin/env pwsh
# 전역 harness 명령 (Windows). bin/harness 의 PowerShell 대응판.
# install.ps1 이 ~/.local/bin/harness.cmd shim 을 만들어 이 파일을 호출한다.
# 저장소 위치는 이 파일(bin/)의 상위 폴더로 자동 계산 — 경로 치환이 필요 없다.
$ErrorActionPreference = 'Stop'
$HarnessDir = Split-Path -Parent $PSScriptRoot   # bin/ 의 부모 = 저장소 루트

$cmd  = if ($args.Count -ge 1) { $args[0] } else { 'help' }
$rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }

switch ($cmd) {
  'update' {  # 저장소 최신화 + 재설치 (다른 PC에서 수정사항 받을 때)
    git -C $HarnessDir pull --ff-only
    & (Join-Path $HarnessDir 'install.ps1')
  }
  'run'  { node (Join-Path $HarnessDir 'orchestrator/run.mjs') @rest }   # 장기 실행
  'eval' { node (Join-Path $HarnessDir 'evals/run.mjs') @rest }          # 성능 측정
  'test' {  # 훅 회귀 테스트 전부
    node (Join-Path $HarnessDir '.claude/hooks/guard.test.mjs')
    node (Join-Path $HarnessDir '.claude/hooks/secrets-guard.test.mjs')
  }
  'edit' { Set-Location $HarnessDir; claude }   # 하네스 소스를 Claude Code로 열기
  'dir'  { Write-Output $HarnessDir }           # 저장소 경로 출력
  default {
@'
harness — 개인 하네스 명령 (Windows)

  harness update   저장소 pull + 재설치 (수정사항 반영)
  harness run "목표" [--cwd 대상폴더]   장기 실행 에이전트
  harness eval [태스크]                 하네스 성능 측정
  harness test                          guard 훅 테스트
  harness edit                          하네스 소스를 Claude Code로 열기
  harness dir                           저장소 경로

평소 사용은 그냥 아무 폴더에서 `claude` 실행 — 하네스는 자동 적용됨.
'@ | Write-Output
  }
}

