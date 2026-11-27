@echo off
rem Builds hermes-spell-watch.exe with the C# compiler that ships with Windows
rem (.NET Framework 4.x) - no SDK, no NuGet, nothing to install.
setlocal

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo csc.exe not found - install .NET Framework 4.x or use the prebuilt exe.
  exit /b 1
)

"%CSC%" /nologo /target:winexe /out:hermes-spell-watch.exe Watcher.cs
if errorlevel 1 exit /b 1

echo built hermes-spell-watch.exe
