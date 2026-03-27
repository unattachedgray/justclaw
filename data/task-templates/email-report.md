Generate and email a {{report_type}} report.

1. GENERATE: {{generation_instructions}}

Never mention names in reports — they may be shared in group chats. Include proper hyperlinks to ALL source articles. Use standard markdown [text](url) format.

2. EMAIL: First write the full report to /tmp/justclaw-report.md. Then run:
   bash /home/julian/temp/justclaw/scripts/send-email.sh --to "{{email_to}}" --subject "{{email_subject}}" --body-file /tmp/justclaw-report.md

For Discord output: use generous code blocks and markdown formatting. Suppress link previews with angle brackets (<url>).
