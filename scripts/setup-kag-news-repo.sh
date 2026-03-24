#!/bin/bash
set -e

REPO="/home/julian/temp/kag-industry-news"
REPORT_DIR="$REPO/reports/2026"

mkdir -p "$REPORT_DIR"

# Copy the Korean KAG report
cp /home/julian/temp/justclaw/scripts/kag-report-2026-03-24-kr.md "$REPORT_DIR/2026-03-24-immigration-labor-kr.md"

# Create Jekyll config for GitHub Pages
cat > "$REPO/_config.yml" << 'YAML'
title: Kennedy Access Group — Industry News
description: Daily immigration & labor market intelligence reports
theme: jekyll-theme-minimal
markdown: kramdown
plugins:
  - jekyll-relative-links
YAML

# Create README with report index
cat > "$REPO/README.md" << 'README'
# Kennedy Access Group — Industry News

Daily immigration & labor market intelligence reports, auto-generated and archived.

## Reports

### March 2026

| Date | Report | Language |
|------|--------|----------|
| 2026-03-24 | [Immigration & Labor Market Daily](reports/2026/2026-03-24-immigration-labor-kr.md) | Korean |

---

*Reports are generated daily by automated research agents and archived here for reference.*
README

# Commit and push
cd "$REPO"
git add -A
git commit -m "Archive first KAG report: 2026-03-24 Korean edition

Add Jekyll GitHub Pages config, README index, and first archived report
(immigration & labor market daily from March 24, 2026).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"

git branch -M main
git remote set-url origin git@github.com:unattachedgray/kag-industry-news.git
git push -u origin main 2>&1

echo ""
echo "✅ Done! Repository published."
echo "📄 Enable GitHub Pages: Settings → Pages → Source: Deploy from branch (main)"
echo "🔗 Site will be at: https://unattachedgray.github.io/kag-industry-news/"
