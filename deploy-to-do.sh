#!/bin/bash
# Build, deploy, and restart Hoster on the DigitalOcean droplet
set -e

DO_HOST="david@165.22.169.42"

echo "=== Building for DigitalOcean (x86_64) ==="
ARCH=x64 bash build-pi.sh

echo ""
echo "=== Deploying to $DO_HOST ==="
scp hoster-x64.sh "$DO_HOST":~/

echo ""
echo "=== Installing and restarting ==="
ssh "$DO_HOST" 'bash ~/hoster-x64.sh && sudo systemctl restart hoster'

echo ""
echo "=== Verifying ==="
sleep 2
ssh "$DO_HOST" 'curl -s http://localhost:3500/_admin/api/version'
echo ""
echo ""
echo "Deploy complete!"
