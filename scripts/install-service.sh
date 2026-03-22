#!/usr/bin/env bash
# Generate and install a systemd user service for justclaw dashboard.
# Usage: ./scripts/install-service.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/justclaw-dashboard.service"

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=justclaw Dashboard
After=network.target

[Service]
ExecStart=/usr/bin/node ${PROJECT_ROOT}/dist/dashboard/app.js
WorkingDirectory=${PROJECT_ROOT}
Environment=JUSTCLAW_ROOT=${PROJECT_ROOT}
Environment=JUSTCLAW_CONFIG=${PROJECT_ROOT}/config/charlie.toml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable justclaw-dashboard.service

echo "Service installed at $SERVICE_FILE"
echo "Start with: systemctl --user start justclaw-dashboard"
echo "Status:     systemctl --user status justclaw-dashboard"
echo "Logs:       journalctl --user -u justclaw-dashboard -f"
