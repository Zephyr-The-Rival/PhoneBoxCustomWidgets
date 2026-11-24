// PhoneBox Widgets launcher: starts the widget host (pythonw host\server.py) under a proper name and icon, so Windows'
// startup list and Task Manager show "PhoneBox Widgets" instead of pythonw.exe.
//
//   PhoneBoxWidgets.exe "<path to pythonw.exe>"
//
// It stays running as the host's parent and exits when the host does (install.cmd and dev.cmd restart the host by
// stopping it). Ending "PhoneBox Widgets" in Task Manager ends the host too: the host runs in a job object that closes
// with this process. Processes the host starts itself (adb, PowerShell helpers) are not part of the job ("silent
// breakaway"), so PhoneBox's own adb server is never taken down with it.
//
// install.ps1 compiles this with the C# compiler that comes with Windows (.NET Framework 4):
//   csc /target:winexe /win32icon:PhoneBoxWidgets.ico /out:PhoneBoxWidgets.exe PhoneBoxWidgets.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("PhoneBox Widgets")]             // Task Manager's name for it
[assembly: AssemblyProduct("PhoneBox Widgets")]
[assembly: AssemblyDescription("Starts the PhoneBox Widgets host")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Launcher
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint KILL_ON_JOB_CLOSE = 0x2000, SILENT_BREAKAWAY_OK = 0x1000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'));  // host\ (this is host\launcher\)
        string server = Path.Combine(dir, "server.py");
        string pythonw = args.Length > 0 ? args[0] : "pythonw.exe";

        // the job: closing this process (Task Manager's "End task") ends the host as well
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK;
        bool jobOk = job != IntPtr.Zero && SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)));

        Process host;
        try
        {
            host = Process.Start(new ProcessStartInfo(pythonw, "\"" + server + "\"")
            {
                WorkingDirectory = dir,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch (Exception)
        {
            return 2;  // pythonw not found: install.cmd passes its path; run install.cmd again
        }
        if (jobOk) AssignProcessToJobObject(job, host.Handle);
        host.WaitForExit();
        return host.ExitCode;
    }
}
