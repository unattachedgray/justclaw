# /code-review — Multi-agent code review with parallel domain analysis

Run a comprehensive code review using specialized agents. Each domain expert reviews independently, then a synthesizer produces the final verdict.

## Arguments

$ARGUMENTS — mode and target. Format: `[mode] [target]`

**Modes:**
- `full` (default) — all 5 reviewers: style, security, performance, architecture, synthesis
- `security-only` — security analyst only
- `performance-only` — performance analyst only
- `architecture-only` — architecture reviewer only
- `style-only` — style inspector only

**Target:** file paths, directory, or empty for all uncommitted changes (via `git diff`).

## Workflow

### Phase 1: Preparation

1. Create `_workspace/` directory if it doesn't exist
2. Determine the review scope:
   - If target is specified, use those files
   - If no target, get the diff: `git diff` for unstaged, `git diff --cached` for staged
   - If clean working tree, review the last commit: `git diff HEAD~1`
3. Write `_workspace/00_review_scope.md` with:
   - List of files to review
   - Diff summary (lines added/removed/modified)
   - Review mode selected
4. Read the target files to have their content available

### Phase 2: Domain Reviews (parallel)

Launch domain reviewer agents in parallel based on mode. Each agent receives the same scope and writes its deliverable to `_workspace/`.

**For `full` mode, launch all 4 domain agents in parallel:**

Use the Agent tool to spawn each reviewer. Pass the review scope (file list and content summary) to each agent.

**Agent: style-inspector**
```
Review the following files for style, naming, formatting, readability, and consistency.
Write your findings to _workspace/01_style_review.md.

Files to review:
[file list from Phase 1]
```

**Agent: security-analyst**
```
Review the following files for security vulnerabilities, injection risks, auth issues, and dependency CVEs.
Write your findings to _workspace/02_security_review.md.

Files to review:
[file list from Phase 1]
```

**Agent: performance-analyst**
```
Review the following files for performance issues: complexity, memory leaks, N+1 queries, caching opportunities.
Write your findings to _workspace/03_performance_review.md.

Files to review:
[file list from Phase 1]
```

**Agent: architecture-reviewer**
```
Review the following files for architectural concerns: SOLID principles, module boundaries, design patterns, testability.
Write your findings to _workspace/04_architecture_review.md.

Files to review:
[file list from Phase 1]
```

**For single-domain modes** (`security-only`, `performance-only`, etc.), launch only that one agent.

### Phase 3: Synthesis

After all domain reviews complete:

**Agent: review-synthesizer**
```
Read all domain review files in _workspace/ (01 through 04).
Deduplicate findings, resolve conflicts, and produce the final verdict.
Write the summary to _workspace/05_review_summary.md.
```

For single-domain modes, skip the synthesizer — the domain report IS the final report.

### Phase 4: Report

After synthesis completes:

1. Read `_workspace/05_review_summary.md` (or the single domain report)
2. Present the verdict and key findings to the user
3. List Must Fix items with file paths and line numbers
4. Offer to auto-fix any items that have clear remediation steps

## Output

Display the final verdict prominently:

```
## Code Review Complete

**Verdict**: [Approve / Request Changes / Reject]

**Findings**: X Must Fix, Y Should Fix, Z Nits

### Must Fix:
1. [file:line] — [issue] — [fix]
2. ...

### Should Fix:
1. [file:line] — [issue]
2. ...

Full reports in _workspace/:
- 01_style_review.md
- 02_security_review.md
- 03_performance_review.md
- 04_architecture_review.md
- 05_review_summary.md
```

## Error Handling

- If an agent fails or times out, note it in the final report and synthesize from available reviews
- If the workspace already has review files from a previous run, archive them to `_workspace/previous/` before starting
- If no files match the target, report "nothing to review" and exit
