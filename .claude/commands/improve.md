# /improve — Analyze better practices and recommend improvements

Analyze how popular, well-maintained open source projects handle the topic at hand, then recommend and implement improvements to JUSTCLAW.

## How it works

1. **Identify the area** — what are we improving? (process management, error handling, testing, docs, architecture, etc.)
2. **Research** — search GitHub for how 5-10 popular projects handle this specific area. Prioritize: projects with >1k stars, active maintenance, similar tech stack (TypeScript/Node.js).
3. **Compare** — read our current implementation and compare against what others do. Identify gaps and patterns we should adopt.
4. **Recommend** — create a prioritized list of improvements with effort estimates.
5. **Implement** — apply the highest-impact, lowest-effort improvements. Document and commit each.
6. **Record** — add remaining recommendations to the task list (justclaw task_create) for future sessions.

## Usage

```
/improve process management
/improve error handling
/improve testing strategy
/improve documentation
/improve <any topic>
```

## Guidelines

- **Deterministic before LLM** — if the improvement can be a script/tool instead of a prompt, make it a script.
- **Conservative** — don't adopt patterns that add complexity without clear benefit. Simple > clever.
- **Document** — update CLAUDE.md after each improvement. Commit separately.
- **Learn from the best** — prioritize patterns from: Linux kernel, Rust, Go, SQLite, Kubernetes, and top AI assistant projects (OpenHands, Goose, NanoClaw).

## Research template

When researching, use this structure:

```
1. Search GitHub: "<topic>" language:TypeScript stars:>500
2. Search web: "<topic> best practices 2025 2026"
3. Read 3-5 implementations from top projects
4. Extract patterns: what do they all have in common?
5. Identify gaps: what do they do that we don't?
6. Prioritize: what's highest impact for JUSTCLAW?
```

## Output

After analysis, provide:
- **Findings table**: | Project | Pattern | We have it? | Priority |
- **Implementation plan**: ordered list of changes
- **Commit each change** with clear message
- **Add remaining TODOs** to task list
