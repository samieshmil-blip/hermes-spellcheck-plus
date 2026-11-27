// hermes-ru-spellcheck watcher (C#, no console window).
//
// The core patch has to be in place BEFORE Hermes reads its bundle, so a check
// on app start is too late. This watcher stays idle and wakes only when the app
// folder changes (i.e. an update rewrote the bundle), then re-runs
// apply-fix.cjs. It also checks once when it starts (logon).
//
// Build:  build.cmd   (uses the csc.exe that ships with .NET Framework 4.x)
// Logs:   watch.log next to this exe
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class HermesSpellWatch
{
    private static string _logPath;
    private static string _distDir;
    private static string _mainFile;
    private static string _applyScript;
    private static string _nodeExe;

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(
                _logPath,
                "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message + Environment.NewLine,
                new UTF8Encoding(true));
        }
        catch
        {
            // logging must never take the watcher down
        }
    }

    private static bool IsPatched()
    {
        try
        {
            return File.Exists(_mainFile) && File.ReadAllText(_mainFile).Contains("ru-spellcheck");
        }
        catch
        {
            return true; // unreadable file: do not spam the log
        }
    }

    private static void ApplyFix()
    {
        if (IsPatched()) return;

        Log("patch is missing (app update?) - applying");
        try
        {
            var start = new ProcessStartInfo(_nodeExe, "\"" + _applyScript + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(_applyScript)
            };

            using (var process = Process.Start(start))
            {
                if (process != null) process.WaitForExit(180000);
            }

            Log(IsPatched()
                ? "result: patched, Hermes picks it up on its next start"
                : "result: FAILED, see apply-fix.log");
        }
        catch (Exception error)
        {
            Log("error: " + error.Message);
        }
    }

    private static string FindNode(string root)
    {
        // 1) node on PATH
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var dir in path.Split(';'))
        {
            if (dir.Trim().Length == 0) continue;
            try
            {
                var candidate = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
                // malformed PATH entry
            }
        }

        // 2) the runtime Hermes ships
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var tools = Path.Combine(local, @"hermes\tools");
        try
        {
            if (Directory.Exists(tools))
            {
                var found = Directory.GetFiles(tools, "node.exe", SearchOption.AllDirectories);
                if (found.Length > 0) return found[0];
            }
        }
        catch
        {
            // ignore and fall through
        }

        // 3) a normal Node install
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var standard = Path.Combine(programFiles, @"nodejs\node.exe");
        return File.Exists(standard) ? standard : null;
    }

    private static void Main()
    {
        var root = AppDomain.CurrentDomain.BaseDirectory;
        _logPath = Path.Combine(root, "watch.log");
        _applyScript = Path.Combine(root, "apply-fix.cjs");

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        _distDir = Path.Combine(
            local,
            @"hermes\hermes-agent\apps\desktop\release\win-unpacked\resources\app.asar.unpacked\dist");
        _mainFile = Path.Combine(_distDir, "electron-main.mjs");

        _nodeExe = FindNode(root);
        if (_nodeExe == null)
        {
            Log("node.exe not found, watcher exits");
            return;
        }

        Log("watcher started (node: " + _nodeExe + ")");
        ApplyFix();

        while (true)
        {
            try
            {
                if (!Directory.Exists(_distDir))
                {
                    Log("app bundle not found, waiting");
                    System.Threading.Thread.Sleep(60000);
                    continue;
                }

                using (var watcher = new FileSystemWatcher(_distDir, "*"))
                {
                    watcher.IncludeSubdirectories = true;
                    watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.DirectoryName;
                    watcher.EnableRaisingEvents = true;

                    var change = watcher.WaitForChanged(WatcherChangeTypes.All, 3600000);
                    if (change.TimedOut) continue; // recreate the handle hourly, cheap insurance
                }

                // an update writes many files: let it settle, then check once
                System.Threading.Thread.Sleep(6000);
                ApplyFix();
            }
            catch (Exception error)
            {
                Log("watcher error: " + error.Message + " - recreating");
                System.Threading.Thread.Sleep(15000);
            }
        }
    }
}
