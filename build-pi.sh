#!/bin/bash
# Build Hoster as a single self-extracting installer for Raspberry Pi 5 (Linux ARM64)
set -e

cd "$(dirname "$0")"

# Generate build version: date + incrementing build number
BUILD_VERSION=$(date +"%Y.%m.%d")-$(date +"%H%M%S")
echo "=== Building Hoster v${BUILD_VERSION} for Raspberry Pi 5 (linux-arm64) ==="

# Stamp version into source (will be compiled into binary)
sed -i.bak "s/__BUILD_VERSION__/${BUILD_VERSION}/" src/index.ts
sed -i.bak "s/__BUILD_VERSION__/${BUILD_VERSION}/g" admin/index.html

# Compile standalone binary
echo "Compiling..."
bun build --compile --target=bun-linux-arm64 src/index.ts --outfile hoster-linux-arm64

# Restore source files
mv src/index.ts.bak src/index.ts
mv admin/index.html.bak admin/index.html

# Stage files for the archive
STAGING=$(mktemp -d)
cp hoster-linux-arm64 "$STAGING/hoster"
cp -r admin "$STAGING/"

# Create tar.gz payload
PAYLOAD=$(mktemp)
tar cz -C "$STAGING" . > "$PAYLOAD"

# Combine installer script + payload into single file
OUTPUT="hoster-pi.sh"
cat deploy/install.sh > "$OUTPUT"
echo "__ARCHIVE_BELOW__" >> "$OUTPUT"
cat "$PAYLOAD" >> "$OUTPUT"
chmod +x "$OUTPUT"

# Cleanup
rm -rf "$STAGING" "$PAYLOAD" hoster-linux-arm64

SIZE=$(ls -lh "$OUTPUT" | awk '{print $5}')
echo ""
echo "Done! Built: hoster-pi.sh v${BUILD_VERSION} ($SIZE)"
echo ""
echo "Deploy to your Pi:"
echo "  scp $OUTPUT norcom@norcom.local:~/"
echo "  ssh norcom@norcom.local 'bash ~/hoster-pi.sh'"
echo "  Then: sudo systemctl restart hoster"
echo "  Verify: curl -s http://localhost:3500/_admin/api/version"
echo ""
