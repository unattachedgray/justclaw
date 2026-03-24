#!/bin/bash
set -e

REPO="/home/julian/temp/banking-news"
REPORT_DIR="$REPO/reports/2026"
REPORT_SRC="/home/julian/temp/justclaw/scripts/banking-report-2026-03-24-kr.md"

mkdir -p "$REPORT_DIR"

# Copy the Korean banking report
cp "$REPORT_SRC" "$REPORT_DIR/2026-03-24-banking-daily-kr.md"

# Create Jekyll config for GitHub Pages
cat > "$REPO/_config.yml" << 'YAML'
title: Banking Industry Daily
description: Daily banking industry intelligence reports
theme: jekyll-theme-minimal
markdown: kramdown
plugins:
  - jekyll-relative-links
YAML

# Create README with report index
cat > "$REPO/README.md" << 'README'
# Banking Industry Daily

Daily banking industry intelligence reports, auto-generated and archived.

## Reports

### March 2026

| Date | Report | Language |
|------|--------|----------|
| 2026-03-24 | [Banking Industry Daily](reports/2026/2026-03-24-banking-daily-kr.md) | Korean |

---

*Reports are generated daily by automated research agents and archived here for reference.*
README

# Commit and push
cd "$REPO"
git add -A
git commit -m "Archive first banking report: 2026-03-24 Korean edition

Add Jekyll GitHub Pages config, README index, and first archived report
(Korean banking industry daily from March 24, 2026).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"

# Push (try main first, then master)
git branch -M main
git push -u origin main 2>&1

echo ""
echo "✅ Done! Repository published."
echo "📄 Enable GitHub Pages: Settings → Pages → Source: Deploy from branch (main)"
echo "🔗 Site will be at: https://unattachedgray.github.io/banking-news/"
