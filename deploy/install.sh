#!/bin/bash
# Hoster Raspberry Pi Installer
# This script is embedded at the top of the deploy archive.
# Usage: bash hoster-pi.sh

set -e

INSTALL_DIR="$HOME/hoster"
SCRIPT_PATH="$(realpath "$0")"
ARCHIVE_MARKER="__ARCHIVE_BELOW__"
ARCHIVE_LINE=$(grep -an "^${ARCHIVE_MARKER}$" "$SCRIPT_PATH" | tail -1 | cut -d: -f1)

echo "=== Hoster Installer for Raspberry Pi ==="
echo ""
echo "Install directory: $INSTALL_DIR"

# Preserve existing data and sites on upgrade
if [ -d "$INSTALL_DIR/data" ]; then
    echo "Preserving existing database..."
fi
if [ -d "$INSTALL_DIR/sites" ]; then
    echo "Preserving existing sites..."
fi

mkdir -p "$INSTALL_DIR"

# Extract the tar.gz payload after the marker line
tail -n +$((ARCHIVE_LINE + 1)) "$SCRIPT_PATH" | tar xz -C "$INSTALL_DIR"

chmod +x "$INSTALL_DIR/hoster"

# Ensure data and sites directories exist with proper permissions
mkdir -p "$INSTALL_DIR/data"
mkdir -p "$INSTALL_DIR/sites"
chmod 755 "$INSTALL_DIR/data"
chmod 755 "$INSTALL_DIR/sites"

echo ""
echo "Installed to $INSTALL_DIR"
echo ""

# Create systemd service file
SERVICE_FILE="$INSTALL_DIR/hoster.service"
cat > "$SERVICE_FILE" << SERVICEEOF
[Unit]
Description=Hoster - Lightweight Web Hosting Platform
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/hoster
Restart=on-failure
RestartSec=5
Environment=PORT=3500

[Install]
WantedBy=multi-user.target
SERVICEEOF

echo "Files installed:"
ls -la "$INSTALL_DIR"
echo ""
echo "--- Quick Start ---"
echo ""
echo "  # Test it:"
echo "  cd $INSTALL_DIR"
echo "  ./hoster"
echo ""
echo "  # Then open http://localhost:3500/_admin to set your password"
echo ""
echo "  # Install as systemd service (optional):"
echo "  sudo cp $SERVICE_FILE /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now hoster"
echo ""
echo "  # View logs:"
echo "  sudo journalctl -u hoster -f"
echo ""

exit 0
