' run-hidden.vbs — 콘솔 창 없이 명령을 실행하는 래퍼 (예약 작업용)
' 존재 이유: Task Scheduler가 콘솔 앱(node.exe)을 로그온 세션에서 직접 실행하면 까만 콘솔 창이
' 화면에 뜬다 (2026-07-17 사용자 지시: 작업 중 터미널 창 금지, 이슈 #12).
' wscript.exe는 GUI 스크립트 호스트라 자기 창이 없고, Run(..., 0, ...)은 자식 창을 숨긴다.
' 사용: wscript.exe //B //Nologo run-hidden.vbs <실행파일> <인수...> [>> 로그경로 2>&1]
'       인수는 %COMSPEC% /c 로 조립되므로 >> 리다이렉트가 그대로 동작한다.
' 종료 코드: 실행한 명령의 종료 코드를 그대로 전달한다 (예약 작업 LastTaskResult로 관측 가능).
Option Explicit
Dim sh, cmd, i, a, rc
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  ' 공백/따옴표가 든 인수만 다시 따옴표로 감싼다 (>>, 2>&1 같은 리다이렉트 토큰은 그대로 통과)
  If InStr(a, " ") > 0 Or InStr(a, """") > 0 Then a = """" & Replace(a, """", """""") & """"
  If cmd <> "" Then cmd = cmd & " "
  cmd = cmd & a
Next
If cmd = "" Then WScript.Quit 2
' 0 = SW_HIDE(창 숨김), True = 종료까지 대기.
' cmd 전체를 한 겹 더 따옴표로 감싼다 — cmd.exe /c는 따옴표가 여러 쌍이면 첫/끝 따옴표를
' 벗겨 "C:\Program" 같은 잘린 경로를 실행하므로, 전체 재인용이 표준 회피책이다.
rc = sh.Run("%COMSPEC% /c """ & cmd & """", 0, True)
WScript.Quit rc
