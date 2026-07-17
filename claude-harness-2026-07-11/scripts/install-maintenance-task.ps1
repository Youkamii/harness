# install-maintenance-task.ps1 — local-maintenance.mjs를 Windows 예약 작업으로 등록한다.
# 무토큰 로컬 점검(훅·드리프트·메모리)을 주 1회 자동 실행. 클라우드 루틴은 ~/.claude 접근 불가라 로컬이어야 한다.
# 실행: powershell -ExecutionPolicy Bypass -File scripts\install-maintenance-task.ps1
# 제거: Unregister-ScheduledTask -TaskName "g-harness-maintenance" -Confirm:$false
#
# 창 금지 (2026-07-17 사용자 지시, 이슈 #12): node.exe(콘솔 앱)를 예약 작업이 직접 실행하면
# 로그온 세션에 까만 콘솔 창이 뜬다. wscript.exe(GUI 호스트) + run-hidden.vbs(Run 창 0)로 감싸
# 창 없이 실행하고, 출력은 cmd 리다이렉트로 로그 파일에 남긴다.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo "scripts\local-maintenance.mjs"
$vbs = Join-Path $repo "scripts\run-hidden.vbs"
$node = (Get-Command node).Source
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
$taskName = "g-harness-maintenance"

if (-not (Test-Path $script)) { throw "local-maintenance.mjs 없음: $script" }
if (-not (Test-Path $vbs)) { throw "run-hidden.vbs 없음: $vbs" }

# 로그: 매 실행의 출력을 파일로 (창이 없으므로 파일이 유일한 관측 수단)
$logDir = Join-Path $env:LOCALAPPDATA "g-harness"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir "maintenance.log"

# wscript //B: 스크립트 오류 팝업도 억제 (배치 모드). vbs가 node를 숨김 창으로 실행하고 종료 코드를 전달.
$argLine = "//B //Nologo `"$vbs`" `"$node`" `"$script`" >> `"$log`" 2>&1"
$action  = New-ScheduledTaskAction -Execute $wscript -Argument $argLine -WorkingDirectory $repo
# 매주 월요일 오전 9시. 토큰 안 쓰는 작업이라 시간대 부담 없음.
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "[maintenance] 예약 작업 '$taskName' 등록 완료 (매주 월 09:00, 창 없는 숨김 실행). 로그: $log"
Write-Host "[maintenance] 지금 즉시 한 번 실행하려면: Start-ScheduledTask -TaskName $taskName"
