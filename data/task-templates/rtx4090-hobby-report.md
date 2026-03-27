Research and compile an English-language daily AI briefing covering industry news, expert analysis, and home hobbyist projects (single RTX 4090). Do NOT send email — delivery is handled automatically at the scheduled time.

1. RESEARCH: Run web searches covering {{search_topics}}. Find 12-18 recent, high-quality sources from the past 24-48 hours.

2. COMPILE: Write the report in THREE sections:

**PART 1 — AI News of the Day**
   - Major announcements: new model releases, company moves, funding rounds, policy/regulation
   - Research breakthroughs: notable papers, benchmarks, capabilities
   - Industry trends: partnerships, open-source milestones, platform updates
   - 5-8 items, each with a 2-3 sentence summary and source link

**PART 2 — Expert Analysis & Commentary**
   - Curate insights from leading AI commentators, researchers, and practitioners
   - Include perspectives from sources like: AI newsletters, researcher blogs/posts, tech commentary, podcast highlights
   - Summarize key arguments and contrarian takes on the day's developments
   - 3-5 items with attribution (role/affiliation, not personal names) and source links

**PART 3 — Home Lab & Hobbyist Corner (Single RTX 4090)**
   - New open-source projects, tools, and frameworks runnable on consumer hardware
   - Model finetuning breakthroughs achievable on a single 4090 (24GB VRAM)
   - AI agent systems and autonomous coding tools for local GPU setups
   - Local LLM inference optimizations (quantization, speculative decoding, etc.)
   - Notable community builds, benchmarks, and tutorials
   - VRAM optimization techniques and hardware tips
   - 4-6 items with practical relevance to a single-GPU home setup

End with a **Quick Links** section listing all source URLs.

Never mention names in reports — they may be shared in group chats. Include proper hyperlinks to ALL source articles. Use standard markdown [text](url) format.

3. ARCHIVE: Write the full report to /tmp/justclaw-report-{{TASK_ID}}.md. Then:
   - Copy to the my-reports repo: cp /tmp/justclaw-report-{{TASK_ID}}.md /home/julian/temp/my-reports/reports/{{DATE}}-ai-daily.md
   - Archive: bash /home/julian/temp/justclaw/scripts/git-archive.sh --repo /home/julian/temp/my-reports --file reports/{{DATE}}-ai-daily.md --message "AI Daily Briefing {{DATE}}" --readme-entry "| {{DATE}} | AI Daily Briefing | [report](reports/{{DATE}}-ai-daily.md) |"

4. SAVE: Verify /tmp/justclaw-report-{{TASK_ID}}.md exists. This file MUST exist when you finish.

For Discord output: use generous code blocks and markdown formatting. Suppress link previews with angle brackets (<url>).

---DELIVERY---
bash /home/julian/temp/justclaw/scripts/send-email.sh --to "{{email_to}}" --subject "{{email_subject}} — {{DATE}}" --body-file /tmp/justclaw-report-{{TASK_ID}}.md
