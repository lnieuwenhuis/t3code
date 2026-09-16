# Install the fork on Windows

`scripts/install-windows-fork.ps1` builds **lnieuwenhuis/t3code**, branch **main**,
and silently installs the desktop app for the current Windows user. It replaces
an existing T3 Code installation, including Nightly. Close T3 Code and finish any
active agent work before installing. The script does not launch the app.

## Prerequisites

Use 64-bit PowerShell on x64 Windows. Install Git, Vite+ (`vp`), Rust with the
`x86_64-pc-windows-msvc` target, Python 3, and Visual Studio's C++ build tools,
Windows SDK, and MSVC Spectre-mitigated libraries. Follow the
[Windows build prerequisites](development.md#windows-installer-prerequisites).
Vite+ manages the Node version required by the checkout.

The script installs project dependencies automatically, but does not install or
change system tools. No administrator session is needed once those tools exist.

For an existing Visual Studio 2022 installation, the Spectre component ID is
`Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre` (see Microsoft's
[component directory](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-enterprise?view=vs-2022)).

## Build and install

Save the PowerShell script locally, inspect it, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows-fork.ps1
```

The default is a fresh shallow clone under `Documents\GitHub`. To use a clean
existing checkout instead, pass `-SourcePath C:\path\to\t3code`. In this mode the
script builds that checkout's current commit; it does not fetch or change branches.
Use `-BuildOnly` to produce the installer without replacing the installed app.

Artifacts go under `Downloads\T3Code-Fork\<version>`. `build-info.json` records
the source commit and installer SHA-256. Build directories are retained so failed
builds can be diagnosed. Rerunning the default command fetches a fresh snapshot
of main; no remote releases or source commits are published.

These local installers are unsigned. The packaged update feed points to the fork,
which must publish compatible releases for in-app updates to work. Until then,
rerun the script to update. App data is retained and may be migrated when the app
is next launched; the installer is not a backup or a data migration tool.

This build targets the native Windows backend. It does not bundle the Linux
node-pty prebuild needed for the optional WSL backend.
