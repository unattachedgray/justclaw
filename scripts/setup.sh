#!/usr/bin/env bash
#
# setup.sh — Interactive setup for justclaw.
#
# Validates prerequisites, prompts for configuration, builds, and starts services.
# Safe to re-run — skips steps that are already done.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
err()  { echo -e "${RED}[setup]${NC} $*"; }
ask()  { echo -en "${BLUE}[setup]${NC} $* "; }

# ---------------------------------------------------------------------------
# Step 1: Check prerequisites
# ---------------------------------------------------------------------------

log "Checking prerequisites..."

# Node.js >= 20
if ! command -v node &>/dev/null; then
  err "Node.js not found. Install Node.js 20+ from https://nodejs.org/"
  exit 1
fi
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  err "Node.js $NODE_VERSION found, but 20+ is required."
  exit 1
fi
log "Node.js $(node -v) OK"

# npm
if ! command -v npm &>/dev/null; then
  err "npm not found."
  exit 1
fi
log "npm $(npm -v) OK"

# Claude Code CLI
CLAUDE_BIN=""
for p in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "/usr/local/bin/claude"; do
  if [ -x "$p" ]; then
    CLAUDE_BIN="$p"
    break
  fi
done
if [ -z "$CLAUDE_BIN" ] && command -v claude &>/dev/null; then
  CLAUDE_BIN="$(command -v claude)"
fi

if [ -z "$CLAUDE_BIN" ]; then
  warn "Claude Code CLI not found."
  ask "Install it now? (Y/n)"
  read -r INSTALL_CLAUDE
  if [ "${INSTALL_CLAUDE,,}" != "n" ]; then
    log "Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code
    CLAUDE_BIN="$(command -v claude || echo "")"
    if [ -z "$CLAUDE_BIN" ]; then
      err "Installation failed. Install manually: npm install -g @anthropic-ai/claude-code"
      exit 1
    fi
  else
    warn "Claude Code CLI is required for the Discord bot. Install it before starting."
  fi
fi

if [ -n "$CLAUDE_BIN" ]; then
  log "Claude Code CLI: $CLAUDE_BIN"

  # Check if authenticated
  if ! "$CLAUDE_BIN" -p "echo test" --output-format json --max-turns 1 &>/dev/null; then
    warn "Claude Code CLI is not authenticated."
    ask "Run 'claude' now to authenticate? (Y/n)"
    read -r AUTH_CLAUDE
    if [ "${AUTH_CLAUDE,,}" != "n" ]; then
      log "Opening Claude Code for authentication..."
      log "Complete the login flow, then exit with /exit"
      "$CLAUDE_BIN"
    else
      warn "Authenticate later by running: claude"
    fi
  else
    log "Claude Code CLI authenticated OK"
  fi
fi

# Build tools (for better-sqlite3 native addon)
if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
  warn "Build tools (make, g++) not found. Needed for better-sqlite3."
  if command -v apt-get &>/dev/null; then
    ask "Install build-essential? (Y/n)"
    read -r INSTALL_BUILD
    if [ "${INSTALL_BUILD,,}" != "n" ]; then
      sudo apt-get update && sudo apt-get install -y build-essential python3
    fi
  else
    warn "Install build tools manually (build-essential on Debian/Ubuntu, xcode-select on macOS)"
  fi
fi

# PM2
if ! command -v pm2 &>/dev/null; then
  warn "PM2 not found (used for process management)."
  ask "Install PM2 globally? (Y/n)"
  read -r INSTALL_PM2
  if [ "${INSTALL_PM2,,}" != "n" ]; then
    npm install -g pm2
    log "PM2 installed"
  fi
fi

if command -v pm2 &>/dev/null; then
  log "PM2 $(pm2 -v 2>/dev/null || echo 'installed') OK"
fi

# ---------------------------------------------------------------------------
# Step 2: Install dependencies
# ---------------------------------------------------------------------------

log "Installing dependencies..."
npm install

# ---------------------------------------------------------------------------
# Step 3: Configure environment
# ---------------------------------------------------------------------------

if [ ! -f "$ROOT/.env" ]; then
  log "Creating .env from template..."
  cp "$ROOT/.env.example" "$ROOT/.env"

  echo ""
  log "=== Discord Bot Setup ==="
  echo ""
  echo "  To use the Discord bot, you need a Discord Application:"
  echo "  1. Go to https://discord.com/developers/applications"
  echo "  2. Click 'New Application', give it a name"
  echo "  3. Go to 'Bot' tab → click 'Reset Token' → copy the token"
  echo "  4. Under 'Privileged Gateway Intents', enable MESSAGE CONTENT"
  echo "  5. Go to 'OAuth2' → 'URL Generator'"
  echo "     - Scopes: bot"
  echo "     - Permissions: Send Messages, Read Message History, Add Reactions"
  echo "  6. Open the generated URL to add the bot to your server"
  echo ""

  ask "Enter Discord Bot Token (or press Enter to skip):"
  read -r DISCORD_TOKEN
  if [ -n "$DISCORD_TOKEN" ]; then
    sed -i "s/^DISCORD_BOT_TOKEN=.*/DISCORD_BOT_TOKEN=$DISCORD_TOKEN/" "$ROOT/.env"
    log "Discord token saved to .env"

    ask "Enter Discord channel ID(s) to respond in (comma-separated, or Enter for all):"
    read -r CHANNEL_IDS
    if [ -n "$CHANNEL_IDS" ]; then
      sed -i "s/^DISCORD_CHANNEL_IDS=.*/DISCORD_CHANNEL_IDS=$CHANNEL_IDS/" "$ROOT/.env"
    fi

    ask "Enter heartbeat channel ID (or Enter to use first channel):"
    read -r HB_CHANNEL
    if [ -n "$HB_CHANNEL" ]; then
      sed -i "s/^DISCORD_HEARTBEAT_CHANNEL_ID=.*/DISCORD_HEARTBEAT_CHANNEL_ID=$HB_CHANNEL/" "$ROOT/.env"
    fi
  else
    warn "Skipping Discord setup. Edit .env later to add DISCORD_BOT_TOKEN."
  fi

  ask "Set dashboard password (or Enter for 'changeme'):"
  read -r DASH_PASS
  if [ -n "$DASH_PASS" ]; then
    sed -i "s/^DASHBOARD_PASSWORD=.*/DASHBOARD_PASSWORD=$DASH_PASS/" "$ROOT/.env"
  fi

  echo ""
  log "=== Email / SMTP Setup (optional) ==="
  echo ""
  echo "  Used for sending daily reports and notifications."
  echo "  For Gmail: use an App Password (not your regular password)"
  echo "    → Google Account → Security → 2-Step Verification → App Passwords"
  echo ""

  ask "Enter SMTP host (e.g. smtp.gmail.com, or Enter to skip):"
  read -r SMTP_HOST_VAL
  if [ -n "$SMTP_HOST_VAL" ]; then
    sed -i "s/^SMTP_HOST=.*/SMTP_HOST=$SMTP_HOST_VAL/" "$ROOT/.env"
    sed -i "s/^SMTP_PORT=.*/SMTP_PORT=587/" "$ROOT/.env"

    ask "Enter SMTP username (email address):"
    read -r SMTP_USER_VAL
    if [ -n "$SMTP_USER_VAL" ]; then
      sed -i "s/^SMTP_USER=.*/SMTP_USER=$SMTP_USER_VAL/" "$ROOT/.env"
      sed -i "s/^SMTP_FROM=.*/SMTP_FROM=$SMTP_USER_VAL/" "$ROOT/.env"
    fi

    ask "Enter SMTP password / app password:"
    read -rs SMTP_PASS_VAL
    echo ""
    if [ -n "$SMTP_PASS_VAL" ]; then
      sed -i "s/^SMTP_PASS=.*/SMTP_PASS=$SMTP_PASS_VAL/" "$ROOT/.env"
    fi
    log "SMTP config saved to .env"
  else
    warn "Skipping email setup. Edit .env later to add SMTP_* variables."
  fi
else
  log ".env already exists, skipping configuration"
fi

# ---------------------------------------------------------------------------
# Step 4: Build
# ---------------------------------------------------------------------------

log "Building TypeScript..."
npm run build

log "Running tests..."
if npm test; then
  log "All tests passed"
else
  warn "Some tests failed — check output above. Continuing setup."
fi

# ---------------------------------------------------------------------------
# Step 5: Initialize data directory
# ---------------------------------------------------------------------------

mkdir -p "$ROOT/data/logs"
log "Data directory ready"

# ---------------------------------------------------------------------------
# Step 6: Start services (if PM2 available and Discord configured)
# ---------------------------------------------------------------------------

if command -v pm2 &>/dev/null; then
  DISCORD_TOKEN_SET=$(grep -E '^DISCORD_BOT_TOKEN=.+' "$ROOT/.env" 2>/dev/null || true)

  if [ -n "$DISCORD_TOKEN_SET" ]; then
    ask "Start justclaw services via PM2? (Y/n)"
    read -r START_PM2
    if [ "${START_PM2,,}" != "n" ]; then
      pm2 start "$ROOT/ecosystem.config.cjs"
      pm2 save
      log "Services started! Run 'pm2 list' to check status."
    fi
  else
    log "Discord not configured — skipping PM2 start."
    log "After adding DISCORD_BOT_TOKEN to .env, run: pm2 start ecosystem.config.cjs"
  fi
fi

# ---------------------------------------------------------------------------
# Step 7: Git configuration
# ---------------------------------------------------------------------------

echo ""
log "=== Git Setup ==="

if ! git config --global user.email &>/dev/null; then
  warn "Git user identity not configured."
  ask "Enter your email for git commits:"
  read -r GIT_EMAIL
  if [ -n "$GIT_EMAIL" ]; then
    git config --global user.email "$GIT_EMAIL"
  fi
  ask "Enter your name for git commits:"
  read -r GIT_NAME
  if [ -n "$GIT_NAME" ]; then
    git config --global user.name "$GIT_NAME"
  fi
  log "Git identity configured"
else
  log "Git identity: $(git config --global user.name) <$(git config --global user.email)>"
fi

# SSH key for GitHub (needed for automated report publishing)
if [ ! -f "$HOME/.ssh/id_ed25519.pub" ] && [ ! -f "$HOME/.ssh/id_rsa.pub" ]; then
  warn "No SSH key found. Needed for pushing to GitHub (report archiving, etc)."
  ask "Generate an SSH key now? (Y/n)"
  read -r GEN_SSH
  if [ "${GEN_SSH,,}" != "n" ]; then
    GIT_EMAIL=$(git config --global user.email || echo "")
    ssh-keygen -t ed25519 -C "${GIT_EMAIL:-justclaw}" -f "$HOME/.ssh/id_ed25519" -N ""
    echo ""
    log "SSH public key (add this to GitHub → Settings → SSH and GPG Keys):"
    echo ""
    cat "$HOME/.ssh/id_ed25519.pub"
    echo ""
    ask "Press Enter after adding the key to GitHub..."
    read -r
    ssh-keyscan github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null
    log "GitHub host key added to known_hosts"
  fi
else
  log "SSH key found"
  # Ensure GitHub host key is in known_hosts
  if ! ssh-keygen -F github.com &>/dev/null; then
    ssh-keyscan github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null
    log "GitHub host key added to known_hosts"
  fi
fi

# ---------------------------------------------------------------------------
# Step 8: MCP server setup
# ---------------------------------------------------------------------------

echo ""
log "=== MCP Server Setup ==="
echo ""
echo "  justclaw is also an MCP server for Claude Code CLI."
echo "  The .mcp.json in this directory auto-configures it."
echo "  Run 'claude' from this directory and justclaw tools will be available."
echo ""

# ---------------------------------------------------------------------------
# Step 9: Chrome extension
# ---------------------------------------------------------------------------

echo ""
log "=== Chrome Browser Bridge (optional) ==="
echo ""
echo "  justclaw includes a Chrome extension with 70 browser automation commands."
echo "  This lets the agent take screenshots, fill forms, extract data, and more."
echo ""
echo "  To install:"
echo "    1. Open Chrome and go to chrome://extensions"
echo "    2. Enable 'Developer mode' (toggle in top-right)"
echo "    3. Click 'Load unpacked'"
echo "    4. Select: $ROOT/browser-extension"
echo "    5. The extension icon should appear in your toolbar"
echo ""
echo "  The extension communicates with the dashboard (localhost:8787)."
echo "  Make sure the dashboard is running (pm2 list) for browser commands to work."
echo ""
ask "Press Enter to continue..."
read -r

# ---------------------------------------------------------------------------
# Step 10: Health verification
# ---------------------------------------------------------------------------

echo ""
log "=== Verifying Services ==="

HEALTH_OK=false
if command -v curl &>/dev/null; then
  for i in 1 2 3 4 5; do
    if curl -sf http://localhost:8787/health >/dev/null 2>&1; then
      HEALTH_OK=true
      break
    fi
    sleep 1
  done
fi

if [ "$HEALTH_OK" = true ]; then
  HEALTH=$(curl -s http://localhost:8787/health)
  log "Dashboard is healthy: $HEALTH"
else
  log "WARNING: Dashboard health check failed — check 'pm2 logs justclaw-dashboard'"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
log "=== Setup Complete ==="
echo ""
echo "  ┌────────────────────────────────────────────────────────┐"
echo "  │  Services                                              │"
echo "  ├────────────────────────────────────────────────────────┤"
echo "  │  Dashboard:  http://localhost:8787                     │"
echo "  │  Health:     http://localhost:8787/health              │"
echo "  │  Discord:    Bot responds in configured channels       │"
echo "  │  MCP:        Run 'claude' in this directory            │"
echo "  │  Browser:    Chrome extension (70 automation commands) │"
echo "  │  Email:      SMTP for reports & notifications          │"
echo "  └────────────────────────────────────────────────────────┘"
echo ""
echo "  Next steps:"
echo "    • Install Chrome extension: chrome://extensions → Load unpacked → browser-extension/"
echo "    • Add SSH key to GitHub for automated report publishing"
echo "    • Configure scheduled tasks (daily reports, monitors)"
echo ""
echo "  Skills available (slash commands in Claude Code):"
echo "    /dev          — Structured development lifecycle"
echo "    /notebook     — Document analysis (NotebookLM-style)"
echo "    /monitor      — Metric watching with alerts"
echo "    /build        — PRD-driven autonomous build"
echo "    /hats         — Specialized personas"
echo "    /review       — Pre-commit quality checklist"
echo "    /improve      — Research + implement better practices"
echo "    /audit        — Deep code audit"
echo ""
echo "  Useful commands:"
echo "    pm2 list                     — Check service status"
echo "    pm2 logs justclaw-discord    — View bot logs"
echo "    npm run deploy               — Safe deploy with rollback"
echo "    npm test                     — Run tests"
echo "    curl localhost:8787/health   — Verify services"
echo ""
