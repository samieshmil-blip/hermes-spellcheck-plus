' Hermes ru-spellcheck — держит патч подчёркивания после обновлений приложения.
' Раз в минуту проверяет собранный bundle и накладывает правку заново,
' если обновление Hermes перезаписало файлы. Окно не показывается.
' Логи: %LOCALAPPDATA%\hermes\patches\ru-spellcheck\watch.log и apply-fix.log
Dim sh, script
Set sh = CreateObject("WScript.Shell")
script = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\hermes\patches\ru-spellcheck\watch-loop.ps1"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
