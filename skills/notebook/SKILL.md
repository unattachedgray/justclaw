# /notebook — Document-grounded analysis (NotebookLM-style)

Point to a folder of documents. Justclaw ingests them, indexes with FTS5, and becomes an expert on their contents — answering questions with source citations, generating overviews, and synthesizing across documents.

## Arguments

$ARGUMENTS — `<command> <notebook> [args]`

**Commands:**

| Command | Usage | What it does |
|---------|-------|-------------|
| `create` | `/notebook create <name> <path>` | Ingest a directory into a named notebook |
| `ask` | `/notebook ask <name> <question>` | Query the notebook with source-grounded answers |
| `overview` | `/notebook overview <name>` | Generate NotebookLM-style notebook guide |
| `faq` | `/notebook faq <name>` | Generate FAQ from the sources |
| `sources` | `/notebook sources <name>` | List all indexed source files |
| `list` | `/notebook list` | List all notebooks |
| `refresh` | `/notebook refresh <name>` | Re-ingest from the same directory |
| `delete` | `/notebook delete <name>` | Remove a notebook |

## How It Works

### Ingestion (`create`)
1. Scan the directory recursively for supported text files (.md, .txt, .ts, .py, .json, etc.)
2. Skip: node_modules, .git, dist, build, hidden dirs, binary files, files >1MB
3. Split each file into chunks (~1500 tokens each, paragraph-aware, respects code blocks)
4. Store chunks in SQLite `document_chunks` table with FTS5 index
5. Decide mode:
   - **Direct mode** (< 100K tokens total): load ALL sources into context for each query
   - **Chunked mode** (>= 100K tokens): use FTS5 BM25 search to retrieve relevant chunks

### Querying (`ask`)
1. Call `notebook_query` MCP tool with the question
2. In direct mode: all sources are loaded — you have full context
3. In chunked mode: FTS5 returns top-K most relevant chunks
4. **Answer using ONLY the provided sources**
5. **Cite every factual claim** as `[source:filename:lines]`
6. If the sources don't contain the answer, say so explicitly

### Overview (`overview`)
1. Call `notebook_overview` MCP tool
2. Synthesize ALL sources into:
   - **Overview**: 2-3 paragraph summary of what the documents cover
   - **Key Topics**: 5-10 bullet points of major themes
   - **Suggested Questions**: 5 questions a reader would likely ask
   - **Per-Source Summaries**: 1-2 sentences per file

### FAQ (`faq`)
1. Call `notebook_query` with a broad query (or use overview data)
2. Generate 10 Q&A pairs from the source material
3. Each answer cites its source

## Source Citation Format

Every response MUST include inline citations:

```
The system uses WAL mode for concurrent reads [source:db.ts:257-259].
Sessions rotate daily or after 30 turns [source:session-context.ts:27-38].
```

If synthesizing across sources:
```
The architecture combines SQLite persistence [source:db.ts:1-10] with
Discord streaming [source:bot.ts:274-347] for real-time progress display.
```

## Supported File Types

**Code**: .ts, .js, .tsx, .jsx, .py, .rs, .go, .java, .rb, .c, .cpp, .h, .cs, .swift, .kt, .lua, .sh
**Docs**: .md, .txt, .html, .xml, .csv, .sql
**Config**: .json, .yaml, .yml, .toml, .ini, .cfg, .conf, .env.example
**Build**: Dockerfile, Makefile, Rakefile, Gemfile

## Guidelines

- **Source grounding is mandatory** — never answer from general knowledge when notebook sources exist
- **If sources don't cover the question** — say "The notebook sources don't contain information about X" rather than guessing
- **For code questions** — include the relevant code snippet in your answer, cited to file and line
- **For multi-source synthesis** — clearly attribute which insight came from which source
- **Re-ingest when sources change** — use `/notebook refresh <name>` to pick up new or modified files
- **One notebook per topic** — don't mix unrelated document sets

## Examples

```
/notebook create ai-papers ~/research/papers/
/notebook ask ai-papers "how do the papers compare approaches to agent memory?"
/notebook overview ai-papers
/notebook faq ai-papers

/notebook create justclaw ~/temp/justclaw/src/
/notebook ask justclaw "how does the heartbeat system detect stuck processes?"
/notebook sources justclaw
```
