' run-hidden.vbs -- runs a command with no console window (for Scheduled Tasks).
'
' Why this exists: Task Scheduler launching a console app (node.exe) in the logon
' session flashes a black console window (user directive 2026-07-17: no terminal
' windows, issue #12). wscript.exe is a GUI host with no window of its own, and
' Run(..., 0, ...) hides the child window.
'
' ASCII-ONLY COMMENTS, ON PURPOSE: wscript/cscript parse BOM-less .vbs as ANSI
' (CP949 here). UTF-8 Korean comments got re-interpreted and corrupted the code
' lines below them -- Run silently misfired and exit codes lied (measured live,
' red-review follow-up). Keep every byte in this file ASCII.
'
' red-review S1/M4: no >> redirection support -- local-maintenance.mjs writes its
' own log file. Every argument is therefore unconditionally quoted, so cmd
' metacharacters (& ^ %%) inside paths cannot split/inject commands.
'
' Why %COMSPEC% /c with an extra outer quote pair: giving WshShell.Run a command
' line that STARTS with a quote makes it drop the arguments (node started as a
' bare REPL and exited 0 -- measured live). cmd.exe strips the outer quotes back
' off (documented cmd /c quote rule), so the inner fully-quoted line survives.
'
' Usage:     wscript.exe //B //Nologo run-hidden.vbs <exe> <args...>
' Exit code: forwards the child's exit code (visible as LastTaskResult).
Option Explicit
Dim sh, cmdline, i, a, rc
Set sh = CreateObject("WScript.Shell")
cmdline = ""
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  a = """" & Replace(a, """", """""") & """"
  If cmdline <> "" Then cmdline = cmdline & " "
  cmdline = cmdline & a
Next
If cmdline = "" Then WScript.Quit 2
' 0 = SW_HIDE, True = wait for completion
rc = sh.Run("%COMSPEC% /c """ & cmdline & """", 0, True)
WScript.Quit rc
