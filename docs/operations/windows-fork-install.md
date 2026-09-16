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

## One-command upstream update

The locally installed `update_t3` command runs `scripts/update-t3.ps1` with the
sibling installer and `t3-conflict-worker.ps1`. Close T3 first and run it from an
external terminal. It requires GitHub CLI authenticated as `lnieuwenhuis` and
Codex authenticated for `gpt-6-astra`, in addition to the build prerequisites.

It clones the fork's `main` into a fresh run directory, fetches
`pingdotgg/t3code`'s `main`, and merges upstream while retaining fork history.
Conflicts are announced in the terminal, then delegated to Codex Astra at medium
reasoning effort in a workspace-write sandbox. The agent edits source and runs
targeted checks; the updater stages and validates the result. It stops if the
agent fails, reports uncertainty, or exceeds 30 minutes. Progress logs and a
structured resolution report are retained with the checkout.

After a successful build, a normal push updates **lnieuwenhuis/t3code main**,
then the verified installer runs silently. This direct push is explicitly
authorized for this personal updater. It never force-pushes: concurrent changes
to the fork can reject the push and stop installation. Branch protection or
authentication errors also stop the run; they are not bypassed. Rerun to merge
a fresh snapshot. Automated resolution and build success do not prove every
application behavior; inspect the saved resolution report for consequential changes.

`update_t3 -BuildOnly` performs the local merge and build without pushing or
installing. `update_t3 -Help` prints usage. Run directories and artifacts remain
under `Documents\GitHub\t3code-updates`; failed runs are preserved for inspection.
If installation fails after the push, the terminal reports the already-built
installer path. The command does not launch T3 after installation.
