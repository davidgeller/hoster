#!/bin/bash
# Update a Hoster server in place from the latest GitHub release.
#
# Run this ON the server (as the user that owns ~/hoster, e.g. `david`):
#
#   curl -fsSL https://raw.githubusercontent.com/davidgeller/hoster/main/deploy/update-from-github.sh | bash
#
# or, once it has run once, simply:  bash ~/hoster/update-from-github.sh
#
# Options (environment variables):
#   HOSTER_VERSION=v2.0.1   install a specific release instead of the latest
#   HOSTER_REPO=owner/repo  use a fork
#   HOSTER_NO_RESTART=1     install but don't restart the systemd service
#
# What it does: detects the CPU architecture, downloads the matching
# hoster-<arch>.sh installer asset from the release, runs it (the installer
# preserves data/ and sites/), copies itself into ~/hoster for next time,
# restarts the `hoster` systemd service, and prints the running version.
set -euo pipefail

REPO="${HOSTER_REPO:-davidgeller/hoster}"
INSTALL_DIR="$HOME/hoster"

case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ -n "${HOSTER_VERSION:-}" ]; then
  API="https://api.github.com/repos/${REPO}/releases/tags/${HOSTER_VERSION}"
else
  API="https://api.github.com/repos/${REPO}/releases/latest"
fi

echo "=== Hoster updater ==="
echo "Repository: ${REPO}"
echo "Arch:       ${ARCH}"

# No jq dependency: pull the tag and the matching asset URL out of the JSON.
RELEASE_JSON=$(curl -fsSL -H "Accept: application/vnd.github+json" "$API")
TAG=$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
ASSET_URL=$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*hoster-'"${ARCH}"'\.sh"' | head -1 | sed 's/.*"\(https[^"]*\)"$/\1/')

if [ -z "$TAG" ]; then echo "Could not read the release from GitHub." >&2; exit 1; fi
if [ -z "$ASSET_URL" ]; then echo "Release ${TAG} has no hoster-${ARCH}.sh asset." >&2; exit 1; fi

CURRENT=""
if [ -x "$INSTALL_DIR/hoster" ] && command -v curl >/dev/null; then
  CURRENT=$(curl -fsS "http://127.0.0.1:${PORT:-3500}/_admin/api/version" 2>/dev/null | grep -o '"version": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' || true)
fi
echo "Release:    ${TAG}"
[ -n "$CURRENT" ] && echo "Running:    ${CURRENT}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "Downloading ${ASSET_URL}"
curl -fL --progress-bar -o "$TMP/hoster-${ARCH}.sh" "$ASSET_URL"

echo "Installing (data/ and sites/ are preserved)…"
bash "$TMP/hoster-${ARCH}.sh"

# Keep a copy of this updater next to the install for next time.
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  cp "${BASH_SOURCE[0]}" "$INSTALL_DIR/update-from-github.sh" 2>/dev/null || true
else
  curl -fsSL "https://raw.githubusercontent.com/${REPO}/main/deploy/update-from-github.sh" -o "$INSTALL_DIR/update-from-github.sh" 2>/dev/null || true
fi
chmod +x "$INSTALL_DIR/update-from-github.sh" 2>/dev/null || true

if [ "${HOSTER_NO_RESTART:-0}" = "1" ]; then
  echo "Installed ${TAG}. Restart when ready:  sudo systemctl restart hoster"
  exit 0
fi

if command -v systemctl >/dev/null && systemctl list-unit-files 2>/dev/null | grep -q '^hoster\.service'; then
  echo "Restarting the hoster service…"
  if [ "$(id -u)" = "0" ]; then systemctl restart hoster; else sudo systemctl restart hoster; fi
  for _ in $(seq 1 20); do
    VERSION=$(curl -fsS "http://127.0.0.1:${PORT:-3500}/_admin/api/version" 2>/dev/null | grep -o '"version": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' || true)
    if [ -n "$VERSION" ]; then
      echo "Hoster is up: build ${VERSION} (${TAG})"
      exit 0
    fi
    sleep 0.5
  done
  echo "The service was restarted but did not answer on port ${PORT:-3500} within 10s. Check:  sudo journalctl -u hoster -n 50" >&2
  exit 1
else
  echo "Installed ${TAG}. No systemd unit found — restart Hoster however you run it."
fi
