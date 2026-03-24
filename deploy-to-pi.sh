#!/bin/bash
# Build, deploy, and restart Hoster on the Raspberry Pi
set -e

PI_HOST="norcom@192.168.1.60"

echo "=== Building for Pi ==="
bash build-pi.sh

echo ""
echo "=== Deploying to Pi ==="
scp hoster-pi.sh "$PI_HOST":~/

echo ""
echo "=== Installing and restarting ==="
ssh "$PI_HOST" 'bash ~/hoster-pi.sh && sudo systemctl restart hoster'

echo ""
echo "=== Verifying ==="
sleep 2
ssh "$PI_HOST" 'curl -s http://localhost:3500/_admin/api/version'
echo ""
echo ""
echo "Deploy complete!"
