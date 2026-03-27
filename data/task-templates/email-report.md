Generate and email a {{report_type}} report.

1. GENERATE: {{generation_instructions}}

Never mention names in reports — they may be shared in group chats. Include proper hyperlinks to ALL source articles. Use standard markdown [text](url) format.

2. EMAIL: Send email to {{email_to}} using the sendEmail function from /home/julian/temp/justclaw/dist/email.js. Subject: "{{email_subject}}". Body: the full report as plain text with hyperlinks. Load .env from /home/julian/temp/justclaw/.env for SMTP config.

For Discord output: use generous code blocks and markdown formatting. Suppress link previews with angle brackets (<url>).
