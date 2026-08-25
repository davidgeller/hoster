#!/bin/bash
# Build Hoster as a single self-extracting installer for any Linux target.
#
# Usage:
#   bash build-pi.sh                # ARM64 (Raspberry Pi, ARM VPS) — default
#   ARCH=x64 bash build-pi.sh       # x86_64 (Intel/AMD VPS, DigitalOcean default droplets)
#   ARCH=arm64 bash build-pi.sh     # explicit ARM64
#
# Output: hoster-<arch>.sh — a self-extracting installer. Copy to the target
# host and run `bash hoster-<arch>.sh`. Same installer for fresh installs and
# upgrades; data and sites are preserved.
set -e

cd "$(dirname "$0")"

ARCH="${ARCH:-arm64}"
case "$ARCH" in
  arm64|aarch64) BUN_TARGET="bun-linux-arm64"; ARCH_LABEL="arm64" ;;
  x64|x86_64|amd64) BUN_TARGET="bun-linux-x64"; ARCH_LABEL="x64" ;;
  *) echo "Unknown ARCH '$ARCH'. Use arm64 or x64." >&2; exit 1 ;;
esac

# Pre-flight: compile for THIS machine and actually boot it.
#
# The shipped binary is cross-compiled for Linux and cannot be run here, so
# "it compiled" says nothing about whether it starts. Module-initialization
# order differs between `bun run` and `bun build --compile`, and a bundled
# dependency that throws at import time takes the service down on the server
# while every local check stays green. Compiling natively and booting it is
# the cheapest way to catch that before it reaches production.
echo "=== Pre-flight: boot-testing a native build ==="
PREFLIGHT_DIR=$(mktemp -d)
mkdir -p "$PREFLIGHT_DIR/sites" "$PREFLIGHT_DIR/admin"
PREFLIGHT_PORT=39517
bun build --compile src/main.ts --outfile "$PREFLIGHT_DIR/hoster" > /dev/null
HOSTER_HOME="$PREFLIGHT_DIR" PORT=$PREFLIGHT_PORT "$PREFLIGHT_DIR/hoster" > "$PREFLIGHT_DIR/boot.log" 2>&1 &
PREFLIGHT_PID=$!
PREFLIGHT_OK=""
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PREFLIGHT_PORT/_admin/api/version" > /dev/null 2>&1; then
    PREFLIGHT_OK=1
    break
  fi
  sleep 0.5
done
kill $PREFLIGHT_PID 2>/dev/null || true
wait $PREFLIGHT_PID 2>/dev/null || true
if [ -z "$PREFLIGHT_OK" ]; then
  echo ""
  echo "BUILD ABORTED — the compiled binary did not start:" >&2
  echo "" >&2
  cat "$PREFLIGHT_DIR/boot.log" >&2
  rm -rf "$PREFLIGHT_DIR"
  exit 1
fi
rm -rf "$PREFLIGHT_DIR"
echo "Pre-flight OK — binary boots and serves."
echo ""

# Generate build version: date + incrementing build number
BUILD_VERSION=$(date +"%Y.%m.%d")-$(date +"%H%M%S")
echo "=== Building Hoster v${BUILD_VERSION} for linux-${ARCH_LABEL} ==="

# Stamp version into source (will be compiled into binary)
sed -i.bak "s/__BUILD_VERSION__/${BUILD_VERSION}/" src/index.ts
sed -i.bak "s/__BUILD_VERSION__/${BUILD_VERSION}/g" admin/index.html

# Compile standalone binary
echo "Compiling..."
BIN_NAME="hoster-linux-${ARCH_LABEL}"
bun build --compile --target=${BUN_TARGET} src/main.ts --outfile "${BIN_NAME}"

# Restore source files
mv src/index.ts.bak src/index.ts
mv admin/index.html.bak admin/index.html

# Stage files for the archive
STAGING=$(mktemp -d)
cp "${BIN_NAME}" "$STAGING/hoster"
cp -r admin "$STAGING/"

# Create tar.gz payload. COPYFILE_DISABLE=1 stops macOS tar from embedding
# AppleDouble (._*) resource-fork files and xattrs, which otherwise litter the
# install dir and spew "LIBARCHIVE.xattr" warnings when extracted on Linux.
PAYLOAD=$(mktemp)
COPYFILE_DISABLE=1 tar cz -C "$STAGING" . > "$PAYLOAD"

# Combine installer script + payload into single file
OUTPUT="hoster-${ARCH_LABEL}.sh"
cat deploy/install.sh > "$OUTPUT"
echo "__ARCHIVE_BELOW__" >> "$OUTPUT"
cat "$PAYLOAD" >> "$OUTPUT"
chmod +x "$OUTPUT"

# Cleanup
rm -rf "$STAGING" "$PAYLOAD" "${BIN_NAME}"

SIZE=$(ls -lh "$OUTPUT" | awk '{print $5}')
echo ""
echo "Done! Built: ${OUTPUT} v${BUILD_VERSION} ($SIZE)"
echo ""
echo "Deploy:"
echo "  scp $OUTPUT user@host:~/"
echo "  ssh user@host 'bash ~/$OUTPUT'"
echo "  Then: sudo systemctl restart hoster"
echo "  Verify: curl -s http://localhost:3500/_admin/api/version"
echo ""
