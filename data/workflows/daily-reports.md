name: daily-reports
parallel: false
on_failure: continue

- template: daily-report
- template: rtx4090-hobby-report
