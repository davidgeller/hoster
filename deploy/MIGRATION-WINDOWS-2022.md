# Migrating Hoster to Windows Server 2022

**Approach (decided in the prior session):** run the *unchanged* `bun-linux-x64`
binary inside **WSL2** (a lightweight Linux VM). No native-Windows build. The same
`hoster-x64.sh` artifact you ship to the Hostinger VPS runs as-is.

## Why WSL2 and not native Windows

Hoster has three POSIX dependencies that are broken or privileged on native Windows:

1. **Runtime symlinks** — `_current` -> active version dir, created on every upload
   and rebuilt on self-heal (`src/sites.ts:228`, `symlinkSync`). Core to serving.
2. **Shelled-out POSIX tools at runtime** — backup/restore calls `zip`, `unzip`,
   and `cp -r` directly (`src/backup.ts:247,340,415,460`). Not present on stock Windows.
3. **systemd** — the installer drops `hoster.service` (`deploy/install.sh:42`).

WSL2 gives a real Linux kernel + systemd, so none of this needs porting.

## Critical gotcha: keep data on ext4, never on /mnt/c

Hoster's data MUST live on the WSL2 ext4 filesystem (the distro's home, e.g.
`~/hoster`). SQLite WAL locking and symlinks across the Windows drive boundary
(`/mnt/c`) are slow and semi-broken. The installer extracts to `$HOME/hoster`
inside the distro, which is correct — don't relocate it to a Windows path.

---

## Server-2022-specific caveats (NOT yet handled by setup-windows.ps1)

### 1. Use a normal admin user, NOT the built-in Administrator
The built-in `Administrator` account cannot run WSL2. Create a normal user with
administrator privileges and do the install / run the service under that account.

### 2. Headless auto-start — the script's logon task will NOT fire on a server
`setup-windows.ps1` registers an **`-AtLogOn`** scheduled task. A headless server
that nobody signs into never fires that trigger, so Hoster won't come back after a
reboot. Replace it with one of:

- **Task Scheduler at startup, "Run whether user is logged on or not"**, configured
  to run *as the specific user that owns the WSL distro* (stored credentials). WSL
  distros are registered per-Windows-user, so do NOT run the task as `SYSTEM` — a
  SYSTEM task won't see a distro installed under your user profile.
- **NSSM** (Non-Sucking Service Manager) wrapping `wsl -d Ubuntu -u root -- systemctl is-active hoster`
  as a real auto-start Windows service, again under the distro-owning user.

`.wslconfig [boot] command=` only runs a command *after* WSL boots — it does not
boot the VM at Windows startup, so you still need the Windows-side trigger above.

### 3. Server Core (no Desktop Experience)
`wsl --install` works but prints two errors that are safe to ignore. Make sure the
machine is patched to at least KB 5014678 (June 2022 cumulative) for WSL2 support.

---

## Runbook

### Phase 0 — Prep (do before touching the server)
- [ ] On a machine with Bun: `ARCH=x64 bash build-pi.sh` -> produces `hoster-x64.sh`.
- [ ] Take a fresh backup from the current prod VPS (admin panel -> Backup, or copy
      `~/hoster/data/hoster.db` + `~/hoster/sites/`).
- [ ] Note current version: `curl -s http://<prod>/_admin/api/version`.

### Phase 1 — Stand up WSL2 on the server
- [ ] Patch Windows Server 2022 fully (Check for Updates; verify KB 5014678+).
- [ ] Sign in as a *normal* admin user (not built-in Administrator).
- [ ] Elevated PowerShell: `wsl --install` (reboots may be required).
- [ ] After reboot, finish the Ubuntu user creation prompt.
- [ ] Confirm WSL2: `wsl -l -v` shows the distro at VERSION 2.

### Phase 2 — Install Hoster
- [ ] Copy `hoster-x64.sh` to the server.
- [ ] Run `powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1`
      (optionally `-LanExpose` for LAN reach, `-Port <n>` to change from 3500).
- [ ] This enables systemd in WSL, runs the installer into ext4 `$HOME/hoster`,
      and installs+starts the systemd service.

### Phase 3 — Migrate data
- [ ] Stop the new service: `wsl -d Ubuntu -- sudo systemctl stop hoster`.
- [ ] Copy the prod `hoster.db` and `sites/` into `~/hoster/data/` and `~/hoster/sites/`
      *inside the distro's ext4* (use `\\wsl$\Ubuntu\home\<user>\hoster`, or scp into WSL).
- [ ] Restart: `wsl -d Ubuntu -- sudo systemctl restart hoster`.
- [ ] The startup self-heal rebuilds `_current` symlinks from the DB automatically.

### Phase 4 — Fix headless auto-start (see caveat #2)
- [ ] Replace the `-AtLogOn` `HosterWSL` task with a startup task that runs whether
      logged on or not, under the distro-owning user — OR install NSSM as above.
- [ ] Reboot the server with nobody logged in; confirm Hoster comes back up.

### Phase 5 — Verify & cut over
- [ ] `curl -s http://localhost:3500/_admin/api/version` returns the expected version.
- [ ] Spot-check a few sites and the admin panel.
- [ ] If reverse-proxied / Cloudflare-fronted: Hoster relies on `cf-connecting-ip` /
      `cf-ipcountry` headers for analytics — make sure the proxy forwards equivalents.
- [ ] Repoint DNS / tunnel to the new host only after the above passes.

## Rollback
The old VPS stays untouched until DNS cutover. To roll back, repoint DNS/tunnel
back to it. Keep the Phase-0 backup off-box.
