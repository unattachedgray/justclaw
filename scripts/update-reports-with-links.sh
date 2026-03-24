#!/bin/bash
set -e

SCRIPTS="/home/julian/temp/justclaw/scripts"

# Update banking report
cp "$SCRIPTS/banking-report-2026-03-24-kr.md" /home/julian/temp/banking-news/reports/2026/2026-03-24-banking-daily-kr.md
cd /home/julian/temp/banking-news
git add -A
git commit -m "Add hyperlinks to all source articles in 2026-03-24 report

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main 2>&1
echo "✅ Banking report updated with hyperlinks"

# Update KAG report
cp "$SCRIPTS/kag-report-2026-03-24-kr.md" /home/julian/temp/kag-industry-news/reports/2026/2026-03-24-immigration-labor-kr.md
cd /home/julian/temp/kag-industry-news
git add -A
git commit -m "Add hyperlinks to all source articles in 2026-03-24 report

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main 2>&1
echo "✅ KAG report updated with hyperlinks"

echo ""
echo "Both reports now have clickable source links."
echo "Banking: https://unattachedgray.github.io/banking-news/reports/2026/2026-03-24-banking-daily-kr"
echo "KAG:     https://unattachedgray.github.io/kag-industry-news/reports/2026/2026-03-24-immigration-labor-kr"
