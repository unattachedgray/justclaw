#!/usr/bin/env bash
#
# safe-deploy.sh — Build, tag, deploy, monitor, auto-rollback on crash loop.
#
# Usage: ./scripts/safe-deploy.sh [tag-message]
#
# Flow:
#   1. Build TypeScript
#   2. Run tests
#   3. Tag current commit as deploy-YYYYMMDD-HHMMSS
#   4. Restart pm2 processes
#   5. Monitor for 60s — if 3+ restarts, rollback to previous tag
#
# Immutable: do not modify this file (it's the safety net).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG_PREFIX="deploy"
MONITOR_DURATION=60
CRASH_THRESHOLD=3

log() { echo "[safe-deploy] $(date '+%H:%M:%S') $*"; }
die() { log "FATAL: $*"; exit 1; }

# Step 1: Build
log "Building TypeScript..."
npm run build || die "Build failed"

# Step 2: Run tests
log "Running tests..."
npm test || die "Tests failed"

# Step 3: Tag
TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
TAG_NAME="${TAG_PREFIX}-${TIMESTAMP}"
TAG_MSG="${1:-Deploy ${TIMESTAMP}}"
git tag -a "$TAG_NAME" -m "$TAG_MSG"
log "Tagged: $TAG_NAME"

# Step 4: Reset restart counters and restart
log "Resetting PM2 restart counters..."
pm2 reset all 2>/dev/null || true

log "Restarting PM2 processes..."
pm2 restart ecosystem.config.cjs || die "PM2 restart failed"

# Step 5: Monitor for crash loops
log "Monitoring for ${MONITOR_DURATION}s..."
DEADLINE=$((SECONDS + MONITOR_DURATION))

while [ $SECONDS -lt $DEADLINE ]; do
  sleep 5

  # Check restart counts via pm2 jlist.
  RESTARTS=$(node -e "
    const apps = JSON.parse(require('child_process').execSync('pm2 jlist', {encoding:'utf-8'}));
    const total = apps.reduce((sum, a) => sum + (a.pm2_env?.restart_time || 0), 0);
    console.log(total);
  " 2>/dev/null || echo "0")

  if [ "$RESTARTS" -ge "$CRASH_THRESHOLD" ]; then
    log "CRASH LOOP DETECTED ($RESTARTS restarts in ${SECONDS}s)"

    # Find previous deploy tag.
    PREV_TAG=$(git tag -l "${TAG_PREFIX}-*" --sort=-version:refname | sed -n '2p')

    if [ -z "$PREV_TAG" ]; then
      die "No previous deploy tag to rollback to. Manual intervention required."
    fi

    log "Rolling back to $PREV_TAG..."
    git checkout "$PREV_TAG" -- .
    npm run build || die "Rollback build failed"
    pm2 restart ecosystem.config.cjs || die "Rollback restart failed"

    # Remove the bad tag.
    git tag -d "$TAG_NAME" 2>/dev/null || true
    git checkout -- .

    log "ROLLBACK COMPLETE to $PREV_TAG"
    exit 1
  fi
done

log "Deploy stable after ${MONITOR_DURATION}s (${RESTARTS:-0} restarts). Saving PM2 state..."
pm2 save || true
log "Deploy $TAG_NAME complete."
