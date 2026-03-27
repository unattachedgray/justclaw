Generate a {{report_type}} report. Do NOT send email — delivery is handled automatically at the scheduled time.

1. GENERATE: {{generation_instructions}}

Never mention names in reports — they may be shared in group chats. Include proper hyperlinks to ALL source articles. Use standard markdown [text](url) format.

2. SAVE: Write the full report to /tmp/justclaw-report-{{TASK_ID}}.md. This file MUST exist when you finish.

For Discord output: use generous code blocks and markdown formatting. Suppress link previews with angle brackets (<url>).

---DELIVERY---
bash /home/julian/temp/justclaw/scripts/send-email.sh --to "{{email_to}}" --subject "{{email_subject}}" --body-file /tmp/justclaw-report-{{TASK_ID}}.md

---SCHEMA---
min_content_length: 500
required_links: true
file_output: /tmp/justclaw-report-{{TASK_ID}}.md
