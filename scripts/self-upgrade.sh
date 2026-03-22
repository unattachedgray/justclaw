#!/usr/bin/env bash
#
# self-upgrade.sh — Pull upstream changes and deploy safely.
#
# Usage: ./scripts/self-upgrade.sh [remote] [branch]
#   remote  — git remote to pull from (default: origin)
#   branch  — branch to pull (default: current branch)
#
# Flow:
#   1. Stash local changes (if any)
#   2. Pull upstream
#   3. Install dependencies (if package.json changed)
#   4. Delegate to safe-deploy.sh (build → test → tag → restart → monitor → rollback)
#   5. Restore stashed changes

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REMOTE="${1:-origin}"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD)}"

log() { echo "[self-upgrade] $(date '+%H:%M:%S') $*"; }
die() { log "FATAL: $*"; exit 1; }

# Record current state for potential manual recovery.
BEFORE_SHA=$(git rev-parse HEAD)
log "Current commit: $BEFORE_SHA"

# Step 1: Stash local changes.
STASHED=false
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "Stashing local changes..."
  git stash push -m "self-upgrade-$(date '+%Y%m%d-%H%M%S')"
  STASHED=true
fi

# Step 2: Pull upstream.
log "Pulling $REMOTE/$BRANCH..."
if ! git pull "$REMOTE" "$BRANCH" --ff-only; then
  log "Fast-forward failed — upstream has diverged. Aborting."
  if [ "$STASHED" = true ]; then git stash pop; fi
  die "Cannot fast-forward merge. Resolve manually."
fi

AFTER_SHA=$(git rev-parse HEAD)
if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then
  log "Already up to date. Nothing to deploy."
  if [ "$STASHED" = true ]; then git stash pop; fi
  exit 0
fi

log "Updated: $BEFORE_SHA → $AFTER_SHA ($(git log --oneline "$BEFORE_SHA".."$AFTER_SHA" | wc -l) commits)"

# Step 3: Install deps if package.json changed.
if git diff --name-only "$BEFORE_SHA" "$AFTER_SHA" | grep -q 'package.json'; then
  log "package.json changed — installing dependencies..."
  npm install || die "npm install failed"
fi

# Step 4: Delegate to safe-deploy.
log "Running safe-deploy..."
if ! bash "$ROOT/scripts/safe-deploy.sh" "Upgrade from $BEFORE_SHA"; then
  log "Deploy failed — safe-deploy.sh handled rollback."
  if [ "$STASHED" = true ]; then git stash pop; fi
  exit 1
fi

# Step 5: Restore stashed changes.
if [ "$STASHED" = true ]; then
  log "Restoring stashed changes..."
  git stash pop || log "WARNING: stash pop had conflicts — resolve manually"
fi

log "Self-upgrade complete."
