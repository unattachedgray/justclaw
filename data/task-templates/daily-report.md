Daily task, Mon-Fri. Prepare report first, then email after report is ready. Three steps:

1. RESEARCH & GENERATE: Run comprehensive web searches covering {{search_topics}}. Compile a {{language}}-language {{report_type}} daily report. Follow the format of previous reports (see {{repo_path}}/reports/{{YEAR}}/ for reference). Include: {{report_sections}}. Never mention names in reports — they may be shared in group chats. IMPORTANT: Include proper hyperlinks to ALL source articles throughout the report — both inline references and in the sources section. Use standard markdown [text](url) format.

2. ARCHIVE TO GITHUB: Write the report as markdown to {{repo_path}}/reports/{{YEAR}}/{{DATE}}-{{filename_slug}}.md. Update {{repo_path}}/README.md to add a row to the report index table. Git add, commit, and push (git -C {{repo_path}}). The GitHub Pages URL for the report will be: https://unattachedgray.github.io/{{repo_name}}/reports/{{YEAR}}/{{DATE}}-{{filename_slug}}

3. EMAIL: Send email to {{email_to}} using the sendEmail function from /home/julian/temp/justclaw/dist/email.js. Subject: "{{email_subject}}". Body: the full report as plain text with hyperlinks, plus a link to the GitHub Pages archive at the bottom. Load .env from /home/julian/temp/justclaw/.env for SMTP config.

For Discord output: use generous code blocks and markdown formatting. Suppress link previews with angle brackets (<url>).
