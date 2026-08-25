<#
.SYNOPSIS
  Provision / upgrade Hoster on a Windows box, running inside WSL2.

.DESCRIPTION
  Hoster is a single bun-linux-x64 binary that relies on POSIX symlinks and the
  zip/unzip/cp/mv system tools. Those don't exist (or need Administrator) on
  native Windows, so the supported, fastest-to-stand-up, near-native option is
  to run the *unchanged* Linux binary inside WSL2.

  CRITICAL: Hoster's data MUST live on the WSL2 ext4 filesystem (the distro's
  Linux home, e.g. ~/hoster). Never put it under /mnt/c — SQLite WAL locking and
  symlinks over the Windows drive boundary are slow and semi-broken. The bundled
  installer extracts to $HOME/hoster inside the distro, which is correct; this
  script does not relocate it.

  This is NOT a build script. Build the artifact on a machine with Bun:
      ARCH=x64 bash build-pi.sh        # produces hoster-x64.sh
  then copy hoster-x64.sh next to this script (or pass -Installer) and run this
  on the Windows box from an elevated PowerShell:
      powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1

.PARAMETER Installer
  Path to the hoster-<arch>.sh self-extracting installer. Defaults to
  hoster-x64.sh sitting beside this script.

.PARAMETER Distro
  WSL distribution name to use/install. Default: Ubuntu.

.PARAMETER Port
  Port Hoster listens on inside WSL. Default: 3500. localhost is auto-forwarded
  to Windows; use -LanExpose to also reach it from other machines on the LAN.

.PARAMETER LanExpose
  Add a netsh portproxy so the service is reachable at the Windows host's LAN IP,
  not just localhost. Requires elevation.
#>
[CmdletBinding()]
param(
    [string]$Installer = (Join-Path $PSScriptRoot '..\hoster-x64.sh'),
    [string]$Distro    = 'Ubuntu',
    [int]$Port         = 3500,
    [switch]$LanExpose
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!!  $m" -ForegroundColor Yellow }

# --- 1. Ensure WSL2 + the target distro are present -------------------------
Info "Checking WSL..."
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL is not installed. Run 'wsl --install' (reboots required), then re-run this script."
}

# Is the distro registered? `wsl -l -q` lists installed distros (UTF-16, so trim).
$installed = (wsl.exe -l -q) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($installed -notcontains $Distro) {
    Info "Distro '$Distro' not found — installing (this may prompt to create a Linux user)..."
    wsl.exe --install -d $Distro
    Warn "If this is a fresh distro install, finish the Linux user setup, then re-run this script."
    return
}

# Force WSL2 (not v1 — v1 has no real kernel, worse perf and no systemd).
wsl.exe --set-version $Distro 2 2>$null | Out-Null

# --- 2. Enable systemd inside the distro ------------------------------------
# Hoster's installer drops a systemd unit; WSL2 runs systemd only when wsl.conf
# opts in. Write it idempotently, then schedule a shutdown so it takes effect.
Info "Ensuring systemd is enabled in $Distro..."
$wslConf = @'
[boot]
systemd=true
'@
# Append the [boot] stanza only if systemd isn't already enabled.
$needsRestart = $false
$hasSystemd = (wsl.exe -d $Distro -u root -- bash -lc "grep -qs '^systemd=true' /etc/wsl.conf && echo yes || echo no").Trim()
if ($hasSystemd -ne 'yes') {
    wsl.exe -d $Distro -u root -- bash -lc "printf '%s\n' '$wslConf' >> /etc/wsl.conf"
    $needsRestart = $true
}

# --- 3. Copy the installer into the distro's ext4 home and run it ------------
if (-not (Test-Path $Installer)) {
    throw "Installer not found: $Installer`nBuild it first with: ARCH=x64 bash build-pi.sh"
}
$Installer = (Resolve-Path $Installer).Path
Info "Staging installer ($([IO.Path]::GetFileName($Installer))) into $Distro..."

# Translate the Windows path to a /mnt/... path WSL can read, copy into ext4
# ($HOME inside the distro), then run the existing self-extracting installer.
$winPathForWsl = (wsl.exe -d $Distro -- wslpath -a "$Installer").Trim()
wsl.exe -d $Distro -- bash -lc "cp '$winPathForWsl' ~/hoster-install.sh && bash ~/hoster-install.sh"

# --- 4. Install + (re)start the systemd service -----------------------------
# The installer writes ~/hoster/hoster.service. Activate it. PORT override goes
# via a drop-in so we don't edit the generated unit.
Info "Installing systemd service (PORT=$Port)..."
$svc = @"
set -e
sudo cp ~/hoster/hoster.service /etc/systemd/system/hoster.service
sudo mkdir -p /etc/systemd/system/hoster.service.d
printf '[Service]\nEnvironment=PORT=$Port\n' | sudo tee /etc/systemd/system/hoster.service.d/port.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now hoster
sudo systemctl restart hoster
"@
if ($needsRestart) {
    Warn "systemd was just enabled — restarting the WSL distro so it boots with PID 1 = systemd."
    wsl.exe --shutdown
    Start-Sleep -Seconds 3
}
wsl.exe -d $Distro -- bash -lc $svc

# --- 5. Auto-start at Windows login -----------------------------------------
# WSL2 shuts the VM down when no process holds it open. A logon scheduled task
# that pokes the distro keeps systemd (and Hoster) running after sign-in.
Info "Registering logon auto-start task 'HosterWSL'..."
$action  = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -u root -- systemctl is-active hoster"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'HosterWSL' -Action $action -Trigger $trigger -Settings $set -Force | Out-Null

# --- 6. Optional: expose on the LAN -----------------------------------------
if ($LanExpose) {
    Info "Adding netsh portproxy for LAN access on port $Port..."
    netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=127.0.0.1 | Out-Null
    netsh advfirewall firewall add rule name="Hoster $Port" dir=in action=allow protocol=TCP localport=$Port | Out-Null
}

# --- 7. Verify --------------------------------------------------------------
Start-Sleep -Seconds 2
Info "Verifying..."
try {
    $v = (Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/_admin/api/version" -TimeoutSec 5).Content
    Write-Host "Hoster is up. /_admin/api/version => $v" -ForegroundColor Green
} catch {
    Warn "Could not reach http://localhost:$Port/_admin/api/version yet."
    Warn "Check status: wsl -d $Distro -- sudo journalctl -u hoster -e"
}

Write-Host ""
Write-Host "Admin panel: http://localhost:$Port/_admin" -ForegroundColor Green
Write-Host "Data lives in ext4 at \\wsl`$\$Distro\home\<user>\hoster (do NOT move to C:)." -ForegroundColor Green
