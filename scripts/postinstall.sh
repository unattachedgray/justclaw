#!/usr/bin/env bash
# Post-install: create .env from example if missing, print welcome message.
# Runs automatically after `npm install`.

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Create .env from example if it doesn't exist.
if [ ! -f "$DIR/.env" ] && [ -f "$DIR/.env.example" ]; then
  cp "$DIR/.env.example" "$DIR/.env"
  echo "  Created .env from .env.example — edit it with your Discord bot token."
fi

# Print welcome on first install (no dist/ yet means first time).
if [ ! -d "$DIR/dist" ]; then
  cat <<'WELCOME'

  ┌──────────────────────────────────────────────────┐
  │              justclaw installed                   │
  ├──────────────────────────────────────────────────┤
  │                                                  │
  │  Next steps:                                     │
  │                                                  │
  │  1. npm run build          Build TypeScript       │
  │  2. Edit .env              Add Discord bot token  │
  │  3. pm2 start ecosystem.config.cjs  Start services│
  │                                                  │
  │  Or just run: bash scripts/setup.sh              │
  │  for interactive guided setup.                   │
  │                                                  │
  │  MCP tools auto-register when you run `claude`   │
  │  from this directory (.mcp.json).                │
  │                                                  │
  │  Docs: README.md | docs/MCP-TOOLS.md             │
  │  Dashboard: http://localhost:8787 (after start)  │
  │  Health: http://localhost:8787/health             │
  │                                                  │
  │  49 MCP tools | 193 tests | schema v14           │
  └──────────────────────────────────────────────────┘

WELCOME
fi
