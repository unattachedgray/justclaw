# Browser Bridge (Chrome Extension)

Chrome extension (`browser-extension/`) that gives justclaw full browser automation. Communicates via dashboard API — justclaw queues commands, extension executes them and posts results.

## Dashboard API Endpoints (auth-free, localhost-only)

- `POST /api/extension-commands` — queue a command or post a result
- `GET /api/extension-commands` — extension polls for pending commands
- `GET /api/extension-commands/:id` — check result of a specific command
- `POST /api/usage-calibration` — receive Claude usage data
- `GET /api/extension-status` — check if extension is connected

## How to Use (via Bash tool)

```bash
# Helper: queue a command and wait for result
function browser() {
  local CMD_ID=$(curl -s -X POST http://localhost:8787/api/extension-commands \
    -H 'Content-Type: application/json' -d "$1" | jq -r '.id')
  sleep ${2:-6}
  curl -s http://localhost:8787/api/extension-commands/$CMD_ID | jq '.result'
}
```

### Common Workflows

```bash
# Read a webpage (text, links, headings)
browser '{"type":"read_page","url":"https://example.com","screenshot":false}'

# Screenshot a page
browser '{"type":"screenshot","url":"https://example.com"}' 8

# Extract structured data from a page
browser '{"type":"extract_structured","tabId":TAB_ID,"schema":{"title":"h1","price":{"selector":".price","type":"number"},"items":{"selector":".item","type":"list","fields":{"name":"h3","link":{"selector":"a","type":"link"}}}}}'

# Extract all tables as JSON
browser '{"type":"extract_tables","tabId":TAB_ID}'

# Extract metadata (JSON-LD, OpenGraph, RSS feeds)
browser '{"type":"extract_metadata","tabId":TAB_ID}'

# Annotate interactive elements (Set-of-Mark) + screenshot
browser '{"type":"annotate_interactive","tabId":TAB_ID}' 8

# Find element by description (natural language)
browser '{"type":"find_element","tabId":TAB_ID,"description":"login button"}'

# Self-healing click (caches selector, auto-recovers)
browser '{"type":"resilient_click","tabId":TAB_ID,"name":"login-btn","description":"login button","selector":"#login"}'

# Multi-step workflow
browser '{"type":"workflow","steps":[
  {"type":"open_tab","url":"https://example.com"},
  {"type":"wait_for_selector","selector":"#form","delayMs":2000},
  {"type":"fill_form","fields":[{"selector":"#email","value":"test@test.com"}]},
  {"type":"submit_form"},
  {"type":"read_tab","textLimit":1000}
]}'

# Print page to PDF
browser '{"type":"print_pdf","url":"https://example.com"}' 8

# Emulate mobile device
browser '{"type":"emulate_device","tabId":TAB_ID,"preset":"iphone16"}'
# Presets: iphone16, iphone16pro, pixel9, ipad, ipadpro, galaxys24, desktop1080, desktop1440, laptop

# HAR capture (full network timeline)
browser '{"type":"start_har_capture","tabId":TAB_ID}'
# ... do stuff ...
browser '{"type":"stop_har_capture","tabId":TAB_ID}'

# Tab management
browser '{"type":"list_tabs"}'
browser '{"type":"adopt_tab","tabId":TAB_ID}'  # adopt existing tab for automation
```

## 70 Commands in 11 Categories

| Category | Commands |
|----------|----------|
| Tab mgmt (9) | `open_tab`, `close_tab`, `read_tab`, `navigate`, `list_tabs`, `adopt_tab`, `list_managed`, `reload_tab`, `reload_usage` |
| Screenshots (3) | `screenshot`, `screenshot_element`, `capture_sequence` |
| Interaction (9) | `click`, `hover`, `drag_drop`, `fill_form`, `submit_form`, `select_option`, `press_key`, `scroll_page`, `wait_for_selector` |
| Data extraction (6) | `read_page`, `extract_structured`, `extract_tables`, `extract_metadata`, `query_elements`, `get_styles` |
| AI agent (4) | `annotate_interactive`, `find_element`, `resilient_click`, `resilient_fill` |
| Iframe/Shadow (4) | `list_frames`, `read_frame`, `execute_in_frame`, `query_shadow_dom` |
| Debugging (6) | `get_accessibility_tree`, `get_full_accessibility_tree`, `inspect_react`, `inspect_app_state`, `detect_layout_issues`, `execute_script` |
| Capture (9) | `start_console_capture`, `get_console_logs`, `get_page_errors`, `start_network_capture`, `get_network_logs`, `start_websocket_capture`, `get_websocket_logs`, `start_har_capture`, `stop_har_capture` |
| Browser state (5) | `get_cookies`, `get_storage`, `set_storage`, `clipboard_read`, `clipboard_write` |
| Emulation (10) | `emulate_device`, `clear_emulation`, `network_throttle`, `set_geolocation`, `clear_geolocation`, `handle_dialog`, `print_pdf`, `file_upload`, `go_back`, `go_forward` |
| Utility (5) | `ping`, `status`, `extract_now`, `get_debug`, `workflow` |

## Key Commands by Phase

### Phase 1 — CDP Quick Wins
| Command | What it does |
|---------|-------------|
| `handle_dialog` | Auto-accept/dismiss alert/confirm/prompt dialogs via CDP |
| `print_pdf` | Print any page to PDF (configurable margins, orientation, page ranges) |
| `file_upload` | Set files on `<input type="file">` via CDP DOM.setFileInputFiles |
| `go_back` / `go_forward` | Browser history navigation via CDP Page.navigateToHistoryEntry |
| `clipboard_read` / `clipboard_write` | Read/write system clipboard |
| `network_throttle` | Presets: `slow3g`, `3g`, `4g`, `offline`, `none`, or custom throughput/latency |
| `set_geolocation` / `clear_geolocation` | Spoof GPS coordinates via CDP Emulation |

### Phase 2 — Browser Internals
| Command | What it does |
|---------|-------------|
| `drag_drop` | Full drag-and-drop with synthesized DragEvent sequence |
| `list_frames` / `read_frame` / `execute_in_frame` | iframe content access via webNavigation API |
| `query_shadow_dom` | Recursive shadow DOM piercing (depth 10, configurable host) |
| `start_har_capture` / `stop_har_capture` | Full HAR 1.2 network timeline with timing data |
| `get_full_accessibility_tree` | CDP Accessibility.getFullAXTree — structured element refs without screenshots |
| `emulate_device` / `clear_emulation` | 9 presets (iPhone 16, Pixel 9, iPad, Galaxy S24, desktop) + custom + touch |

### Phase 3 — AI-Agent Differentiators
| Command | What it does |
|---------|-------------|
| `extract_structured` | Schema-driven data extraction — define fields, get typed JSON from any page |
| `extract_tables` | Auto-parse HTML tables with headers into structured row objects |
| `extract_metadata` | JSON-LD, OpenGraph, Twitter Cards, RSS feeds, meta tags, canonical URL |
| `annotate_interactive` | Set-of-Mark: numbered red labels on interactive elements + screenshot (WebVoyager-style) |
| `find_element` | Natural language element search — "login button" → scored candidates with selectors |
| `resilient_click` / `resilient_fill` | Self-healing selectors: 6-strategy fallback (selector → cache → aria → text → role → tag) with persistent cache |

## Installation

Load unpacked from `browser-extension/` in `chrome://extensions` (Developer mode).
