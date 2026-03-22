# /hats — Apply a specialized persona

Switch into a focused mindset with structured checklists and output formats.

## Arguments

$ARGUMENTS — the hat to wear: `architect`, `code-reviewer`, `debugger`, `feature-dev`, `security-reviewer`

If no argument, list available hats with one-line descriptions.

## Available Hats

| Hat | When to Use |
|-----|-------------|
| `architect` | System design decisions, module boundaries, trade-off analysis |
| `code-reviewer` | Reviewing diffs or PRs for correctness, safety, maintainability |
| `debugger` | Systematic bug investigation — reproduce, isolate, fix, verify |
| `feature-dev` | Building new features — test-first, match existing patterns |
| `security-reviewer` | Finding vulnerabilities — OWASP checklist, injection, auth, secrets |

## Behavior

1. If no argument provided, display the table above and ask which hat to wear.
2. Read the hat definition from `hats/{hat-name}.md`.
3. Acknowledge the hat switch: "Wearing the **{Hat Name}** hat."
4. For the rest of the conversation (until the hat is removed or changed):
   - Follow the hat's **Mindset** principles
   - Use the hat's **Checklist** before completing work
   - Format output using the hat's **Output Format**
   - Avoid the hat's **Anti-Patterns**
5. To remove a hat: `/hats off` — return to normal mode.

## Notes

- Only one hat at a time. Switching hats replaces the previous one.
- Hats don't change your capabilities — they focus your approach.
- Hat definitions live in `hats/` at the project root.
