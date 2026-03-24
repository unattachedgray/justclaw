# Refactoring Catalog

Reference skill for identifying code smells, mapping them to refactorings, and applying complexity thresholds. Used by architecture-reviewer and style-inspector agents.

## Complexity Thresholds

| Metric | Threshold | Action |
|--------|-----------|--------|
| Cyclomatic complexity | ≤10 per function | Extract method, simplify conditionals |
| Function length | <20 lines (ideal), ≤50 (hard limit) | Extract method |
| Class/module length | <300 lines (ideal), ≤500 (hard limit) | Extract class/module |
| Parameter count | ≤4 | Introduce parameter object |
| Nesting depth | ≤3 levels | Guard clauses, early returns, extract method |
| Return points | ≤5 per function | Restructure flow |
| Dependencies (imports) | ≤10 per file | Extract facade, split module |

## Code Smell to Refactoring Map

### Bloaters (things that grow too large)

| Smell | Detection | Refactoring | Example |
|-------|-----------|-------------|---------|
| **Long Method** | Function >50 lines | Extract Method | Split heartbeat check into per-check functions |
| **Large Class** | File >500 lines | Extract Class | Split `db.ts` if schema + queries + migrations exceed limit |
| **Long Parameter List** | >4 params | Introduce Parameter Object | `createMonitor(name, source, extractor, condition, ...)` → `createMonitor(config: MonitorConfig)` |
| **Data Clumps** | Same group of params repeated | Extract Class / Introduce Parameter Object | Discord channel + session + turn count → SessionState |
| **Primitive Obsession** | Strings/numbers used for domain concepts | Replace Primitive with Object | PID as number → ProcessId with validation |

### Object-Orientation Abusers

| Smell | Detection | Refactoring | Example |
|-------|-----------|-------------|---------|
| **Switch Statements** | switch/if-else chain on type | Replace Conditional with Polymorphism / Strategy | Extractor type switch → ExtractorStrategy interface |
| **Parallel Inheritance** | Adding subclass in A requires subclass in B | Move Method, collapse hierarchy | — |
| **Refused Bequest** | Subclass ignores parent methods | Replace Inheritance with Delegation | — |
| **Temporary Field** | Fields only set in some paths | Extract Class, Introduce Null Object | — |

### Change Preventers (make modification hard)

| Smell | Detection | Refactoring | Example |
|-------|-----------|-------------|---------|
| **Divergent Change** | One class changed for many reasons | Extract Class (SRP) | `bot.ts` handling message flow + session mgmt + process registry |
| **Shotgun Surgery** | One change requires edits across many files | Move Method, Inline Class | Adding a new MCP tool requires changes in server.ts + docs + CLAUDE.md |
| **Feature Envy** | Method uses another class's data more than its own | Move Method | — |

### Dispensables (things to remove)

| Smell | Detection | Refactoring | Example |
|-------|-----------|-------------|---------|
| **Dead Code** | Unreachable code, unused exports | Remove Dead Code | Grep for unused exports |
| **Speculative Generality** | Abstract classes/interfaces with one implementation | Collapse Hierarchy, Remove | — |
| **Duplicate Code** | Same logic in 2+ places | Extract Method, Pull Up Method | Duplicate Discord message splitting logic |
| **Comments (excessive)** | Comments that explain WHAT not WHY | Rename Method (self-documenting), Extract Method | — |
| **Lazy Class** | Class that does too little to justify existence | Inline Class | — |

### Couplers (excessive coupling)

| Smell | Detection | Refactoring | Example |
|-------|-----------|-------------|---------|
| **Feature Envy** | Method accesses another module's internals | Move Method | — |
| **Inappropriate Intimacy** | Two classes access each other's private details | Move Method, Extract Class, Hide Delegate | — |
| **Message Chains** | `a.getB().getC().getD()` | Hide Delegate | — |
| **Middle Man** | Class delegates everything | Remove Middle Man, Inline | — |

## SOLID Violation Identification

### Single Responsibility Violations

**Detection pattern**: Count the "reasons to change" for each file.

```
File has multiple responsibilities if it:
- Handles I/O AND business logic
- Manages state AND formats output
- Parses input AND validates AND processes
- Has sections separated by comment headers like "// --- Section ---"
```

**Refactoring**: Extract each responsibility into its own module. Name modules after their single responsibility (e.g., `session-persistence.ts`, `session-rotation.ts`, `identity-preamble.ts` instead of one `session-context.ts` if it exceeds 500 lines).

### Open/Closed Violations

**Detection pattern**: Adding a new variant requires modifying existing code.

```
Violation indicators:
- switch/case or if/else chains on a type discriminator
- Adding a new MCP tool requires editing server.ts registration
- Adding a new heartbeat check requires editing the check runner
- Adding a new extractor type requires editing the extractor function
```

**Refactoring**: Strategy pattern (interface + implementations), plugin registry (map of name → handler), or configuration-driven registration.

### Dependency Inversion Violations

**Detection pattern**: High-level modules import low-level implementation details.

```
Violation indicators:
- Business logic imports specific database functions directly
- Modules import concrete classes instead of interfaces
- Test files can't mock dependencies because they're hardcoded
```

**Refactoring**: Define interfaces at the boundary, inject dependencies via constructor or factory function.

## Design Pattern Mapping

When a code smell is found, map it to the appropriate design pattern:

| Situation | Pattern | Application |
|-----------|---------|-------------|
| Multiple algorithms for same task | **Strategy** | Extractors (jsonpath, regex, status_code) |
| Object creation varies by type | **Factory** | MCP tool registration |
| Notify multiple consumers of events | **Observer** | Heartbeat alert distribution |
| Wrap operations with pre/post logic | **Decorator** | Logging, timing, error handling wrappers |
| Isolate failure domains | **Circuit Breaker** | Discord bot already uses this pattern |
| Queue work for async processing | **Command** | Task queue, message coalescing |
| Cache expensive results | **Proxy/Cache** | DB query results, FTS5 searches |
| Traverse complex structures | **Iterator** | Document chunk processing |

## Priority Matrix

Combine severity and effort to prioritize refactorings:

```
                    Low Effort    Medium Effort    High Effort
High Impact    |   DO FIRST    |   DO SECOND    |   PLAN       |
Medium Impact  |   DO SECOND   |   PLAN         |   BACKLOG    |
Low Impact     |   OPTIONAL    |   BACKLOG      |   SKIP       |
```

**Impact factors**: frequency of change, number of dependents, bug history, performance on hot path.
**Effort factors**: lines of code affected, number of files to change, test coverage required, risk of regression.

## Applying to justclaw

Key areas where these patterns apply:

1. **`src/server.ts`** (MCP tool registration): if adding tools requires modifying the registration loop, consider a plugin/registry pattern
2. **`src/monitors.ts`** (extractor/condition types): switch statements on type → Strategy pattern with ExtractorStrategy and ConditionStrategy interfaces
3. **`src/discord/heartbeat-checks.ts`** (9 checks): if checks are registered in a loop, verify adding a new check is pure addition (OCP)
4. **`src/discord/bot.ts`** (message handling + session + process): potential Divergent Change smell if it handles too many responsibilities
5. **`src/db.ts`** (schema + queries + migrations + backups): potential Large Class if it exceeds 500 lines — consider splitting into schema.ts + queries.ts + migrations.ts
