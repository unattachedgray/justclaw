Daily task, Mon-Fri. Prepare report first, then email after report is ready. Three steps:

1. RESEARCH & GENERATE: Run comprehensive web searches covering {{search_topics}}. Compile a {{language}}-language {{report_type}} daily report. Follow the format of previous reports (see {{repo_path}}/reports/{{YEAR}}/ for reference). Include: {{report_sections}}. Never mention names in reports — they may be shared in group chats. IMPORTANT: Include proper hyperlinks to ALL source articles throughout the report — both inline references and in the sources section. Use standard markdown [text](url) format.

2. ARCHIVE TO GITHUB: Write the report as markdown to {{repo_path}}/reports/{{YEAR}}/{{DATE}}-{{filename_slug}}.md. Then run:
   bash /home/julian/temp/justclaw/scripts/git-archive.sh --repo "{{repo_path}}" --file "reports/{{YEAR}}/{{DATE}}-{{filename_slug}}.md" --message "Add {{report_type}} report {{DATE}}"
   The GitHub Pages URL will be: https://unattachedgray.github.io/{{repo_name}}/reports/{{YEAR}}/{{DATE}}-{{filename_slug}}

3. EMAIL: Write the full report (with GitHub Pages link at the bottom) to /tmp/justclaw-report.md. Then run:
   bash /home/julian/temp/justclaw/scripts/send-email.sh --to "{{email_to}}" --subject "{{email_subject}}" --body-file /tmp/justclaw-report.md

For Discord output: use generous code blocks and markdown formatting. Suppress link previews with angle brackets (<url>).
