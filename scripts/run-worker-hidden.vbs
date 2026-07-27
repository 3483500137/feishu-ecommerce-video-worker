Option Explicit

Dim shell
Dim fso
Dim scriptDir
Dim ps1Path
Dim cmd
Dim index
Dim exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count > 0 Then
  ps1Path = WScript.Arguments(0)
Else
  scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
  ps1Path = fso.BuildPath(scriptDir, "run-worker.ps1")
End If

cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(ps1Path)
For index = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " " & Quote(WScript.Arguments(index))
Next

exitCode = shell.Run(cmd, 0, True)
WScript.Quit exitCode

Function Quote(value)
  Quote = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
