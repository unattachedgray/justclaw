Check {{check_target}} and report status.

1. CHECK: {{check_command}}

2. EVALUATE: {{success_criteria}}

3. REPORT: Post a concise status update to Discord. Include:
   - Current status (OK / WARNING / ALERT)
   - Key metrics or values found
   - Any changes since last check
   - Recommended action if status is not OK

{{#alert_instructions}}

Keep the response under 500 characters unless there's an issue to report in detail.
