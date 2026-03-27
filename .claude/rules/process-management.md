---
paths: ["src/process-registry.ts", "src/discord/heartbeat*.ts", "src/discord/escalation.ts"]
description: Process management safety rules, kill policy, suspicious process tracking
---

# Process Management

Conservative kill policy: 3 safety layers (identity + role + grace period). Never kill interactive claude sessions. Suspicious processes tracked with 0-100 safety scores. Malfunction escalation auto-kills safe suspects during crash loops.

Full details: @docs/PROCESS-MANAGEMENT.md
