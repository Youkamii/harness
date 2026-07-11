# install-maintenance-task.ps1 — local-maintenance.mjs를 Windows 예약 작업으로 등록한다.
# 무토큰 로컬 점검(훅·드리프트·메모리)을 주 1회 자동 실행. 클라우드 루틴은 ~/.claude 접근 불가라 로컬이어야 한다.
# 실행: powershell -ExecutionPolicy Bypass -File scripts\install-maintenance-task.ps1
# 제거: Unregister-ScheduledTask -TaskName "g-harness-maintenance" -Confirm:$false

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo "scripts\local-maintenance.mjs"
$node = (Get-Command node).Source
$taskName = "g-harness-maintenance"

if (-not (Test-Path $script)) { throw "local-maintenance.mjs 없음: $script" }

# 로그를 남기도록 래핑 (실패 시에만 내용이 쌓임)
$logDir = Join-Path $env:LOCALAPPDATA "g-harness"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir "maintenance.log"

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $repo
# 매주 월요일 오전 9시. 밤새 한도를 미리 먹지 않도록 토큰 안 쓰는 작업이라 시간대 부담 없음.
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "[maintenance] 예약 작업 '$taskName' 등록 완료 (매주 월 09:00). 로그: $log"
Write-Host "[maintenance] 지금 즉시 한 번 실행하려면: Start-ScheduledTask -TaskName $taskName"
