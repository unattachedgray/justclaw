#!/bin/bash
# Deterministic git archive for scheduled report tasks.
# Usage: git-archive.sh --repo <path> --file <path> --message <commit-msg>
#
# Stages the file, commits, and pushes. Idempotent — safe to retry.
# Also updates README.md if --readme-entry is provided.

set -euo pipefail

REPO=""
FILE=""
MESSAGE=""
README_ENTRY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --repo) REPO="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    --readme-entry) README_ENTRY="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$REPO" || -z "$FILE" ]]; then
  echo "Usage: git-archive.sh --repo <path> --file <path> --message <msg>" >&2
  exit 1
fi

if [[ ! -d "$REPO" ]]; then
  echo "Repository not found: $REPO" >&2
  exit 1
fi

if [[ ! -f "$FILE" ]]; then
  echo "File not found: $FILE" >&2
  exit 1
fi

cd "$REPO"

# Stage the report file
git add "$FILE"

# Append to README.md if entry provided
if [[ -n "$README_ENTRY" && -f "README.md" ]]; then
  echo "$README_ENTRY" >> README.md
  git add README.md
fi

# Commit (skip if nothing to commit)
MSG="${MESSAGE:-Add report $(basename "$FILE")}"
if git diff --cached --quiet 2>/dev/null; then
  echo "Nothing to commit (already up to date)"
else
  git commit -m "$MSG"
  echo "Committed: $MSG"
fi

# Push
git push origin HEAD 2>&1
echo "Pushed to $(git remote get-url origin)"
