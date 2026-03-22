# /audit — Deep code audit with prioritized fixes

Thoroughly audit the specified area of the codebase for bugs, race conditions, security issues, missing error handling, and architectural problems.

## Arguments

$ARGUMENTS — file path, module name, or area to audit (e.g., "src/discord/", "process management", "all")

## Process

1. **Read all relevant files** completely — don't skim.

2. **Check each file for**:
   - **Bugs**: race conditions, null/undefined access, off-by-one, SQL injection
   - **Error handling**: missing try/catch, unhandled promises, silent failures
   - **Security**: command injection, path traversal, credential exposure
   - **Performance**: blocking calls (execSync), unbounded growth (Maps, arrays), N+1 queries
   - **Architecture**: circular dependencies, side effects in pure functions, unclear ownership

3. **Prioritize findings**: CRITICAL > HIGH > MEDIUM > LOW

4. **Fix CRITICAL and HIGH** issues immediately. Commit each fix.

5. **Report MEDIUM and LOW** as tasks for future sessions.

## Output format

| # | Severity | File:Line | Issue | Fix |
|---|----------|-----------|-------|-----|

Then implement the critical fixes and commit.
