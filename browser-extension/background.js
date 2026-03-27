// Background service worker for justclaw Browser Bridge
//
// Capabilities:
//   - Periodic usage extraction (~10 min with jitter)
//   - Command queue: justclaw can request actions via dashboard API
//   - Tab management: open/close/read pages with strict limits
//   - Page content extraction: read text/DOM from any page
//   - Screenshots: capture visible tab as PNG
//   - Capture sequences: multi-frame screenshot recording
//   - Click/interact: click elements, fill forms, submit
//   - Cookie/auth extraction: read cookies for authenticated API calls
//   - Network interception: capture XHR/fetch responses
//   - Wait for selector: wait until element appears
//   - Console capture: grab console output from pages
//   - Element screenshots: screenshot specific CSS selectors
//   - Multi-step workflows: chain commands in sequence
//   - Local/session storage access: read/write page storage
//   - Safety: max tab count, auto-cleanup, rate limiting

const DASHBOARD_BASE = 'http://localhost:8787';
const CMD_POLL_INTERVAL_MIN = 5/60; // 5 seconds

// ── Safety limits ──
const MAX_MANAGED_TABS = 5; // Max tabs the extension can have open
const TAB_TTL_MS = 600_000; // Auto-close managed tabs after 10 min (enough for workflows)
const MAX_CAPTURE_FRAMES = 20; // Max frames in a capture sequence
const MIN_CAPTURE_INTERVAL_MS = 500; // Min interval between captures
const MAX_WORKFLOW_STEPS = 20; // Max steps in a multi-step workflow
const MAX_CONSOLE_ENTRIES = 200; // Max console entries per tab
const MAX_NETWORK_ENTRIES = 100; // Max network entries per tab

// Track tabs we opened (id → {url, openedAt, purpose})
const managedTabs = new Map();

// Console logs captured per tab (tabId → [{level, text, timestamp}])
const consoleLogs = new Map();

// Network captures per tab (tabId → [{url, method, status, body, timestamp}])
const networkCaptures = new Map();

// Persistent console error log by URL — survives tab close, available on demand
// { url → [{level, text, timestamp, url}] } — kept in memory, flushed to dashboard
const MAX_PERSISTED_ERRORS_PER_URL = 50;
const MAX_PERSISTED_URLS = 20;
const persistedConsoleErrors = new Map();

function persistConsoleErrors(url, errors) {
  if (!errors || errors.length === 0) return;
  const existing = persistedConsoleErrors.get(url) || [];
  const merged = [...existing, ...errors].slice(-MAX_PERSISTED_ERRORS_PER_URL);
  persistedConsoleErrors.set(url, merged);
  // Prune oldest URLs if too many
  if (persistedConsoleErrors.size > MAX_PERSISTED_URLS) {
    const oldest = persistedConsoleErrors.keys().next().value;
    persistedConsoleErrors.delete(oldest);
  }
  // Async flush to dashboard (non-blocking)
  flushErrorsToDashboard(url, errors).catch(() => {});
}

async function flushErrorsToDashboard(url, errors) {
  try {
    await fetch(`${DASHBOARD_BASE}/api/extension-commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmdId: `console-errors-${Date.now()}`,
        result: { type: 'console_errors', url, errors, timestamp: new Date().toISOString() },
      }),
    });
  } catch { /* non-fatal — dashboard may be down */ }
}

// ── Periodic usage extraction ──

function scheduleNextExtraction() {
  const delay = 10 + (Math.random() * 4 - 2); // 8-12 min
  chrome.alarms.create('checkUsage', { delayInMinutes: delay });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkUsage') {
    triggerExtraction();
    scheduleNextExtraction();
  }
  if (alarm.name === 'pollCommands') {
    pollCommands();
  }
  if (alarm.name === 'cleanupTabs') {
    cleanupStaleTabs();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[justclaw Bridge] Installed');
  setTimeout(triggerExtraction, 5000);
  scheduleNextExtraction();
  chrome.alarms.create('pollCommands', { periodInMinutes: CMD_POLL_INTERVAL_MIN });
  chrome.alarms.create('cleanupTabs', { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  scheduleNextExtraction();
  chrome.alarms.create('pollCommands', { periodInMinutes: CMD_POLL_INTERVAL_MIN });
  chrome.alarms.create('cleanupTabs', { periodInMinutes: 1 });
});

function triggerExtraction() {
  chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' }, (tabs) => {
    if (tabs.length === 0) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'extractNow' }, (resp) => {
      if (chrome.runtime.lastError) return;
      console.log('[justclaw Bridge] Extracted usage:', resp?.session, resp?.weeklyAll);
    });
  });
}

// ── Tab management ──

function isUrlSafe(url) {
  try {
    const parsed = new URL(url);
    // Block file://, chrome://, chrome-extension:// etc
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function cleanupStaleTabs() {
  const now = Date.now();
  for (const [tabId, info] of managedTabs) {
    if (now - info.openedAt > TAB_TTL_MS) {
      console.log(`[justclaw Bridge] Auto-closing stale tab: ${info.url}`);
      chrome.tabs.remove(tabId).catch(() => {});
      managedTabs.delete(tabId);
      consoleLogs.delete(tabId);
      networkCaptures.delete(tabId);
    }
  }
}

// Clean up tracking when tabs are closed — persist any console errors first
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabInfo = managedTabs.get(tabId);
  // Try to grab console logs before cleanup
  if (tabInfo?.url) {
    try {
      const logs = await getConsoleLogs(tabId, { limit: 50 });
      if (logs?.logs) {
        const errors = logs.logs.filter(e => e.level === 'error' || e.level === 'warn');
        persistConsoleErrors(tabInfo.url, errors);
      }
    } catch { /* tab already gone, try in-memory logs */ }
  }
  managedTabs.delete(tabId);
  consoleLogs.delete(tabId);
  networkCaptures.delete(tabId);
});

async function openManagedTab(url, purpose) {
  if (!isUrlSafe(url)) {
    return { error: `URL not allowed. Only http/https URLs are supported.` };
  }
  if (managedTabs.size >= MAX_MANAGED_TABS) {
    // Close oldest managed tab
    const oldest = [...managedTabs.entries()].sort((a, b) => a[1].openedAt - b[1].openedAt)[0];
    if (oldest) {
      chrome.tabs.remove(oldest[0]).catch(() => {});
      managedTabs.delete(oldest[0]);
      consoleLogs.delete(oldest[0]);
      networkCaptures.delete(oldest[0]);
    }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  managedTabs.set(tab.id, { url, openedAt: Date.now(), purpose });
  // Auto-start console capture on every managed tab
  setTimeout(() => startConsoleCapture(tab.id).catch(() => {}), 500);
  return { tabId: tab.id, url };
}

async function readTabContent(tabId, options = {}) {
  const { includeScreenshot = false, textLimit = 5000 } = options;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (limit) => ({
        url: window.location.href,
        title: document.title,
        text: document.body.innerText.substring(0, limit),
        headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => h.textContent?.trim()).filter(Boolean).slice(0, 20),
        links: [...document.querySelectorAll('a[href]')].map((a) => ({
          text: a.textContent?.trim()?.substring(0, 80),
          href: a.href,
        })).filter((l) => l.text && l.href.startsWith('http')).slice(0, 30),
        forms: [...document.querySelectorAll('form')].map((f) => ({
          action: f.action,
          fields: [...f.querySelectorAll('input,select,textarea')].map((el) => ({
            type: el.type || el.tagName.toLowerCase(),
            name: el.name,
            id: el.id,
          })).slice(0, 20),
        })).slice(0, 5),
        meta: {
          description: document.querySelector('meta[name="description"]')?.content,
          viewport: document.querySelector('meta[name="viewport"]')?.content,
        },
      }),
      args: [textLimit],
    });
    const content = results[0]?.result || { error: 'No result from script' };

    if (includeScreenshot && !content.error) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId) {
          // Need to make the tab active for captureVisibleTab
          await chrome.tabs.update(tabId, { active: true });
          await new Promise((r) => setTimeout(r, 300)); // Brief delay for render
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          content.screenshot = dataUrl.replace(/^data:image\/png;base64,/, '');
        }
      } catch (err) {
        content.screenshotError = String(err);
      }
    }

    return content;
  } catch (err) {
    return { error: String(err) };
  }
}

// Take a screenshot of a specific tab
async function screenshotTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.windowId) return { error: 'No window for tab' };
    // Make tab active so captureVisibleTab works
    await chrome.tabs.update(tabId, { active: true });
    await new Promise((r) => setTimeout(r, 300));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return {
      screenshot: dataUrl.replace(/^data:image\/png;base64,/, ''),
      url: tab.url,
      title: tab.title,
    };
  } catch (err) {
    return { error: String(err) };
  }
}

// Capture sequence: take multiple screenshots at intervals (screen recording lite)
async function captureSequence(tabId, frameCount, intervalMs) {
  const frames = [];
  const count = Math.min(frameCount || 5, MAX_CAPTURE_FRAMES);
  const interval = Math.max(intervalMs || 1000, MIN_CAPTURE_INTERVAL_MS);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.windowId) return { error: 'No window for tab' };
    await chrome.tabs.update(tabId, { active: true });
    await new Promise((r) => setTimeout(r, 300));

    for (let i = 0; i < count; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, interval));
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        frames.push({
          frame: i,
          timestamp: Date.now(),
          screenshot: dataUrl.replace(/^data:image\/png;base64,/, ''),
        });
      } catch (err) {
        frames.push({ frame: i, timestamp: Date.now(), error: String(err) });
      }
    }

    return {
      url: tab.url,
      title: tab.title,
      frameCount: frames.length,
      frames,
    };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Click/interact with elements ──

async function clickElement(tabId, options) {
  const { selector, x, y, button = 'left', clickCount = 1 } = options;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, cx, cy, btn, count) => {
        let element;
        if (sel) {
          element = document.querySelector(sel);
          if (!element) return { error: `Element not found: ${sel}` };
        } else if (cx !== undefined && cy !== undefined) {
          element = document.elementFromPoint(cx, cy);
          if (!element) return { error: `No element at (${cx}, ${cy})` };
        } else {
          return { error: 'Need selector or x,y coordinates' };
        }

        const rect = element.getBoundingClientRect();
        const eventX = cx !== undefined ? cx : rect.x + rect.width / 2;
        const eventY = cy !== undefined ? cy : rect.y + rect.height / 2;

        const eventOpts = {
          bubbles: true,
          cancelable: true,
          clientX: eventX,
          clientY: eventY,
          button: btn === 'right' ? 2 : btn === 'middle' ? 1 : 0,
        };

        for (let i = 0; i < count; i++) {
          element.dispatchEvent(new MouseEvent('mousedown', eventOpts));
          element.dispatchEvent(new MouseEvent('mouseup', eventOpts));
          element.dispatchEvent(new MouseEvent('click', { ...eventOpts, detail: i + 1 }));
        }

        if (count === 2) {
          element.dispatchEvent(new MouseEvent('dblclick', eventOpts));
        }

        return {
          clicked: true,
          selector: sel || `elementFromPoint(${cx},${cy})`,
          tag: element.tagName.toLowerCase(),
          text: element.textContent?.trim().substring(0, 100),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      },
      args: [selector, x, y, button, clickCount],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Fill form fields ──

async function fillForm(tabId, fields) {
  // fields: [{selector, value, clear?}]
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (fieldDefs) => {
        const results = [];
        for (const f of fieldDefs) {
          const el = document.querySelector(f.selector);
          if (!el) {
            results.push({ selector: f.selector, error: 'Not found' });
            continue;
          }
          // Focus the element
          el.focus();
          el.dispatchEvent(new Event('focus', { bubbles: true }));

          if (f.clear) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }

          // Set value using native setter to trigger React/Vue state updates
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set;

          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, f.value);
          } else {
            el.value = f.value;
          }

          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));

          results.push({
            selector: f.selector,
            filled: true,
            tag: el.tagName.toLowerCase(),
            type: el.type,
          });
        }
        return { fields: results };
      },
      args: [fields],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Submit form ──

async function submitForm(tabId, selector) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const form = sel ? document.querySelector(sel) : document.querySelector('form');
        if (!form) return { error: 'Form not found' };
        // Try submit button first
        const submitBtn = form.querySelector('[type="submit"], button:not([type="button"])');
        if (submitBtn) {
          submitBtn.click();
          return { submitted: true, method: 'button_click', button: submitBtn.textContent?.trim().substring(0, 50) };
        }
        // Fall back to form.submit()
        form.submit();
        return { submitted: true, method: 'form_submit' };
      },
      args: [selector],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Wait for selector ──

async function waitForSelector(tabId, selector, timeoutMs = 10000) {
  const start = Date.now();
  const pollInterval = 300;

  while (Date.now() - start < timeoutMs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            found: true,
            tag: el.tagName.toLowerCase(),
            text: el.textContent?.trim().substring(0, 200),
            visible: rect.width > 0 && rect.height > 0,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        },
        args: [selector],
      });
      const result = results[0]?.result;
      if (result) {
        result.waitedMs = Date.now() - start;
        return result;
      }
    } catch (err) {
      return { error: String(err) };
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  return { error: `Timeout waiting for selector: ${selector}`, waitedMs: Date.now() - start };
}

// ── Cookie extraction ──

async function getCookies(domain, names) {
  try {
    const query = {};
    if (domain) query.domain = domain;
    const cookies = await chrome.cookies.getAll(query);
    let filtered = cookies;
    if (names && names.length > 0) {
      filtered = cookies.filter((c) => names.includes(c.name));
    }
    return {
      cookies: filtered.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate,
      })),
      count: filtered.length,
    };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Local/session storage access ──

async function getStorage(tabId, storageType = 'local', keys = null) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (type, keyList) => {
        const storage = type === 'session' ? sessionStorage : localStorage;
        if (keyList && keyList.length > 0) {
          const data = {};
          for (const key of keyList) {
            data[key] = storage.getItem(key);
          }
          return { data, count: Object.keys(data).length };
        }
        // Return all keys and values
        const data = {};
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          const value = storage.getItem(key);
          // Cap value length to avoid huge payloads
          data[key] = value?.length > 1000 ? value.substring(0, 1000) + '...' : value;
        }
        return { data, count: storage.length };
      },
      args: [storageType, keys],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

async function setStorage(tabId, storageType = 'local', entries = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (type, data) => {
        const storage = type === 'session' ? sessionStorage : localStorage;
        const set = [];
        for (const [key, value] of Object.entries(data)) {
          storage.setItem(key, String(value));
          set.push(key);
        }
        return { set, count: set.length };
      },
      args: [storageType, entries],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Console log capture ──

async function startConsoleCapture(tabId) {
  consoleLogs.set(tabId, []);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxEntries) => {
        if (window.__justclaw_console_hooked) return { already: true };
        window.__justclaw_console_hooked = true;
        window.__justclaw_console_log = [];

        const origConsole = {
          log: console.log,
          warn: console.warn,
          error: console.error,
          info: console.info,
          debug: console.debug,
        };

        function capture(level, args) {
          const entry = {
            level,
            text: Array.from(args).map((a) => {
              try {
                return typeof a === 'object' ? JSON.stringify(a).substring(0, 500) : String(a);
              } catch {
                return String(a);
              }
            }).join(' '),
            timestamp: Date.now(),
          };
          window.__justclaw_console_log.push(entry);
          if (window.__justclaw_console_log.length > maxEntries) {
            window.__justclaw_console_log.shift();
          }
        }

        console.log = function (...args) { capture('log', args); origConsole.log.apply(console, args); };
        console.warn = function (...args) { capture('warn', args); origConsole.warn.apply(console, args); };
        console.error = function (...args) { capture('error', args); origConsole.error.apply(console, args); };
        console.info = function (...args) { capture('info', args); origConsole.info.apply(console, args); };
        console.debug = function (...args) { capture('debug', args); origConsole.debug.apply(console, args); };

        // Also capture unhandled errors
        window.addEventListener('error', (e) => {
          capture('uncaught_error', [e.message, `at ${e.filename}:${e.lineno}:${e.colno}`]);
        });
        window.addEventListener('unhandledrejection', (e) => {
          capture('unhandled_rejection', [String(e.reason)]);
        });

        return { started: true };
      },
      args: [MAX_CONSOLE_ENTRIES],
    });
    return { started: true, tabId };
  } catch (err) {
    return { error: String(err) };
  }
}

async function getConsoleLogs(tabId, options = {}) {
  const { level, since, limit = 50 } = options;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (filterLevel, filterSince, maxResults) => {
        const logs = window.__justclaw_console_log || [];
        let filtered = logs;
        if (filterLevel) filtered = filtered.filter((e) => e.level === filterLevel);
        if (filterSince) filtered = filtered.filter((e) => e.timestamp > filterSince);
        return {
          entries: filtered.slice(-maxResults),
          total: logs.length,
          filtered: filtered.length,
        };
      },
      args: [level, since, limit],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Network request interception ──

async function startNetworkCapture(tabId, options = {}) {
  const { urlFilter, methods } = options;
  networkCaptures.set(tabId, []);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxEntries, urlPattern, methodFilter) => {
        if (window.__justclaw_network_hooked) return { already: true };
        window.__justclaw_network_hooked = true;
        window.__justclaw_network_log = [];

        const origFetch = window.fetch;
        window.fetch = async function (...args) {
          const req = args[0] instanceof Request ? args[0] : new Request(args[0], args[1]);
          const url = req.url;
          const method = req.method;

          // Apply filters
          if (urlPattern && !url.includes(urlPattern)) {
            return origFetch.apply(this, args);
          }
          if (methodFilter && methodFilter.length > 0 && !methodFilter.includes(method)) {
            return origFetch.apply(this, args);
          }

          const entry = {
            type: 'fetch',
            url,
            method,
            timestamp: Date.now(),
          };

          try {
            const response = await origFetch.apply(this, args);
            // Clone to read body without consuming it
            const clone = response.clone();
            entry.status = response.status;
            entry.statusText = response.statusText;
            entry.responseHeaders = Object.fromEntries([...response.headers.entries()].slice(0, 20));

            try {
              const contentType = response.headers.get('content-type') || '';
              if (contentType.includes('json')) {
                const body = await clone.text();
                entry.responseBody = body.substring(0, 2000);
              } else if (contentType.includes('text')) {
                const body = await clone.text();
                entry.responseBody = body.substring(0, 1000);
              } else {
                entry.responseBody = `[${contentType}, ${response.headers.get('content-length') || 'unknown'} bytes]`;
              }
            } catch { entry.responseBody = '[could not read body]'; }

            window.__justclaw_network_log.push(entry);
            if (window.__justclaw_network_log.length > maxEntries) {
              window.__justclaw_network_log.shift();
            }
            return response;
          } catch (err) {
            entry.error = String(err);
            window.__justclaw_network_log.push(entry);
            throw err;
          }
        };

        // Also intercept XMLHttpRequest
        const origXHROpen = XMLHttpRequest.prototype.open;
        const origXHRSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          this.__justclaw_method = method;
          this.__justclaw_url = String(url);
          return origXHROpen.apply(this, [method, url, ...rest]);
        };

        XMLHttpRequest.prototype.send = function (body) {
          const url = this.__justclaw_url;
          const method = this.__justclaw_method;

          if (urlPattern && !url.includes(urlPattern)) {
            return origXHRSend.apply(this, [body]);
          }
          if (methodFilter && methodFilter.length > 0 && !methodFilter.includes(method)) {
            return origXHRSend.apply(this, [body]);
          }

          this.addEventListener('load', function () {
            const entry = {
              type: 'xhr',
              url,
              method,
              status: this.status,
              statusText: this.statusText,
              responseBody: this.responseText?.substring(0, 2000),
              timestamp: Date.now(),
            };
            window.__justclaw_network_log.push(entry);
            if (window.__justclaw_network_log.length > maxEntries) {
              window.__justclaw_network_log.shift();
            }
          });

          return origXHRSend.apply(this, [body]);
        };

        return { started: true };
      },
      args: [MAX_NETWORK_ENTRIES, urlFilter || null, methods || null],
    });
    return { started: true, tabId };
  } catch (err) {
    return { error: String(err) };
  }
}

async function getNetworkLogs(tabId, options = {}) {
  const { urlFilter, statusFilter, limit = 50 } = options;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (filterUrl, filterStatus, maxResults) => {
        const logs = window.__justclaw_network_log || [];
        let filtered = logs;
        if (filterUrl) filtered = filtered.filter((e) => e.url.includes(filterUrl));
        if (filterStatus) filtered = filtered.filter((e) => e.status === filterStatus);
        return {
          entries: filtered.slice(-maxResults),
          total: logs.length,
          filtered: filtered.length,
        };
      },
      args: [urlFilter, statusFilter, limit],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Element-targeted screenshot ──

async function screenshotElement(tabId, selector) {
  try {
    // Get element bounds
    const boundsResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { error: `Element not found: ${sel}` };
        const rect = el.getBoundingClientRect();
        // Scroll element into view
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        // Re-get rect after scroll
        const newRect = el.getBoundingClientRect();
        return {
          found: true,
          rect: { x: newRect.x, y: newRect.y, width: newRect.width, height: newRect.height },
          tag: el.tagName.toLowerCase(),
          devicePixelRatio: window.devicePixelRatio || 1,
        };
      },
      args: [selector],
    });
    const bounds = boundsResults[0]?.result;
    if (!bounds || bounds.error) return bounds || { error: 'No result' };

    // Take full viewport screenshot
    const tab = await chrome.tabs.get(tabId);
    if (!tab.windowId) return { error: 'No window for tab' };
    await chrome.tabs.update(tabId, { active: true });
    await new Promise((r) => setTimeout(r, 400));

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

    // Crop using canvas in an offscreen document or by passing crop info
    // Since service workers can't use canvas, return the full screenshot with crop coordinates
    return {
      screenshot: dataUrl.replace(/^data:image\/png;base64,/, ''),
      cropRect: bounds.rect,
      devicePixelRatio: bounds.devicePixelRatio,
      tag: bounds.tag,
      url: tab.url,
      title: tab.title,
      note: 'Crop the screenshot using cropRect coordinates (multiply by devicePixelRatio for actual pixel coordinates)',
    };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Multi-step workflow ──

async function executeWorkflow(steps) {
  if (!steps || !Array.isArray(steps)) return { error: 'Steps must be an array' };
  if (steps.length > MAX_WORKFLOW_STEPS) return { error: `Max ${MAX_WORKFLOW_STEPS} steps allowed` };

  const results = [];
  let currentTabId = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`[justclaw Bridge] Workflow step ${i + 1}/${steps.length}: ${step.type}`);

    // Allow steps to reference the current tab from previous steps
    if (!step.tabId && currentTabId) {
      step.tabId = currentTabId;
    }

    let result;
    try {
      result = await executeCommand(step);
    } catch (err) {
      result = { error: `Step ${i + 1} failed: ${err}` };
    }

    results.push({
      step: i + 1,
      type: step.type,
      result,
    });

    // Track tabId from open_tab or read_page for subsequent steps
    if (result && result.tabId) {
      currentTabId = result.tabId;
    }

    // Stop workflow on error if step has stopOnError flag
    if (result?.error && step.stopOnError) {
      results.push({ stopped: true, reason: `Step ${i + 1} error with stopOnError` });
      break;
    }

    // Optional delay between steps
    if (step.delayMs && i < steps.length - 1) {
      await new Promise((r) => setTimeout(r, Math.min(step.delayMs, 10000)));
    }
  }

  // Clean up if workflow opened a tab
  if (currentTabId && managedTabs.has(currentTabId) && steps[steps.length - 1]?.autoClose !== false) {
    // Don't auto-close — let TTL handle it or explicit close_tab
  }

  return { workflow: true, stepCount: results.length, results };
}

// ── Get computed styles ──

async function getComputedStyles(tabId, selector, properties) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) return { error: `Element not found: ${sel}` };
        const computed = window.getComputedStyle(el);
        const styles = {};
        if (props && props.length > 0) {
          for (const p of props) {
            styles[p] = computed.getPropertyValue(p);
          }
        } else {
          // Return common useful properties
          const common = [
            'display', 'position', 'width', 'height', 'margin', 'padding',
            'color', 'background-color', 'font-size', 'font-family', 'font-weight',
            'border', 'visibility', 'opacity', 'overflow', 'z-index',
            'flex-direction', 'justify-content', 'align-items', 'gap',
            'grid-template-columns', 'grid-template-rows',
          ];
          for (const p of common) {
            styles[p] = computed.getPropertyValue(p);
          }
        }
        const rect = el.getBoundingClientRect();
        return {
          selector: sel,
          tag: el.tagName.toLowerCase(),
          styles,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      },
      args: [selector, properties],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Query DOM elements ──

async function queryElements(tabId, selector, options = {}) {
  const { limit = 20, attributes = [] } = options;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, maxResults, attrs) => {
        const elements = [...document.querySelectorAll(sel)].slice(0, maxResults);
        return {
          count: document.querySelectorAll(sel).length,
          elements: elements.map((el) => {
            const rect = el.getBoundingClientRect();
            const result = {
              tag: el.tagName.toLowerCase(),
              id: el.id || undefined,
              classes: el.className ? String(el.className).substring(0, 200) : undefined,
              text: el.textContent?.trim().substring(0, 200),
              visible: rect.width > 0 && rect.height > 0,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
            // Include requested attributes
            if (attrs.length > 0) {
              result.attributes = {};
              for (const attr of attrs) {
                result.attributes[attr] = el.getAttribute(attr);
              }
            }
            return result;
          }),
        };
      },
      args: [selector, limit, attributes],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Hover element ──

async function hoverElement(tabId, selector) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { error: `Element not found: ${sel}` };
        const rect = el.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
        return {
          hovered: true,
          selector: sel,
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().substring(0, 100),
        };
      },
      args: [selector],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Select dropdown option ──

async function selectOption(tabId, selector, value) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return { error: `Element not found: ${sel}` };
        if (el.tagName.toLowerCase() !== 'select') return { error: 'Element is not a <select>' };

        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, val);
        } else {
          el.value = val;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        const selectedOption = el.options[el.selectedIndex];
        return {
          selected: true,
          value: el.value,
          text: selectedOption?.textContent?.trim(),
        };
      },
      args: [selector, value],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Type keyboard keys (Enter, Tab, Escape, etc.) ──

async function pressKey(tabId, key, options = {}) {
  const { selector, modifiers = {} } = options;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, keyName, mods) => {
        const target = sel ? document.querySelector(sel) : document.activeElement || document.body;
        if (sel && !target) return { error: `Element not found: ${sel}` };

        const eventOpts = {
          key: keyName,
          code: `Key${keyName.charAt(0).toUpperCase()}${keyName.slice(1)}`,
          bubbles: true,
          cancelable: true,
          ctrlKey: !!mods.ctrl,
          shiftKey: !!mods.shift,
          altKey: !!mods.alt,
          metaKey: !!mods.meta,
        };

        // Map common key names to correct codes
        const keyMap = {
          Enter: { key: 'Enter', code: 'Enter' },
          Tab: { key: 'Tab', code: 'Tab' },
          Escape: { key: 'Escape', code: 'Escape' },
          Backspace: { key: 'Backspace', code: 'Backspace' },
          Delete: { key: 'Delete', code: 'Delete' },
          ArrowUp: { key: 'ArrowUp', code: 'ArrowUp' },
          ArrowDown: { key: 'ArrowDown', code: 'ArrowDown' },
          ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft' },
          ArrowRight: { key: 'ArrowRight', code: 'ArrowRight' },
          Space: { key: ' ', code: 'Space' },
        };

        if (keyMap[keyName]) {
          eventOpts.key = keyMap[keyName].key;
          eventOpts.code = keyMap[keyName].code;
        }

        target.dispatchEvent(new KeyboardEvent('keydown', eventOpts));
        target.dispatchEvent(new KeyboardEvent('keypress', eventOpts));
        target.dispatchEvent(new KeyboardEvent('keyup', eventOpts));

        return {
          pressed: true,
          key: keyName,
          target: target.tagName?.toLowerCase(),
        };
      },
      args: [selector, key, modifiers],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Navigate (go to URL in existing tab) ──

async function navigateTab(tabId, url) {
  if (!isUrlSafe(url)) return { error: 'URL not allowed. Only http/https URLs.' };
  try {
    await chrome.tabs.update(tabId, { url });
    // Update tracking
    if (managedTabs.has(tabId)) {
      managedTabs.get(tabId).url = url;
    }
    return { navigated: true, url, tabId };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Get page accessibility tree (a11y) ──

async function getAccessibilityTree(tabId, options = {}) {
  const { maxDepth = 5, selector } = options;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, depth) => {
        function walkTree(el, currentDepth) {
          if (currentDepth > depth) return null;
          const role = el.getAttribute('role') || el.tagName.toLowerCase();
          const node = {
            role,
            name: el.getAttribute('aria-label') || el.getAttribute('alt') || el.textContent?.trim().substring(0, 80),
            tag: el.tagName.toLowerCase(),
          };
          if (el.id) node.id = el.id;
          if (el.getAttribute('aria-expanded')) node.expanded = el.getAttribute('aria-expanded');
          if (el.getAttribute('aria-selected')) node.selected = el.getAttribute('aria-selected');
          if (el.getAttribute('aria-checked')) node.checked = el.getAttribute('aria-checked');
          if (el.getAttribute('aria-disabled')) node.disabled = el.getAttribute('aria-disabled');

          // Interactive elements
          if (['a', 'button', 'input', 'select', 'textarea'].includes(node.tag)) {
            node.interactive = true;
            if (el.type) node.type = el.type;
            if (el.href) node.href = el.href;
            if (el.value) node.value = el.value?.substring(0, 100);
          }

          const children = [];
          for (const child of el.children) {
            const childNode = walkTree(child, currentDepth + 1);
            if (childNode) children.push(childNode);
          }
          if (children.length > 0) node.children = children.slice(0, 50);
          return node;
        }

        const root = sel ? document.querySelector(sel) : document.body;
        if (!root) return { error: 'Root element not found' };
        return walkTree(root, 0);
      },
      args: [selector, maxDepth],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── WebSocket monitoring ──

async function startWebSocketCapture(tabId, options = {}) {
  const { urlFilter } = options;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxEntries, wsUrlFilter) => {
        if (window.__justclaw_ws_hooked) return { already: true };
        window.__justclaw_ws_hooked = true;
        window.__justclaw_ws_log = [];

        const OrigWebSocket = window.WebSocket;
        window.WebSocket = function (url, protocols) {
          if (wsUrlFilter && !url.includes(wsUrlFilter)) {
            return new OrigWebSocket(url, protocols);
          }

          const ws = new OrigWebSocket(url, protocols);
          const wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

          window.__justclaw_ws_log.push({
            wsId,
            type: 'open',
            url,
            timestamp: Date.now(),
          });

          const origSend = ws.send.bind(ws);
          ws.send = function (data) {
            window.__justclaw_ws_log.push({
              wsId,
              type: 'send',
              data: String(data).substring(0, 1000),
              timestamp: Date.now(),
            });
            if (window.__justclaw_ws_log.length > maxEntries) {
              window.__justclaw_ws_log.shift();
            }
            return origSend(data);
          };

          ws.addEventListener('message', (e) => {
            window.__justclaw_ws_log.push({
              wsId,
              type: 'receive',
              data: String(e.data).substring(0, 1000),
              timestamp: Date.now(),
            });
            if (window.__justclaw_ws_log.length > maxEntries) {
              window.__justclaw_ws_log.shift();
            }
          });

          ws.addEventListener('close', (e) => {
            window.__justclaw_ws_log.push({
              wsId,
              type: 'close',
              code: e.code,
              reason: e.reason,
              timestamp: Date.now(),
            });
          });

          ws.addEventListener('error', () => {
            window.__justclaw_ws_log.push({
              wsId,
              type: 'error',
              timestamp: Date.now(),
            });
          });

          return ws;
        };
        // Preserve prototype
        window.WebSocket.prototype = OrigWebSocket.prototype;
        window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
        window.WebSocket.OPEN = OrigWebSocket.OPEN;
        window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
        window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

        return { started: true };
      },
      args: [MAX_NETWORK_ENTRIES, urlFilter || null],
    });
    return { started: true, tabId };
  } catch (err) {
    return { error: String(err) };
  }
}

async function getWebSocketLogs(tabId, options = {}) {
  const { limit = 50, type } = options;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxResults, filterType) => {
        const logs = window.__justclaw_ws_log || [];
        let filtered = logs;
        if (filterType) filtered = filtered.filter((e) => e.type === filterType);
        return {
          entries: filtered.slice(-maxResults),
          total: logs.length,
          filtered: filtered.length,
        };
      },
      args: [limit, type],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── React DevTools Integration ──

async function inspectReact(tabId, options = {}) {
  const { selector, maxDepth = 6, includeHooks = true, includeState = true } = options;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, depth, hooks, state) => {
        // Find React fiber from a DOM element
        function getFiber(el) {
          const key = Object.keys(el).find(
            (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
          );
          return key ? el[key] : null;
        }

        // Extract component info from a fiber node
        function fiberInfo(fiber, currentDepth) {
          if (!fiber || currentDepth > depth) return null;

          const info = {};
          const type = fiber.type;

          if (typeof type === 'string') {
            info.type = 'host';
            info.tag = type;
          } else if (typeof type === 'function') {
            info.type = 'component';
            info.name = type.displayName || type.name || 'Anonymous';
          } else if (type && type.$$typeof) {
            // Memo, forwardRef, etc
            const inner = type.type || type.render;
            info.type = 'wrapped';
            info.wrapper = type.$$typeof.toString().includes('memo') ? 'memo' :
                          type.$$typeof.toString().includes('forward') ? 'forwardRef' : 'other';
            info.name = (inner?.displayName || inner?.name || type.displayName || 'Anonymous');
          } else {
            return null; // Skip fragments, providers without useful info
          }

          // Props (skip children, skip functions for brevity)
          if (fiber.memoizedProps && info.type !== 'host') {
            const props = {};
            let propCount = 0;
            for (const [k, v] of Object.entries(fiber.memoizedProps)) {
              if (k === 'children') continue;
              if (propCount >= 15) { props.__truncated = true; break; }
              if (typeof v === 'function') {
                props[k] = '[function]';
              } else if (typeof v === 'object' && v !== null) {
                try {
                  const s = JSON.stringify(v);
                  props[k] = s.length > 200 ? s.substring(0, 200) + '...' : JSON.parse(s);
                } catch { props[k] = '[object]'; }
              } else {
                props[k] = v;
              }
              propCount++;
            }
            if (Object.keys(props).length > 0) info.props = props;
          }

          // State (class components)
          if (state && fiber.memoizedState && info.type === 'component') {
            if (fiber.tag === 1 && fiber.stateNode?.state) {
              // Class component
              try {
                const s = JSON.stringify(fiber.stateNode.state);
                info.state = s.length > 500 ? JSON.parse(s.substring(0, 500) + '..."') : JSON.parse(s);
              } catch { info.state = '[unserializable]'; }
            }
          }

          // Hooks (function components)
          if (hooks && fiber.memoizedState && typeof fiber.type === 'function') {
            const hookList = [];
            let hook = fiber.memoizedState;
            let hookIndex = 0;
            while (hook && hookIndex < 10) {
              const hookInfo = { index: hookIndex };
              if (hook.queue) {
                // useState or useReducer
                hookInfo.type = 'state';
                try {
                  const val = hook.memoizedState;
                  if (typeof val === 'function') {
                    hookInfo.value = '[function]';
                  } else if (typeof val === 'object' && val !== null) {
                    const s = JSON.stringify(val);
                    hookInfo.value = s.length > 300 ? s.substring(0, 300) + '...' : JSON.parse(s);
                  } else {
                    hookInfo.value = val;
                  }
                } catch { hookInfo.value = '[unserializable]'; }
              } else if (hook.memoizedState && hook.memoizedState.destroy !== undefined) {
                hookInfo.type = 'effect';
              } else if (hook.memoizedState && typeof hook.memoizedState === 'object' && 'current' in hook.memoizedState) {
                hookInfo.type = 'ref';
                try {
                  hookInfo.current = typeof hook.memoizedState.current === 'object'
                    ? '[object]' : hook.memoizedState.current;
                } catch { hookInfo.current = '[unreadable]'; }
              } else {
                hookInfo.type = 'memo/other';
                try {
                  const val = hook.memoizedState;
                  if (typeof val !== 'function' && typeof val !== 'undefined') {
                    const s = JSON.stringify(val);
                    hookInfo.value = s.length > 200 ? s.substring(0, 200) + '...' : JSON.parse(s);
                  }
                } catch { /* skip */ }
              }
              hookList.push(hookInfo);
              hook = hook.next;
              hookIndex++;
            }
            if (hookList.length > 0) info.hooks = hookList;
          }

          // Children
          const children = [];
          let child = fiber.child;
          while (child && children.length < 30) {
            const childInfo = fiberInfo(child, currentDepth + 1);
            if (childInfo) children.push(childInfo);
            child = child.sibling;
          }
          if (children.length > 0) info.children = children;

          return info;
        }

        // Find the root React fiber
        const root = sel ? document.querySelector(sel) : document.getElementById('root') || document.getElementById('__next') || document.getElementById('app') || document.body;
        if (!root) return { error: 'Root element not found' };

        // Check if React is present
        const fiber = getFiber(root);
        if (!fiber) {
          // Try to find React on child elements
          const candidates = root.querySelectorAll('*');
          for (const el of candidates) {
            const f = getFiber(el);
            if (f) {
              // Walk up to find the root fiber
              let current = f;
              while (current.return) current = current.return;
              const tree = fiberInfo(current, 0);
              return { react: true, tree, note: 'Found React on child element' };
            }
            // Only check first 100 elements
            if (Array.from(candidates).indexOf(el) > 100) break;
          }
          return { react: false, error: 'No React fiber tree found on page' };
        }

        // Walk up to app root
        let rootFiber = fiber;
        while (rootFiber.return) rootFiber = rootFiber.return;

        const tree = fiberInfo(rootFiber, 0);

        // Capture error boundaries
        const errorBoundaries = [];
        function findErrorBoundaries(f) {
          if (!f) return;
          // Class components with componentDidCatch or getDerivedStateFromError
          if (f.tag === 1 && f.stateNode) {
            const proto = Object.getPrototypeOf(f.stateNode);
            if (proto.componentDidCatch || f.type.getDerivedStateFromError) {
              const eb = {
                name: f.type.displayName || f.type.name || 'ErrorBoundary',
                hasError: !!f.stateNode.state?.hasError,
              };
              if (f.stateNode.state?.error) {
                eb.error = String(f.stateNode.state.error).substring(0, 300);
              }
              errorBoundaries.push(eb);
            }
          }
          findErrorBoundaries(f.child);
          findErrorBoundaries(f.sibling);
        }
        findErrorBoundaries(rootFiber);

        return { react: true, tree, errorBoundaries };
      },
      args: [selector, maxDepth, includeHooks, includeState],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── State Store Inspector ──

async function inspectAppState(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const stores = {};

        // Zustand — stores attach to window or are accessible via devtools hook
        // Zustand stores use subscribe/getState pattern
        if (window.__ZUSTAND_DEVTOOLS_STORES) {
          stores.zustand = {};
          for (const [name, store] of Object.entries(window.__ZUSTAND_DEVTOOLS_STORES)) {
            try {
              const state = store.getState?.();
              const s = JSON.stringify(state);
              stores.zustand[name] = s.length > 2000 ? JSON.parse(s.substring(0, 2000) + '..."') : state;
            } catch { stores.zustand[name] = '[unserializable]'; }
          }
        }

        // Try Zustand via devtools middleware (uses __STORE_DEVTOOLS__)
        for (const key of Object.keys(window)) {
          if (key.includes('zustand') || key.includes('ZUSTAND')) {
            try {
              const val = window[key];
              if (val && typeof val.getState === 'function') {
                if (!stores.zustand) stores.zustand = {};
                const state = val.getState();
                const s = JSON.stringify(state);
                stores.zustand[key] = s.length > 2000 ? JSON.parse(s.substring(0, 2000) + '..."') : state;
              }
            } catch { /* skip */ }
          }
        }

        // Redux — window.__REDUX_DEVTOOLS_EXTENSION__ or store on root fiber
        if (window.__REDUX_DEVTOOLS_EXTENSION__) {
          stores.reduxDevtools = true;
        }

        // Try to find Redux store via common patterns
        const reduxStore = window.__REDUX_STORE__ || window.store;
        if (reduxStore && typeof reduxStore.getState === 'function') {
          try {
            const state = reduxStore.getState();
            const s = JSON.stringify(state);
            stores.redux = s.length > 3000 ? JSON.parse(s.substring(0, 3000) + '..."') : state;
          } catch { stores.redux = '[unserializable]'; }
        }

        // Also check React fiber for context values (Next.js, etc.)
        function findContexts(el) {
          const contexts = [];
          const key = Object.keys(el).find(
            (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
          );
          if (!key) return contexts;

          let fiber = el[key];
          while (fiber) {
            // Context providers have a _context property
            if (fiber.type && fiber.type._context) {
              const ctx = fiber.type._context;
              const name = ctx.displayName || ctx.Provider?.displayName || 'Context';
              try {
                const val = fiber.memoizedProps?.value;
                if (val !== undefined) {
                  const s = JSON.stringify(val);
                  contexts.push({
                    name,
                    value: s.length > 1000 ? s.substring(0, 1000) + '...' : val,
                  });
                }
              } catch {
                contexts.push({ name, value: '[unserializable]' });
              }
            }
            fiber = fiber.return;
          }
          return contexts;
        }

        const root = document.getElementById('root') || document.getElementById('__next') || document.getElementById('app');
        if (root) {
          const contexts = findContexts(root);
          if (contexts.length > 0) stores.reactContext = contexts;
        }

        // Next.js data
        if (window.__NEXT_DATA__) {
          try {
            const nd = window.__NEXT_DATA__;
            stores.nextjs = {
              page: nd.page,
              query: nd.query,
              buildId: nd.buildId,
              propsSize: JSON.stringify(nd.props || {}).length,
            };
          } catch { stores.nextjs = '[unreadable]'; }
        }

        // Env vars (only public ones that are on the page)
        const envVars = {};
        try {
          // import.meta.env is only available in module contexts (Vite, etc.)
          const meta = new Function('try { return import.meta.env } catch(e) { return null }')();
          if (meta) {
            for (const [k, v] of Object.entries(meta)) {
              if (typeof v === 'string' && v.length < 200) envVars[k] = v;
            }
          }
        } catch { /* not in a module context */ }
        // Next.js public env vars
        if (window.__ENV || window.__NEXT_DATA__?.runtimeConfig) {
          const rc = window.__ENV || window.__NEXT_DATA__.runtimeConfig;
          for (const [k, v] of Object.entries(rc)) {
            if (typeof v === 'string' && v.length < 200) envVars[k] = v;
          }
        }
        if (Object.keys(envVars).length > 0) stores.envVars = envVars;

        return {
          detected: Object.keys(stores),
          stores,
        };
      },
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Layout Issue Detector ──

async function detectLayoutIssues(tabId, options = {}) {
  const { selector, checkOverflow = true, checkZIndex = true, checkVisibility = true } = options;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, overflow, zindex, visibility) => {
        const root = sel ? document.querySelector(sel) : document.body;
        if (!root) return { error: 'Root element not found' };

        const issues = [];
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;

        const elements = root.querySelectorAll('*');
        const zIndices = [];

        for (const el of elements) {
          // Skip script, style, meta elements
          if (['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'NOSCRIPT'].includes(el.tagName)) continue;

          const rect = el.getBoundingClientRect();
          const computed = window.getComputedStyle(el);
          const path = el.id ? `#${el.id}` :
                       el.className ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}` :
                       el.tagName.toLowerCase();

          // Zero-dimension elements that should have content
          if (visibility && rect.width === 0 && rect.height === 0) {
            const hasText = el.textContent?.trim().length > 0;
            const hasChildren = el.children.length > 0;
            if (hasText || hasChildren) {
              issues.push({
                type: 'zero_size',
                severity: 'high',
                element: path,
                detail: `Element has ${hasText ? 'text' : 'children'} but renders at 0x0`,
                display: computed.display,
                visibility: computed.visibility,
                overflow: computed.overflow,
              });
            }
          }

          // Off-screen elements (fully outside viewport)
          if (visibility && (rect.right < -50 || rect.bottom < -50 || rect.left > viewportW + 50 || rect.top > viewportH + 50)) {
            if (rect.width > 0 && rect.height > 0 && computed.position !== 'fixed' && computed.position !== 'sticky') {
              const hasVisibleContent = el.textContent?.trim().length > 0 || el.querySelector('img, svg, canvas, video');
              if (hasVisibleContent) {
                issues.push({
                  type: 'off_screen',
                  severity: 'medium',
                  element: path,
                  detail: `Element at (${Math.round(rect.left)}, ${Math.round(rect.top)}) is outside viewport (${viewportW}x${viewportH})`,
                  position: computed.position,
                  rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                });
              }
            }
          }

          // Overflow issues — content clipped unexpectedly
          if (overflow && (computed.overflow === 'hidden' || computed.overflowX === 'hidden' || computed.overflowY === 'hidden')) {
            if (el.scrollWidth > rect.width + 5 || el.scrollHeight > rect.height + 5) {
              issues.push({
                type: 'overflow_clipped',
                severity: 'medium',
                element: path,
                detail: `Content clipped: scroll(${el.scrollWidth}x${el.scrollHeight}) > visible(${Math.round(rect.width)}x${Math.round(rect.height)})`,
                overflow: computed.overflow,
              });
            }
          }

          // Horizontal scroll on body (usually a bug)
          if (overflow && el === document.body && el.scrollWidth > viewportW + 5) {
            issues.push({
              type: 'horizontal_scroll',
              severity: 'high',
              element: 'body',
              detail: `Page has horizontal scroll: body width ${el.scrollWidth}px > viewport ${viewportW}px`,
            });
          }

          // Z-index tracking for stacking issues
          if (zindex && computed.zIndex !== 'auto' && computed.position !== 'static') {
            const z = parseInt(computed.zIndex);
            if (!isNaN(z)) {
              zIndices.push({
                element: path,
                zIndex: z,
                position: computed.position,
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              });
            }
          }

          // Hidden but taking space (visibility: hidden, large area)
          if (visibility && computed.visibility === 'hidden' && rect.width > 50 && rect.height > 50) {
            issues.push({
              type: 'hidden_space',
              severity: 'low',
              element: path,
              detail: `Element is visibility:hidden but takes ${Math.round(rect.width)}x${Math.round(rect.height)}px space`,
            });
          }

          // Text overflow without ellipsis
          if (overflow && computed.whiteSpace === 'nowrap' && computed.overflow !== 'hidden' && el.scrollWidth > rect.width + 5) {
            if (el.textContent?.trim().length > 0) {
              issues.push({
                type: 'text_overflow',
                severity: 'low',
                element: path,
                detail: `Text overflows: nowrap but no overflow:hidden/ellipsis`,
              });
            }
          }

          // Cap issues to avoid huge payloads
          if (issues.length >= 50) break;
        }

        // Detect z-index stacking conflicts (overlapping elements with close z-index)
        const zConflicts = [];
        if (zindex) {
          zIndices.sort((a, b) => b.zIndex - a.zIndex);
          for (let i = 0; i < zIndices.length - 1 && i < 20; i++) {
            const a = zIndices[i];
            const b = zIndices[i + 1];
            // Check if they overlap spatially
            const overlaps = !(a.rect.x + a.rect.w < b.rect.x || b.rect.x + b.rect.w < a.rect.x ||
                              a.rect.y + a.rect.h < b.rect.y || b.rect.y + b.rect.h < a.rect.y);
            if (overlaps && Math.abs(a.zIndex - b.zIndex) <= 1) {
              zConflicts.push({
                elements: [a.element, b.element],
                zIndices: [a.zIndex, b.zIndex],
                detail: 'Overlapping elements with adjacent z-index values — possible stacking conflict',
              });
            }
          }
        }

        return {
          issueCount: issues.length,
          issues: issues.slice(0, 50),
          zIndexStack: zIndices.slice(0, 20),
          zConflicts,
          viewport: { width: viewportW, height: viewportH },
          bodyScroll: { width: document.body.scrollWidth, height: document.body.scrollHeight },
        };
      },
      args: [selector, checkOverflow, checkZIndex, checkVisibility],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Command polling ──

async function pollCommands() {
  try {
    const resp = await fetch(`${DASHBOARD_BASE}/api/extension-commands?pickup=true`);
    if (!resp.ok) {
      console.warn('[justclaw Bridge] Poll failed:', resp.status);
      return;
    }
    const data = await resp.json();
    if (!data.commands || data.commands.length === 0) return;

    for (const cmd of data.commands) {
      console.log('[justclaw Bridge] Command received:', cmd.type, cmd.id);
      let result;
      try {
        result = await executeCommand(cmd);
      } catch (execErr) {
        console.error('[justclaw Bridge] Command execution error:', execErr);
        result = { error: `Execution failed: ${execErr}` };
      }
      console.log('[justclaw Bridge] Command result:', cmd.id, result?.error || 'ok');
      try {
        await postResult(cmd.id, result);
        console.log('[justclaw Bridge] Result posted for:', cmd.id);
      } catch (postErr) {
        console.error('[justclaw Bridge] Failed to post result:', postErr);
      }
    }
  } catch (err) {
    // Only log if it's not a network error (dashboard unreachable)
    if (err?.message?.includes('Failed to fetch')) return;
    console.warn('[justclaw Bridge] Poll error:', err);
  }
}

async function executeCommand(cmd) {
  switch (cmd.type) {
    // ── Usage ──
    case 'extract_now':
      triggerExtraction();
      return { triggered: true };

    // ── Debug ──
    case 'get_debug': {
      const tabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
      if (tabs.length === 0) return { error: 'No usage tab open' };
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'getDebug' }, (data) => {
          resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : data);
        });
      });
    }

    // ── Tab operations ──
    case 'open_tab': {
      if (!cmd.url) return { error: 'Missing url' };
      return openManagedTab(cmd.url, cmd.purpose || 'command');
    }

    case 'close_tab': {
      const tabId = cmd.tabId;
      if (!tabId) return { error: 'Missing tabId' };
      if (!managedTabs.has(tabId)) return { error: 'Not a managed tab' };
      chrome.tabs.remove(tabId).catch(() => {});
      managedTabs.delete(tabId);
      consoleLogs.delete(tabId);
      networkCaptures.delete(tabId);
      return { closed: tabId };
    }

    case 'read_tab': {
      const tabId = cmd.tabId;
      if (tabId) return readTabContent(tabId, { includeScreenshot: cmd.screenshot, textLimit: cmd.textLimit });
      // Default: read from usage tab
      const usageTabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
      if (usageTabs.length === 0) return { error: 'No usage tab' };
      return readTabContent(usageTabs[0].id, { includeScreenshot: cmd.screenshot });
    }

    case 'read_page': {
      // Open a URL, wait for load, capture console, read content, optionally screenshot, close tab
      if (!cmd.url) return { error: 'Missing url' };
      const openResult = await openManagedTab(cmd.url, 'read_page');
      if (openResult.error) return openResult;
      // Start console capture immediately so we catch errors during page load
      try { await startConsoleCapture(openResult.tabId); } catch {}
      await new Promise((r) => setTimeout(r, cmd.waitMs || 4000));
      // Grab any console errors/warnings before closing
      let consoleErrors = [];
      try {
        const logs = await getConsoleLogs(openResult.tabId, { limit: 50 });
        if (logs?.logs) {
          consoleErrors = logs.logs.filter(e => e.level === 'error' || e.level === 'warn');
        }
      } catch {}
      const content = await readTabContent(openResult.tabId, {
        includeScreenshot: cmd.screenshot !== false,
        textLimit: cmd.textLimit || 5000,
      });
      chrome.tabs.remove(openResult.tabId).catch(() => {});
      managedTabs.delete(openResult.tabId);
      consoleLogs.delete(openResult.tabId);
      // Include console errors in result so agents can see browser-side issues
      if (consoleErrors.length > 0) {
        content.consoleErrors = consoleErrors;
        // Also persist so they survive tab close and can be queried later
        persistConsoleErrors(cmd.url, consoleErrors);
      }
      return content;
    }

    case 'navigate': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.url) return { error: 'Missing url' };
      return navigateTab(cmd.tabId, cmd.url);
    }

    // ── Screenshots ──
    case 'screenshot': {
      if (cmd.tabId) return screenshotTab(cmd.tabId);
      if (cmd.url) {
        const openResult = await openManagedTab(cmd.url, 'screenshot');
        if (openResult.error) return openResult;
        await new Promise((r) => setTimeout(r, cmd.waitMs || 3000));
        const result = await screenshotTab(openResult.tabId);
        chrome.tabs.remove(openResult.tabId).catch(() => {});
        managedTabs.delete(openResult.tabId);
        return result;
      }
      // Default: screenshot active tab
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return { error: 'No active tab' };
      return screenshotTab(activeTab.id);
    }

    case 'screenshot_element': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.selector) return { error: 'Missing selector' };
      return screenshotElement(cmd.tabId, cmd.selector);
    }

    case 'capture_sequence': {
      // Multi-frame screenshot capture (screen recording lite)
      let tabId = cmd.tabId;
      let shouldClose = false;
      if (!tabId && cmd.url) {
        const openResult = await openManagedTab(cmd.url, 'capture_sequence');
        if (openResult.error) return openResult;
        tabId = openResult.tabId;
        shouldClose = true;
        await new Promise((r) => setTimeout(r, cmd.waitMs || 3000));
      }
      if (!tabId) return { error: 'Missing tabId or url' };
      const result = await captureSequence(tabId, cmd.frameCount, cmd.intervalMs);
      if (shouldClose) {
        chrome.tabs.remove(tabId).catch(() => {});
        managedTabs.delete(tabId);
      }
      return result;
    }

    // ── Interaction ──
    case 'click': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return clickElement(cmd.tabId, {
        selector: cmd.selector,
        x: cmd.x,
        y: cmd.y,
        button: cmd.button,
        clickCount: cmd.clickCount,
      });
    }

    case 'hover': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.selector) return { error: 'Missing selector' };
      return hoverElement(cmd.tabId, cmd.selector);
    }

    case 'fill_form': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.fields) return { error: 'Missing fields array' };
      return fillForm(cmd.tabId, cmd.fields);
    }

    case 'submit_form': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return submitForm(cmd.tabId, cmd.selector);
    }

    case 'select_option': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.selector) return { error: 'Missing selector' };
      if (cmd.value === undefined) return { error: 'Missing value' };
      return selectOption(cmd.tabId, cmd.selector, cmd.value);
    }

    case 'press_key': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.key) return { error: 'Missing key' };
      return pressKey(cmd.tabId, cmd.key, { selector: cmd.selector, modifiers: cmd.modifiers });
    }

    case 'wait_for_selector': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.selector) return { error: 'Missing selector' };
      return waitForSelector(cmd.tabId, cmd.selector, cmd.timeoutMs);
    }

    case 'scroll_page': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      try {
        await chrome.scripting.executeScript({
          target: { tabId: cmd.tabId },
          func: (direction, amount, selector) => {
            const target = selector ? document.querySelector(selector) : window;
            if (selector && !target) return { error: `Element not found: ${selector}` };
            const el = selector ? target : window;
            el.scrollBy(0, direction === 'up' ? -amount : amount);
          },
          args: [cmd.direction || 'down', cmd.amount || 500, cmd.selector || null],
        });
        return { scrolled: true, direction: cmd.direction || 'down' };
      } catch (err) {
        return { error: String(err) };
      }
    }

    // ── DOM inspection ──
    case 'query_elements': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.selector) return { error: 'Missing selector' };
      return queryElements(cmd.tabId, cmd.selector, { limit: cmd.limit, attributes: cmd.attributes });
    }

    case 'get_styles': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.selector) return { error: 'Missing selector' };
      return getComputedStyles(cmd.tabId, cmd.selector, cmd.properties);
    }

    case 'get_accessibility_tree': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return getAccessibilityTree(cmd.tabId, { maxDepth: cmd.maxDepth, selector: cmd.selector });
    }

    // ── React & Framework Debugging ──
    case 'inspect_react': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return inspectReact(cmd.tabId, {
        selector: cmd.selector,
        maxDepth: cmd.maxDepth,
        includeHooks: cmd.includeHooks,
        includeState: cmd.includeState,
      });
    }

    case 'inspect_app_state': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return inspectAppState(cmd.tabId);
    }

    case 'detect_layout_issues': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return detectLayoutIssues(cmd.tabId, {
        selector: cmd.selector,
        checkOverflow: cmd.checkOverflow,
        checkZIndex: cmd.checkZIndex,
        checkVisibility: cmd.checkVisibility,
      });
    }

    case 'execute_script': {
      // Run arbitrary JS on a managed tab (for extracting specific data)
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!managedTabs.has(cmd.tabId)) return { error: 'Not a managed tab — safety check' };
      if (!cmd.script) return { error: 'Missing script' };
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: cmd.tabId },
          func: new Function('return (' + cmd.script + ')()'),
        });
        return { result: results[0]?.result };
      } catch (err) {
        return { error: String(err) };
      }
    }

    // ── Cookies ──
    case 'get_cookies': {
      return getCookies(cmd.domain, cmd.names);
    }

    // ── Storage ──
    case 'get_storage': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return getStorage(cmd.tabId, cmd.storageType, cmd.keys);
    }

    case 'set_storage': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.entries) return { error: 'Missing entries' };
      return setStorage(cmd.tabId, cmd.storageType, cmd.entries);
    }

    // ── Console capture ──
    case 'start_console_capture': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return startConsoleCapture(cmd.tabId);
    }

    case 'get_console_logs': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return getConsoleLogs(cmd.tabId, { level: cmd.level, since: cmd.since, limit: cmd.limit });
    }

    case 'get_page_errors': {
      // Return persisted console errors — no active tab needed
      if (cmd.url) {
        const errors = persistedConsoleErrors.get(cmd.url) || [];
        return { url: cmd.url, errors, count: errors.length };
      }
      // Return all URLs with error counts
      const summary = {};
      for (const [url, errors] of persistedConsoleErrors) {
        summary[url] = { count: errors.length, latest: errors[errors.length - 1]?.timestamp };
      }
      return { urls: summary, totalUrls: persistedConsoleErrors.size };
    }

    // ── Network capture ──
    case 'start_network_capture': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return startNetworkCapture(cmd.tabId, { urlFilter: cmd.urlFilter, methods: cmd.methods });
    }

    case 'get_network_logs': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return getNetworkLogs(cmd.tabId, { urlFilter: cmd.urlFilter, statusFilter: cmd.statusFilter, limit: cmd.limit });
    }

    // ── WebSocket monitoring ──
    case 'start_websocket_capture': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return startWebSocketCapture(cmd.tabId, { urlFilter: cmd.urlFilter });
    }

    case 'get_websocket_logs': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return getWebSocketLogs(cmd.tabId, { limit: cmd.limit, type: cmd.messageType });
    }

    // ── Multi-step workflow ──
    case 'workflow': {
      if (!cmd.steps) return { error: 'Missing steps array' };
      return executeWorkflow(cmd.steps);
    }

    // ── Tab listing & adoption ──
    case 'list_tabs': {
      const allTabs = await chrome.tabs.query({});
      return {
        allTabs: allTabs.map((t) => ({
          id: t.id, url: t.url, title: t.title, active: t.active,
          managed: managedTabs.has(t.id),
        })),
        managedTabs: [...managedTabs.entries()].map(([id, info]) => ({ id, ...info })),
      };
    }

    case 'adopt_tab': {
      // Adopt an existing Chrome tab into managed tabs so all commands
      // (click, fill_form, execute_script, etc.) work on it.
      // Use list_tabs first to find the tab ID, then adopt it.
      const tabId = cmd.tabId;
      if (!tabId) return { error: 'Missing tabId' };
      if (managedTabs.has(tabId)) return { adopted: true, tabId, alreadyManaged: true };
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab) return { error: `Tab ${tabId} not found` };
        // Enforce managed tab limit
        if (managedTabs.size >= MAX_MANAGED_TABS) {
          // Evict oldest managed tab
          const oldest = [...managedTabs.entries()].sort((a, b) => a[1].openedAt - b[1].openedAt)[0];
          if (oldest) {
            managedTabs.delete(oldest[0]);
            // Don't close the evicted tab — just unmanage it
          }
        }
        managedTabs.set(tabId, {
          url: tab.url || 'unknown',
          openedAt: Date.now(),
          purpose: cmd.purpose || 'adopted',
        });
        return { adopted: true, tabId, url: tab.url, title: tab.title };
      } catch (e) {
        return { error: `Failed to adopt tab ${tabId}: ${e.message}` };
      }
    }

    case 'list_managed': {
      return {
        count: managedTabs.size,
        max: MAX_MANAGED_TABS,
        tabs: [...managedTabs.entries()].map(([id, info]) => ({ id, ...info })),
      };
    }

    // ── Reload ──
    case 'reload_tab': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      await chrome.tabs.reload(cmd.tabId);
      return { reloaded: true, tabId: cmd.tabId };
    }

    case 'reload_usage': {
      const tabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
      if (tabs.length === 0) return { error: 'No usage tab open' };
      await chrome.tabs.reload(tabs[0].id);
      return { reloaded: true };
    }

    // ── Ping (no-op test) ──
    case 'ping': {
      return { pong: true, time: Date.now(), version: chrome.runtime.getManifest().version };
    }

    // ── Status ──
    case 'status': {
      return {
        version: chrome.runtime.getManifest().version,
        managedTabs: managedTabs.size,
        maxTabs: MAX_MANAGED_TABS,
        tabTtlMs: TAB_TTL_MS,
        capabilities: [
          'read_page', 'screenshot', 'screenshot_element', 'capture_sequence',
          'click', 'hover', 'fill_form', 'submit_form', 'select_option', 'press_key',
          'wait_for_selector', 'scroll_page', 'navigate',
          'query_elements', 'get_styles', 'get_accessibility_tree', 'execute_script',
          'get_cookies', 'get_storage', 'set_storage',
          'start_console_capture', 'get_console_logs', 'get_page_errors',
          'start_network_capture', 'get_network_logs',
          'start_websocket_capture', 'get_websocket_logs',
          'inspect_react', 'inspect_app_state', 'detect_layout_issues',
          'workflow',
          'list_tabs', 'list_managed', 'adopt_tab', 'reload_tab',
          // Phase 1
          'handle_dialog', 'print_pdf', 'file_upload',
          'go_back', 'go_forward',
          'clipboard_read', 'clipboard_write',
          'network_throttle', 'set_geolocation', 'clear_geolocation',
          // Phase 2
          'drag_drop', 'list_frames', 'read_frame', 'execute_in_frame',
          'query_shadow_dom',
          'start_har_capture', 'stop_har_capture',
          'get_full_accessibility_tree',
          'emulate_device', 'clear_emulation',
          // Phase 3
          'extract_structured', 'extract_tables', 'extract_metadata',
          'annotate_interactive', 'find_element',
          'resilient_click', 'resilient_fill',
        ],
      };
    }

    // ── Phase 1: Dialog/Alert handling ──
    case 'handle_dialog': {
      // Configure how to handle the next dialog (alert/confirm/prompt/beforeunload)
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return handleDialog(cmd.tabId, {
        action: cmd.action || 'accept', // accept, dismiss
        promptText: cmd.promptText,
      });
    }

    // ── Phase 1: Print to PDF ──
    case 'print_pdf': {
      if (!cmd.tabId && !cmd.url) return { error: 'Missing tabId or url' };
      let tabId = cmd.tabId;
      let shouldClose = false;
      if (!tabId && cmd.url) {
        const openResult = await openManagedTab(cmd.url, 'print_pdf');
        if (openResult.error) return openResult;
        tabId = openResult.tabId;
        shouldClose = true;
        await new Promise((r) => setTimeout(r, cmd.waitMs || 3000));
      }
      const result = await printToPdf(tabId, {
        landscape: cmd.landscape,
        displayHeaderFooter: cmd.displayHeaderFooter,
        printBackground: cmd.printBackground !== false,
        scale: cmd.scale,
        paperWidth: cmd.paperWidth,
        paperHeight: cmd.paperHeight,
        marginTop: cmd.marginTop,
        marginBottom: cmd.marginBottom,
        marginLeft: cmd.marginLeft,
        marginRight: cmd.marginRight,
        pageRanges: cmd.pageRanges,
      });
      if (shouldClose) {
        chrome.tabs.remove(tabId).catch(() => {});
        managedTabs.delete(tabId);
      }
      return result;
    }

    // ── Phase 1: File upload ──
    case 'file_upload': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.selector) return { error: 'Missing selector for file input' };
      if (!cmd.files || !cmd.files.length) return { error: 'Missing files array' };
      return uploadFiles(cmd.tabId, cmd.selector, cmd.files);
    }

    // ── Phase 1: Browser back/forward ──
    case 'go_back': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return navigateHistory(cmd.tabId, 'back');
    }

    case 'go_forward': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return navigateHistory(cmd.tabId, 'forward');
    }

    // ── Phase 1: Clipboard ──
    case 'clipboard_read': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return clipboardRead(cmd.tabId);
    }

    case 'clipboard_write': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (cmd.text === undefined) return { error: 'Missing text' };
      return clipboardWrite(cmd.tabId, cmd.text);
    }

    // ── Phase 1: Network throttling ──
    case 'network_throttle': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return networkThrottle(cmd.tabId, {
        preset: cmd.preset, // 'slow3g', '3g', '4g', 'offline', 'none'
        downloadThroughput: cmd.downloadThroughput,
        uploadThroughput: cmd.uploadThroughput,
        latency: cmd.latency,
        offline: cmd.offline,
      });
    }

    // ── Phase 1: Geolocation spoofing ──
    case 'set_geolocation': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (cmd.latitude === undefined || cmd.longitude === undefined) return { error: 'Missing latitude/longitude' };
      return setGeolocation(cmd.tabId, {
        latitude: cmd.latitude,
        longitude: cmd.longitude,
        accuracy: cmd.accuracy || 100,
      });
    }

    case 'clear_geolocation': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return clearGeolocation(cmd.tabId);
    }

    // ── Phase 2: Drag and drop ──
    case 'drag_drop': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.from && !cmd.fromSelector) return { error: 'Missing from coordinates or fromSelector' };
      if (!cmd.to && !cmd.toSelector) return { error: 'Missing to coordinates or toSelector' };
      return dragDrop(cmd.tabId, {
        fromSelector: cmd.fromSelector,
        toSelector: cmd.toSelector,
        from: cmd.from,    // {x, y}
        to: cmd.to,        // {x, y}
        steps: cmd.steps,  // intermediate move steps (default 10)
      });
    }

    // ── Phase 2: iframe content access ──
    case 'list_frames': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return listFrames(cmd.tabId);
    }

    case 'read_frame': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.frameSelector && cmd.frameIndex === undefined) return { error: 'Missing frameSelector or frameIndex' };
      return readFrame(cmd.tabId, {
        frameSelector: cmd.frameSelector,
        frameIndex: cmd.frameIndex,
        textLimit: cmd.textLimit || 3000,
      });
    }

    case 'execute_in_frame': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.frameSelector && cmd.frameIndex === undefined) return { error: 'Missing frameSelector or frameIndex' };
      if (!cmd.script) return { error: 'Missing script' };
      return executeInFrame(cmd.tabId, {
        frameSelector: cmd.frameSelector,
        frameIndex: cmd.frameIndex,
        script: cmd.script,
      });
    }

    // ── Phase 2: Shadow DOM piercing ──
    case 'query_shadow_dom': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.selector) return { error: 'Missing selector' };
      return queryShadowDom(cmd.tabId, cmd.selector, {
        hostSelector: cmd.hostSelector,
        limit: cmd.limit,
      });
    }

    // ── Phase 2: HAR export ──
    case 'start_har_capture': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return startHarCapture(cmd.tabId);
    }

    case 'stop_har_capture': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return stopHarCapture(cmd.tabId);
    }

    // ── Phase 2: Full CDP accessibility tree ──
    case 'get_full_accessibility_tree': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return getFullAccessibilityTree(cmd.tabId, {
        depth: cmd.depth,
        interestingOnly: cmd.interestingOnly !== false,
      });
    }

    // ── Phase 2: Device/mobile emulation ──
    case 'emulate_device': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return emulateDevice(cmd.tabId, {
        preset: cmd.preset,     // 'iphone16', 'pixel9', 'ipad', etc.
        width: cmd.width,
        height: cmd.height,
        deviceScaleFactor: cmd.deviceScaleFactor,
        mobile: cmd.mobile,
        userAgent: cmd.userAgent,
      });
    }

    case 'clear_emulation': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return clearEmulation(cmd.tabId);
    }

    // ── Phase 3: Structured data extraction ──
    case 'extract_structured': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.schema) return { error: 'Missing schema (JSON object describing desired fields)' };
      return extractStructured(cmd.tabId, cmd.schema, {
        selector: cmd.selector,
        multiple: cmd.multiple,
      });
    }

    case 'extract_tables': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return extractTables(cmd.tabId, { selector: cmd.selector, limit: cmd.limit });
    }

    case 'extract_metadata': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return extractMetadata(cmd.tabId);
    }

    // ── Phase 3: Set-of-Mark visual grounding ──
    case 'annotate_interactive': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      return annotateInteractiveElements(cmd.tabId, {
        screenshot: cmd.screenshot !== false,
        filter: cmd.filter,  // 'clickable', 'inputs', 'links', 'all'
        removeAfter: cmd.removeAfter !== false,
      });
    }

    // ── Phase 3: Smart element finding ──
    case 'find_element': {
      // Find elements by description — returns candidates for the calling agent to pick
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.description) return { error: 'Missing description' };
      return findElementByDescription(cmd.tabId, cmd.description, {
        limit: cmd.limit,
        interactiveOnly: cmd.interactiveOnly,
      });
    }

    // ── Phase 3: Self-healing selectors ──
    case 'resilient_click': {
      // Click using a cached/healing selector
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.name) return { error: 'Missing name (unique identifier for this element)' };
      if (!cmd.selector && !cmd.description) return { error: 'Missing selector or description' };
      return resilientClick(cmd.tabId, cmd.name, {
        selector: cmd.selector,
        description: cmd.description,
        fallbackText: cmd.fallbackText,
        fallbackRole: cmd.fallbackRole,
      });
    }

    case 'resilient_fill': {
      if (!cmd.tabId) return { error: 'Missing tabId' };
      if (!cmd.name) return { error: 'Missing name' };
      if (cmd.value === undefined) return { error: 'Missing value' };
      return resilientFill(cmd.tabId, cmd.name, cmd.value, {
        selector: cmd.selector,
        description: cmd.description,
        fallbackText: cmd.fallbackText,
        fallbackRole: cmd.fallbackRole,
      });
    }

    default:
      return { error: `Unknown command: ${cmd.type}` };
  }
}

// ── Phase 1 Helper Functions ──

// CDP helper: attach debugger, send command, detach
async function cdpCommand(tabId, method, params = {}) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    // Already attached is ok
    if (!String(err).includes('Already attached')) {
      return { error: `CDP attach failed: ${err}` };
    }
  }
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    return result;
  } catch (err) {
    return { error: `CDP ${method} failed: ${err}` };
  }
}

async function cdpDetach(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
}

// Dialog handling — attach CDP listener for JavaScript dialogs
const dialogHandlers = new Map(); // tabId → {action, promptText}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Page.javascriptDialogOpening') {
    const tabId = source.tabId;
    const handler = dialogHandlers.get(tabId) || { action: 'accept' };
    console.log(`[justclaw Bridge] Dialog intercepted: ${params.type} "${params.message}"`);

    chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
      accept: handler.action === 'accept',
      promptText: handler.promptText || '',
    }).catch((err) => console.warn('[justclaw Bridge] Dialog handle failed:', err));
  }
});

async function handleDialog(tabId, options) {
  const { action = 'accept', promptText } = options;
  dialogHandlers.set(tabId, { action, promptText });

  // Attach and enable Page events so we catch dialogs
  const attachResult = await cdpCommand(tabId, 'Page.enable');
  if (attachResult?.error) return attachResult;

  return {
    configured: true,
    tabId,
    action,
    note: `Will ${action} the next dialog. Call 'handle_dialog' again to change behavior.`,
  };
}

// Print to PDF via CDP
async function printToPdf(tabId, options = {}) {
  try {
    const result = await cdpCommand(tabId, 'Page.printToPDF', {
      landscape: options.landscape || false,
      displayHeaderFooter: options.displayHeaderFooter || false,
      printBackground: options.printBackground !== false,
      scale: options.scale || 1,
      paperWidth: options.paperWidth || 8.5,
      paperHeight: options.paperHeight || 11,
      marginTop: options.marginTop || 0.4,
      marginBottom: options.marginBottom || 0.4,
      marginLeft: options.marginLeft || 0.4,
      marginRight: options.marginRight || 0.4,
      pageRanges: options.pageRanges || '',
      transferMode: 'ReturnAsBase64',
    });

    if (result?.error) return result;

    await cdpDetach(tabId);

    return {
      pdf: result.data, // base64 encoded
      sizeBytes: Math.round((result.data?.length || 0) * 0.75),
      options: {
        landscape: options.landscape || false,
        paperWidth: options.paperWidth || 8.5,
        paperHeight: options.paperHeight || 11,
      },
    };
  } catch (err) {
    await cdpDetach(tabId);
    return { error: `Print to PDF failed: ${err}` };
  }
}

// File upload via CDP DOM.setFileInputFiles
async function uploadFiles(tabId, selector, files) {
  try {
    // Get the DOM node for the file input
    const docResult = await cdpCommand(tabId, 'DOM.getDocument', { depth: 0 });
    if (docResult?.error) return docResult;

    const nodeResult = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
      nodeId: docResult.root.nodeId,
      selector,
    });

    if (!nodeResult?.nodeId) {
      await cdpDetach(tabId);
      return { error: `Element not found: ${selector}` };
    }

    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
      files,
      nodeId: nodeResult.nodeId,
    });

    await cdpDetach(tabId);

    return {
      uploaded: true,
      selector,
      fileCount: files.length,
      files,
    };
  } catch (err) {
    await cdpDetach(tabId);
    return { error: `File upload failed: ${err}` };
  }
}

// Browser back/forward
async function navigateHistory(tabId, direction) {
  try {
    const result = await cdpCommand(tabId, 'Page.getNavigationHistory');
    if (result?.error) return result;

    const { currentIndex, entries } = result;
    const targetIndex = direction === 'back' ? currentIndex - 1 : currentIndex + 1;

    if (targetIndex < 0 || targetIndex >= entries.length) {
      await cdpDetach(tabId);
      return { error: `No ${direction} history entry` };
    }

    await chrome.debugger.sendCommand({ tabId }, 'Page.navigateToHistoryEntry', {
      entryId: entries[targetIndex].id,
    });

    await cdpDetach(tabId);

    return {
      navigated: true,
      direction,
      from: entries[currentIndex].url,
      to: entries[targetIndex].url,
      title: entries[targetIndex].title,
    };
  } catch (err) {
    await cdpDetach(tabId);
    return { error: `Navigation ${direction} failed: ${err}` };
  }
}

// Clipboard read
async function clipboardRead(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        try {
          const text = await navigator.clipboard.readText();
          return { text, length: text.length };
        } catch (err) {
          return { error: `Clipboard read failed: ${err.message}` };
        }
      },
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: `Clipboard read failed: ${err}` };
  }
}

// Clipboard write
async function clipboardWrite(tabId, text) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (t) => {
        try {
          await navigator.clipboard.writeText(t);
          return { written: true, length: t.length };
        } catch (err) {
          return { error: `Clipboard write failed: ${err.message}` };
        }
      },
      args: [text],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: `Clipboard write failed: ${err}` };
  }
}

// Network throttling presets
const THROTTLE_PRESETS = {
  offline: { offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0 },
  slow3g: { offline: false, downloadThroughput: 50000, uploadThroughput: 25000, latency: 2000 },
  '3g': { offline: false, downloadThroughput: 375000, uploadThroughput: 75000, latency: 300 },
  '4g': { offline: false, downloadThroughput: 4000000, uploadThroughput: 3000000, latency: 20 },
  none: { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
};

async function networkThrottle(tabId, options) {
  const preset = options.preset ? THROTTLE_PRESETS[options.preset] : null;
  const config = {
    offline: options.offline ?? preset?.offline ?? false,
    downloadThroughput: options.downloadThroughput ?? preset?.downloadThroughput ?? -1,
    uploadThroughput: options.uploadThroughput ?? preset?.uploadThroughput ?? -1,
    latency: options.latency ?? preset?.latency ?? 0,
  };

  const result = await cdpCommand(tabId, 'Network.enable');
  if (result?.error) return result;

  const emulateResult = await chrome.debugger.sendCommand({ tabId }, 'Network.emulateNetworkConditions', config);
  // Don't detach — throttling needs to stay active

  return {
    throttled: true,
    tabId,
    config,
    preset: options.preset || 'custom',
    note: config.offline ? 'Tab is now offline' : `Throttled: ${config.downloadThroughput}bps down, ${config.uploadThroughput}bps up, ${config.latency}ms latency`,
  };
}

// Geolocation spoofing via CDP
async function setGeolocation(tabId, coords) {
  const result = await cdpCommand(tabId, 'Emulation.setGeolocationOverride', {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy || 100,
  });

  if (result?.error) return result;
  // Don't detach — override needs to stay active

  return {
    set: true,
    tabId,
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy || 100,
  };
}

async function clearGeolocation(tabId) {
  const result = await cdpCommand(tabId, 'Emulation.clearGeolocationOverride');
  await cdpDetach(tabId);
  if (result?.error) return result;
  return { cleared: true, tabId };
}

// ── Phase 2 Helper Functions ──

// Drag and drop via synthesized mouse events
async function dragDrop(tabId, options) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (opts) => {
        function getCoords(selector) {
          if (!selector) return null;
          const el = document.querySelector(selector);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, el: true };
        }

        const from = opts.fromSelector ? getCoords(opts.fromSelector) : opts.from;
        const to = opts.toSelector ? getCoords(opts.toSelector) : opts.to;
        if (!from) return { error: `Source element not found: ${opts.fromSelector}` };
        if (!to) return { error: `Target element not found: ${opts.toSelector}` };

        const steps = opts.steps || 10;
        const sourceEl = opts.fromSelector ? document.querySelector(opts.fromSelector) : document.elementFromPoint(from.x, from.y);
        const targetEl = opts.toSelector ? document.querySelector(opts.toSelector) : document.elementFromPoint(to.x, to.y);

        // Dispatch drag events
        const dataTransfer = new DataTransfer();

        sourceEl.dispatchEvent(new MouseEvent('mousedown', { clientX: from.x, clientY: from.y, bubbles: true }));
        sourceEl.dispatchEvent(new DragEvent('dragstart', { clientX: from.x, clientY: from.y, dataTransfer, bubbles: true }));
        sourceEl.dispatchEvent(new DragEvent('drag', { clientX: from.x, clientY: from.y, dataTransfer, bubbles: true }));

        // Intermediate moves
        for (let i = 1; i <= steps; i++) {
          const progress = i / steps;
          const mx = from.x + (to.x - from.x) * progress;
          const my = from.y + (to.y - from.y) * progress;
          const moveTarget = document.elementFromPoint(mx, my) || document.body;
          moveTarget.dispatchEvent(new DragEvent('dragover', { clientX: mx, clientY: my, dataTransfer, bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 10));
        }

        // Drop
        if (targetEl) {
          targetEl.dispatchEvent(new DragEvent('dragenter', { clientX: to.x, clientY: to.y, dataTransfer, bubbles: true }));
          targetEl.dispatchEvent(new DragEvent('dragover', { clientX: to.x, clientY: to.y, dataTransfer, bubbles: true, cancelable: true }));
          targetEl.dispatchEvent(new DragEvent('drop', { clientX: to.x, clientY: to.y, dataTransfer, bubbles: true, cancelable: true }));
        }
        sourceEl.dispatchEvent(new DragEvent('dragend', { clientX: to.x, clientY: to.y, dataTransfer, bubbles: true }));
        sourceEl.dispatchEvent(new MouseEvent('mouseup', { clientX: to.x, clientY: to.y, bubbles: true }));

        return {
          dragged: true,
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y },
          sourceTag: sourceEl?.tagName?.toLowerCase(),
          targetTag: targetEl?.tagName?.toLowerCase(),
        };
      },
      args: [options],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: `Drag and drop failed: ${err}` };
  }
}

// List all frames/iframes on a page
async function listFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const frames = [];
        document.querySelectorAll('iframe, frame').forEach((el, i) => {
          const rect = el.getBoundingClientRect();
          frames.push({
            index: i,
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            name: el.name || undefined,
            src: el.src || undefined,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            visible: rect.width > 0 && rect.height > 0,
            sandbox: el.sandbox?.value || undefined,
          });
        });
        return { count: frames.length, frames };
      },
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: `List frames failed: ${err}` };
  }
}

// Read content from an iframe
async function readFrame(tabId, options) {
  try {
    // Get all frames for this tab
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!allFrames || allFrames.length <= 1) {
      return { error: 'No iframes found on page' };
    }

    // Find the target frame
    let targetFrameId;
    if (options.frameIndex !== undefined) {
      // frameIndex 0 = first iframe (skip main frame at index 0 in allFrames)
      const iframes = allFrames.filter(f => f.parentFrameId >= 0 && f.frameId !== 0);
      if (options.frameIndex >= iframes.length) {
        return { error: `Frame index ${options.frameIndex} out of range (${iframes.length} frames)` };
      }
      targetFrameId = iframes[options.frameIndex].frameId;
    } else {
      // Try to match by URL from selector's src
      const mainResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => {
          const el = document.querySelector(sel);
          return el ? { src: el.src } : null;
        },
        args: [options.frameSelector],
      });
      const frameSrc = mainResult[0]?.result?.src;
      if (frameSrc) {
        const match = allFrames.find(f => f.url === frameSrc);
        if (match) targetFrameId = match.frameId;
      }
      if (!targetFrameId) {
        // Fallback: use first non-main frame
        const iframes = allFrames.filter(f => f.frameId !== 0);
        if (iframes.length > 0) targetFrameId = iframes[0].frameId;
      }
    }

    if (!targetFrameId) return { error: 'Could not identify target frame' };

    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [targetFrameId] },
      func: (limit) => ({
        url: window.location.href,
        title: document.title,
        text: document.body?.innerText?.substring(0, limit) || '',
        headings: [...document.querySelectorAll('h1,h2,h3')].map(h => h.textContent?.trim()).filter(Boolean).slice(0, 15),
        links: [...document.querySelectorAll('a[href]')].map(a => ({
          text: a.textContent?.trim()?.substring(0, 60),
          href: a.href,
        })).filter(l => l.text).slice(0, 20),
        forms: [...document.querySelectorAll('input,select,textarea,button')].map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.type,
          name: el.name,
          id: el.id,
          placeholder: el.placeholder,
        })).slice(0, 20),
      }),
      args: [options.textLimit || 3000],
    });

    return { frameId: targetFrameId, ...results[0]?.result };
  } catch (err) {
    return { error: `Read frame failed: ${err}` };
  }
}

// Execute script in an iframe
async function executeInFrame(tabId, options) {
  try {
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
    const iframes = allFrames.filter(f => f.frameId !== 0);

    let targetFrameId;
    if (options.frameIndex !== undefined && options.frameIndex < iframes.length) {
      targetFrameId = iframes[options.frameIndex].frameId;
    } else if (options.frameSelector) {
      const mainResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => {
          const el = document.querySelector(sel);
          return el ? { src: el.src } : null;
        },
        args: [options.frameSelector],
      });
      const frameSrc = mainResult[0]?.result?.src;
      if (frameSrc) {
        const match = allFrames.find(f => f.url === frameSrc);
        if (match) targetFrameId = match.frameId;
      }
    }

    if (!targetFrameId) return { error: 'Could not identify target frame' };

    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [targetFrameId] },
      func: new Function('return (' + options.script + ')()'),
    });

    return { frameId: targetFrameId, result: results[0]?.result };
  } catch (err) {
    return { error: `Execute in frame failed: ${err}` };
  }
}

// Shadow DOM piercing — query inside shadow roots
async function queryShadowDom(tabId, selector, options = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, hostSel, maxResults) => {
        // Recursively search through shadow DOMs
        function queryShadowAll(root, cssSelector, results, depth) {
          if (depth > 10 || results.length >= maxResults) return;

          // Search in current root
          try {
            root.querySelectorAll(cssSelector).forEach(el => {
              if (results.length >= maxResults) return;
              const rect = el.getBoundingClientRect();
              results.push({
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                classes: el.className ? String(el.className).substring(0, 150) : undefined,
                text: el.textContent?.trim().substring(0, 150),
                visible: rect.width > 0 && rect.height > 0,
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                inShadow: root !== document,
                shadowDepth: depth,
              });
            });
          } catch { /* invalid selector in this context */ }

          // Recurse into shadow roots
          root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
              queryShadowAll(el.shadowRoot, cssSelector, results, depth + 1);
            }
          });
        }

        const startRoot = hostSel ? document.querySelector(hostSel)?.shadowRoot || document : document;
        if (hostSel && !startRoot) return { error: `Shadow host not found: ${hostSel}` };

        const matches = [];
        queryShadowAll(startRoot, sel, matches, startRoot === document ? 0 : 1);

        return { selector: sel, count: matches.length, elements: matches };
      },
      args: [selector, options.hostSelector, options.limit || 20],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: `Shadow DOM query failed: ${err}` };
  }
}

// HAR capture — uses CDP Network domain to record full network timeline
const harCaptures = new Map(); // tabId → { entries: [], startTime }

async function startHarCapture(tabId) {
  const result = await cdpCommand(tabId, 'Network.enable', {
    maxTotalBufferSize: 10 * 1024 * 1024,
  });
  if (result?.error) return result;

  harCaptures.set(tabId, {
    entries: [],
    startTime: Date.now(),
    requestMap: new Map(), // requestId → partial entry
  });

  // Listen for network events
  // Events are dispatched via chrome.debugger.onEvent (already set up)
  return { started: true, tabId, note: 'Network capture active. Use stop_har_capture to get the HAR.' };
}

// Add HAR event collection to the existing debugger event listener
const origDebuggerListener = chrome.debugger.onEvent._listeners?.[0];

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  const capture = harCaptures.get(tabId);
  if (!capture) return;

  if (method === 'Network.requestWillBeSent') {
    capture.requestMap.set(params.requestId, {
      startedDateTime: new Date(params.wallTime * 1000).toISOString(),
      request: {
        method: params.request.method,
        url: params.request.url,
        httpVersion: 'HTTP/1.1',
        headers: Object.entries(params.request.headers || {}).map(([name, value]) => ({ name, value })),
        queryString: [],
        bodySize: params.request.postData?.length || 0,
        postData: params.request.postData ? {
          mimeType: params.request.headers?.['Content-Type'] || 'application/octet-stream',
          text: params.request.postData.substring(0, 2000),
        } : undefined,
      },
      time: 0,
      _wallTime: params.wallTime,
      _timestamp: params.timestamp,
    });
  }

  if (method === 'Network.responseReceived') {
    const entry = capture.requestMap.get(params.requestId);
    if (entry) {
      entry.response = {
        status: params.response.status,
        statusText: params.response.statusText,
        httpVersion: params.response.protocol || 'HTTP/1.1',
        headers: Object.entries(params.response.headers || {}).map(([name, value]) => ({ name, value })),
        content: {
          size: params.response.headers?.['content-length'] ? parseInt(params.response.headers['content-length']) : 0,
          mimeType: params.response.mimeType || 'application/octet-stream',
        },
        redirectURL: '',
      };
      entry.response.timing = params.response.timing ? {
        blocked: params.response.timing.dnsStart,
        dns: params.response.timing.dnsEnd - params.response.timing.dnsStart,
        connect: params.response.timing.connectEnd - params.response.timing.connectStart,
        ssl: params.response.timing.sslEnd - params.response.timing.sslStart,
        send: params.response.timing.sendEnd - params.response.timing.sendStart,
        wait: params.response.timing.receiveHeadersEnd - params.response.timing.sendEnd,
        receive: 0,
      } : undefined;
    }
  }

  if (method === 'Network.loadingFinished') {
    const entry = capture.requestMap.get(params.requestId);
    if (entry) {
      entry.time = (params.timestamp - entry._timestamp) * 1000;
      if (entry.response) {
        entry.response.content.size = params.encodedDataLength || entry.response.content.size;
      }
      capture.entries.push(entry);
      capture.requestMap.delete(params.requestId);
    }
  }

  if (method === 'Network.loadingFailed') {
    const entry = capture.requestMap.get(params.requestId);
    if (entry) {
      entry.response = {
        status: 0,
        statusText: params.errorText || 'Failed',
        httpVersion: '',
        headers: [],
        content: { size: 0, mimeType: '' },
      };
      entry.time = (params.timestamp - entry._timestamp) * 1000;
      entry._error = params.errorText;
      capture.entries.push(entry);
      capture.requestMap.delete(params.requestId);
    }
  }
});

async function stopHarCapture(tabId) {
  const capture = harCaptures.get(tabId);
  if (!capture) return { error: 'No active HAR capture for this tab' };

  harCaptures.delete(tabId);

  // Build HAR 1.2 format
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'justclaw Browser Bridge', version: chrome.runtime.getManifest().version },
      entries: capture.entries.map(e => {
        const { _wallTime, _timestamp, _error, ...entry } = e;
        return {
          ...entry,
          cache: {},
          timings: entry.response?.timing || { send: 0, wait: 0, receive: 0 },
        };
      }),
    },
  };

  await cdpDetach(tabId);

  return {
    har,
    entryCount: har.log.entries.length,
    durationMs: Date.now() - capture.startTime,
  };
}

// Full CDP accessibility tree
async function getFullAccessibilityTree(tabId, options = {}) {
  try {
    const result = await cdpCommand(tabId, 'Accessibility.getFullAXTree', {
      depth: options.depth || 10,
    });

    if (result?.error) return result;
    await cdpDetach(tabId);

    // Filter to interesting nodes (skip generic containers)
    let nodes = result.nodes || [];
    if (options.interestingOnly !== false) {
      nodes = nodes.filter(n => {
        if (!n.role?.value) return false;
        const role = n.role.value;
        // Skip generic/invisible roles
        if (['generic', 'none', 'InlineTextBox', 'StaticText'].includes(role)) return false;
        // Keep interactive, landmark, heading, and content roles
        return true;
      });
    }

    // Simplify node format for token efficiency
    const simplified = nodes.slice(0, 500).map(n => {
      const node = {
        nodeId: n.nodeId,
        role: n.role?.value,
        name: n.name?.value?.substring(0, 200),
      };
      if (n.value?.value) node.value = String(n.value.value).substring(0, 100);
      if (n.description?.value) node.description = n.description.value.substring(0, 100);

      // Include key properties
      const props = {};
      for (const p of (n.properties || [])) {
        if (['focused', 'disabled', 'checked', 'selected', 'expanded', 'required', 'invalid', 'editable', 'level'].includes(p.name)) {
          props[p.name] = p.value?.value;
        }
      }
      if (Object.keys(props).length > 0) node.properties = props;
      if (n.childIds?.length > 0) node.childCount = n.childIds.length;
      return node;
    });

    return {
      nodeCount: nodes.length,
      totalNodes: (result.nodes || []).length,
      nodes: simplified,
      truncated: nodes.length > 500,
    };
  } catch (err) {
    return { error: `Accessibility tree failed: ${err}` };
  }
}

// Device emulation presets
const DEVICE_PRESETS = {
  iphone16: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  iphone16pro: { width: 402, height: 874, deviceScaleFactor: 3, mobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  pixel9: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' },
  ipadpro: { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  ipad: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  galaxys24: { width: 360, height: 780, deviceScaleFactor: 3, mobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' },
  desktop1080: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, userAgent: '' },
  desktop1440: { width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false, userAgent: '' },
  laptop: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, userAgent: '' },
};

async function emulateDevice(tabId, options) {
  const preset = options.preset ? DEVICE_PRESETS[options.preset] : null;

  const config = {
    width: options.width || preset?.width || 375,
    height: options.height || preset?.height || 812,
    deviceScaleFactor: options.deviceScaleFactor || preset?.deviceScaleFactor || 1,
    mobile: options.mobile !== undefined ? options.mobile : (preset?.mobile ?? false),
  };

  const result = await cdpCommand(tabId, 'Emulation.setDeviceMetricsOverride', config);
  if (result?.error) return result;

  // Set user agent if specified
  const ua = options.userAgent || preset?.userAgent;
  if (ua) {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setUserAgentOverride', {
      userAgent: ua,
    });
  }

  // Enable touch events for mobile
  if (config.mobile) {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
  }

  // Don't detach — emulation needs to stay active

  return {
    emulating: true,
    tabId,
    device: options.preset || 'custom',
    viewport: { width: config.width, height: config.height },
    deviceScaleFactor: config.deviceScaleFactor,
    mobile: config.mobile,
    userAgent: ua || '(default)',
    presets: options.preset ? undefined : Object.keys(DEVICE_PRESETS),
  };
}

async function clearEmulation(tabId) {
  try {
    await cdpCommand(tabId, 'Emulation.clearDeviceMetricsOverride');
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdpDetach(tabId);
    return { cleared: true, tabId };
  } catch (err) {
    await cdpDetach(tabId);
    return { error: `Clear emulation failed: ${err}` };
  }
}

// ── Phase 3 Helper Functions ──

// Structured data extraction — extract data matching a schema from the page
async function extractStructured(tabId, schema, options = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (schemaObj, opts) => {
        // Schema format: { fieldName: { type: 'text'|'link'|'image'|'number'|'list'|'attribute', selector: 'css', attribute?: 'href' } }
        // Or shorthand: { fieldName: 'css selector' } (defaults to text extraction)

        function extractField(root, fieldDef) {
          if (typeof fieldDef === 'string') {
            fieldDef = { selector: fieldDef, type: 'text' };
          }

          const el = root.querySelector(fieldDef.selector);
          if (!el) return null;

          switch (fieldDef.type) {
            case 'text': return el.textContent?.trim() || null;
            case 'html': return el.innerHTML?.substring(0, 2000) || null;
            case 'number': {
              const text = el.textContent?.trim() || '';
              const num = parseFloat(text.replace(/[^0-9.\-]/g, ''));
              return isNaN(num) ? null : num;
            }
            case 'link': return el.href || el.querySelector('a')?.href || null;
            case 'image': return el.src || el.querySelector('img')?.src || null;
            case 'attribute': return el.getAttribute(fieldDef.attribute) || null;
            case 'exists': return !!el;
            case 'list': {
              const items = root.querySelectorAll(fieldDef.selector);
              return [...items].slice(0, 100).map(item => {
                if (fieldDef.fields) {
                  const obj = {};
                  for (const [k, v] of Object.entries(fieldDef.fields)) {
                    obj[k] = extractField(item, v);
                  }
                  return obj;
                }
                return item.textContent?.trim();
              });
            }
            default: return el.textContent?.trim() || null;
          }
        }

        const rootEl = opts.selector ? document.querySelector(opts.selector) : document;
        if (opts.selector && !rootEl) return { error: `Root element not found: ${opts.selector}` };

        if (opts.multiple) {
          // Extract multiple items matching a container selector
          const containers = document.querySelectorAll(opts.selector || 'body');
          const items = [];
          containers.forEach((container, i) => {
            if (i >= 50) return;
            const item = {};
            for (const [field, def] of Object.entries(schemaObj)) {
              item[field] = extractField(container, def);
            }
            items.push(item);
          });
          return { items, count: items.length };
        }

        const data = {};
        for (const [field, def] of Object.entries(schemaObj)) {
          data[field] = extractField(rootEl, def);
        }
        return { data };
      },
      args: [schema, options],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: `Structured extraction failed: ${err}` };
  }
}

// Extract all tables from a page as structured data
async function extractTables(tabId, options = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (opts) => {
        const tables = document.querySelectorAll(opts.selector || 'table');
        const extracted = [];
        const limit = opts.limit || 10;

        tables.forEach((table, tableIndex) => {
          if (tableIndex >= limit) return;
          const headers = [];
          const rows = [];

          // Extract headers
          table.querySelectorAll('thead th, thead td, tr:first-child th').forEach(th => {
            headers.push(th.textContent?.trim() || '');
          });

          // If no thead, try first row
          if (headers.length === 0) {
            const firstRow = table.querySelector('tr');
            if (firstRow) {
              firstRow.querySelectorAll('th, td').forEach(cell => {
                headers.push(cell.textContent?.trim() || '');
              });
            }
          }

          // Extract body rows
          const bodyRows = table.querySelectorAll('tbody tr, tr');
          const startRow = headers.length > 0 && !table.querySelector('thead') ? 1 : 0;

          bodyRows.forEach((tr, rowIndex) => {
            if (rowIndex < startRow) return; // Skip header row
            if (rows.length >= 200) return;
            const cells = [];
            tr.querySelectorAll('td, th').forEach(cell => {
              const link = cell.querySelector('a');
              cells.push({
                text: cell.textContent?.trim().substring(0, 500) || '',
                href: link?.href || undefined,
              });
            });
            if (cells.length > 0) {
              // Convert to object if headers available
              if (headers.length > 0 && headers.length === cells.length) {
                const row = {};
                headers.forEach((h, i) => {
                  row[h || `col${i}`] = cells[i].href ? { text: cells[i].text, href: cells[i].href } : cells[i].text;
                });
                rows.push(row);
              } else {
                rows.push(cells.map(c => c.href ? { text: c.text, href: c.href } : c.text));
              }
            }
          });

          extracted.push({
            index: tableIndex,
            caption: table.querySelector('caption')?.textContent?.trim(),
            headers,
            rowCount: rows.length,
            rows: rows.slice(0, 100),
          });
        });

        return { tableCount: extracted.length, tables: extracted };
      },
      args: [options],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: `Table extraction failed: ${err}` };
  }
}

// Extract all metadata from a page (JSON-LD, OpenGraph, meta tags, microdata)
async function extractMetadata(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const metadata = {};

        // JSON-LD
        const jsonLd = [];
        document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
          try { jsonLd.push(JSON.parse(el.textContent)); } catch { /* invalid JSON-LD */ }
        });
        if (jsonLd.length > 0) metadata.jsonLd = jsonLd;

        // OpenGraph
        const og = {};
        document.querySelectorAll('meta[property^="og:"]').forEach(el => {
          og[el.getAttribute('property').replace('og:', '')] = el.content;
        });
        if (Object.keys(og).length > 0) metadata.openGraph = og;

        // Twitter Card
        const twitter = {};
        document.querySelectorAll('meta[name^="twitter:"]').forEach(el => {
          twitter[el.getAttribute('name').replace('twitter:', '')] = el.content;
        });
        if (Object.keys(twitter).length > 0) metadata.twitter = twitter;

        // Standard meta tags
        const meta = {};
        document.querySelectorAll('meta[name], meta[property]').forEach(el => {
          const name = el.getAttribute('name') || el.getAttribute('property');
          if (name && !name.startsWith('og:') && !name.startsWith('twitter:')) {
            meta[name] = el.content;
          }
        });
        if (Object.keys(meta).length > 0) metadata.meta = meta;

        // Canonical URL
        const canonical = document.querySelector('link[rel="canonical"]');
        if (canonical) metadata.canonical = canonical.href;

        // RSS/Atom feeds
        const feeds = [];
        document.querySelectorAll('link[type="application/rss+xml"], link[type="application/atom+xml"]').forEach(el => {
          feeds.push({ title: el.title, href: el.href, type: el.type });
        });
        if (feeds.length > 0) metadata.feeds = feeds;

        // Favicon
        const icon = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
        if (icon) metadata.favicon = icon.href;

        metadata.title = document.title;
        metadata.url = window.location.href;
        metadata.lang = document.documentElement.lang;

        return metadata;
      },
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: `Metadata extraction failed: ${err}` };
  }
}

// Set-of-Mark: annotate interactive elements with numbered labels, then screenshot
async function annotateInteractiveElements(tabId, options = {}) {
  try {
    // Step 1: inject numbered labels on all interactive elements
    const annotateResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: (filter) => {
        // Remove any existing annotations
        document.querySelectorAll('[data-justclaw-mark]').forEach(el => el.remove());

        // Build selector based on filter
        let selector;
        switch (filter) {
          case 'clickable': selector = 'a, button, [role="button"], [onclick], [tabindex], input[type="submit"], input[type="button"]'; break;
          case 'inputs': selector = 'input, textarea, select, [contenteditable="true"]'; break;
          case 'links': selector = 'a[href]'; break;
          default: selector = 'a, button, [role="button"], input, textarea, select, [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"]';
        }

        const elements = [...document.querySelectorAll(selector)];
        const annotations = [];
        let markId = 0;

        for (const el of elements) {
          const rect = el.getBoundingClientRect();
          // Skip invisible or tiny elements
          if (rect.width < 5 || rect.height < 5) continue;
          // Skip off-screen
          if (rect.bottom < 0 || rect.top > window.innerHeight + 100) continue;
          if (rect.right < 0 || rect.left > window.innerWidth + 100) continue;

          markId++;
          if (markId > 99) break; // Cap at 99 marks to keep screenshot readable

          // Create label overlay
          const label = document.createElement('div');
          label.setAttribute('data-justclaw-mark', String(markId));
          label.style.cssText = `
            position: fixed;
            left: ${Math.max(0, rect.left - 2)}px;
            top: ${Math.max(0, rect.top - 2)}px;
            z-index: 2147483647;
            pointer-events: none;
            display: flex;
            align-items: flex-start;
          `;

          // Number badge
          const badge = document.createElement('span');
          badge.textContent = String(markId);
          badge.style.cssText = `
            background: #e53935;
            color: white;
            font-size: 11px;
            font-weight: bold;
            font-family: monospace;
            padding: 1px 4px;
            border-radius: 3px;
            line-height: 1.3;
            box-shadow: 0 1px 3px rgba(0,0,0,0.5);
          `;
          label.appendChild(badge);

          // Border around element
          const border = document.createElement('div');
          border.setAttribute('data-justclaw-mark', `border-${markId}`);
          border.style.cssText = `
            position: fixed;
            left: ${rect.left}px;
            top: ${rect.top}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            border: 2px solid #e53935;
            border-radius: 3px;
            z-index: 2147483646;
            pointer-events: none;
            box-sizing: border-box;
          `;

          document.body.appendChild(label);
          document.body.appendChild(border);

          annotations.push({
            mark: markId,
            tag: el.tagName.toLowerCase(),
            type: el.type || undefined,
            role: el.getAttribute('role') || undefined,
            text: (el.textContent?.trim() || el.placeholder || el.title || el.alt || el.getAttribute('aria-label') || '').substring(0, 100),
            href: el.href || undefined,
            name: el.name || undefined,
            id: el.id || undefined,
            selector: el.id ? `#${el.id}` :
                      el.name ? `[name="${el.name}"]` :
                      el.className ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}` :
                      el.tagName.toLowerCase(),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          });
        }

        return { annotated: annotations.length, elements: annotations };
      },
      args: [options.filter || 'all'],
    });

    const annotationData = annotateResults[0]?.result;
    if (annotationData?.error) return annotationData;

    let screenshot = null;
    if (options.screenshot !== false) {
      // Step 2: take screenshot with annotations visible
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId) {
          await chrome.tabs.update(tabId, { active: true });
          await new Promise(r => setTimeout(r, 200));
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          screenshot = dataUrl.replace(/^data:image\/png;base64,/, '');
        }
      } catch (err) {
        annotationData.screenshotError = String(err);
      }
    }

    // Step 3: remove annotations
    if (options.removeAfter !== false) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          document.querySelectorAll('[data-justclaw-mark]').forEach(el => el.remove());
        },
      });
    }

    return {
      ...annotationData,
      screenshot,
      note: 'Use mark numbers to reference elements. E.g., "click mark 7" → use the selector from element with mark:7',
    };
  } catch (err) {
    return { error: `Annotate interactive failed: ${err}` };
  }
}

// Find elements by natural-language description — returns scored candidates
async function findElementByDescription(tabId, description, options = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (desc, opts) => {
        const limit = opts.limit || 10;
        const interactiveOnly = opts.interactiveOnly !== false;
        const descLower = desc.toLowerCase();
        const descWords = descLower.split(/\s+/).filter(w => w.length > 2);

        // Get candidate elements
        let selector = '*';
        if (interactiveOnly) {
          selector = 'a, button, [role="button"], input, textarea, select, [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], label, h1, h2, h3, h4, h5, h6, summary';
        }

        const candidates = [];
        document.querySelectorAll(selector).forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return; // Skip invisible

          // Gather all text signals
          const text = (el.textContent?.trim() || '').substring(0, 200).toLowerCase();
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.title || '').toLowerCase();
          const placeholder = (el.placeholder || '').toLowerCase();
          const alt = (el.alt || '').toLowerCase();
          const name = (el.name || '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          const value = (el.value || '').toLowerCase();
          const role = (el.getAttribute('role') || el.tagName.toLowerCase()).toLowerCase();

          // Score based on match quality
          let score = 0;
          const allText = [text, ariaLabel, title, placeholder, alt, name, id, value].join(' ');

          // Exact substring match in visible text
          if (text.includes(descLower)) score += 50;
          if (ariaLabel.includes(descLower)) score += 45;
          if (title.includes(descLower)) score += 40;
          if (placeholder.includes(descLower)) score += 40;
          if (alt.includes(descLower)) score += 35;

          // Word-level matching
          for (const word of descWords) {
            if (text.includes(word)) score += 10;
            if (ariaLabel.includes(word)) score += 8;
            if (id.includes(word)) score += 6;
            if (name.includes(word)) score += 6;
            if (placeholder.includes(word)) score += 5;
          }

          // Role/type matching
          if (descWords.some(w => role.includes(w))) score += 15;
          if (desc.toLowerCase().includes('button') && (el.tagName === 'BUTTON' || role === 'button')) score += 20;
          if (desc.toLowerCase().includes('link') && (el.tagName === 'A' || role === 'link')) score += 20;
          if (desc.toLowerCase().includes('input') && el.tagName === 'INPUT') score += 20;
          if (desc.toLowerCase().includes('search') && (el.type === 'search' || placeholder.includes('search'))) score += 25;
          if (desc.toLowerCase().includes('submit') && el.type === 'submit') score += 25;
          if (desc.toLowerCase().includes('password') && el.type === 'password') score += 25;
          if (desc.toLowerCase().includes('email') && el.type === 'email') score += 25;

          if (score > 0) {
            candidates.push({
              score,
              tag: el.tagName.toLowerCase(),
              type: el.type || undefined,
              role: el.getAttribute('role') || undefined,
              text: (el.textContent?.trim() || '').substring(0, 120),
              ariaLabel: el.getAttribute('aria-label') || undefined,
              placeholder: el.placeholder || undefined,
              id: el.id || undefined,
              name: el.name || undefined,
              href: el.href || undefined,
              selector: el.id ? `#${el.id}` :
                        el.name ? `[name="${el.name}"]` :
                        el.getAttribute('aria-label') ? `[aria-label="${el.getAttribute('aria-label')}"]` :
                        null,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              visible: rect.top >= 0 && rect.top < window.innerHeight,
            });
          }
        });

        // Sort by score descending
        candidates.sort((a, b) => b.score - a.score);

        return {
          description: desc,
          candidates: candidates.slice(0, limit),
          total: candidates.length,
        };
      },
      args: [description, options],
    });
    return results[0]?.result || { error: 'No result' };
  } catch (err) {
    return { error: `Find element failed: ${err}` };
  }
}

// Self-healing selector cache
// Stored in chrome.storage.local as { selectorCache: { name: { selector, text, role, tag, ariaLabel, lastUsed } } }

async function getSelectorCache() {
  return new Promise(resolve => {
    chrome.storage.local.get('selectorCache', result => {
      resolve(result.selectorCache || {});
    });
  });
}

async function saveSelectorCache(cache) {
  return new Promise(resolve => {
    chrome.storage.local.set({ selectorCache: cache }, resolve);
  });
}

async function findResilientElement(tabId, name, hints) {
  const cache = await getSelectorCache();
  const cached = cache[name];

  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (cachedEntry, selectorHint, textHint, roleHint, descHint) => {
      function elementInfo(el) {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return null;
        return {
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().substring(0, 100),
          id: el.id,
          name: el.name,
          ariaLabel: el.getAttribute('aria-label'),
          role: el.getAttribute('role'),
          type: el.type,
          selector: el.id ? `#${el.id}` :
                    el.name ? `[name="${el.name}"]` :
                    el.getAttribute('aria-label') ? `[aria-label="${el.getAttribute('aria-label')}"]` :
                    null,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        };
      }

      // Strategy 1: try the provided selector
      if (selectorHint) {
        try {
          const el = document.querySelector(selectorHint);
          if (el) return { element: el, info: elementInfo(el), strategy: 'selector', _el: null };
        } catch { /* invalid selector */ }
      }

      // Strategy 2: try the cached selector
      if (cachedEntry?.selector) {
        try {
          const el = document.querySelector(cachedEntry.selector);
          if (el) {
            const info = elementInfo(el);
            // Verify it's the same element by checking text/role similarity
            if (info && cachedEntry.text && info.text?.includes(cachedEntry.text.substring(0, 30))) {
              return { element: el, info, strategy: 'cached_selector', _el: null };
            }
          }
        } catch { /* invalid selector */ }
      }

      // Strategy 3: find by aria-label
      if (cachedEntry?.ariaLabel || descHint) {
        const label = cachedEntry?.ariaLabel || descHint;
        const el = document.querySelector(`[aria-label="${label}"]`) || document.querySelector(`[aria-label*="${label}"]`);
        if (el) return { element: el, info: elementInfo(el), strategy: 'aria_label', _el: null };
      }

      // Strategy 4: find by text content
      const searchText = textHint || cachedEntry?.text;
      if (searchText) {
        const searchLower = searchText.toLowerCase();
        const allElements = document.querySelectorAll('a, button, [role="button"], input, textarea, select, label, h1, h2, h3, h4, h5, h6, [tabindex], [onclick]');
        for (const el of allElements) {
          const elText = (el.textContent?.trim() || el.placeholder || el.title || el.getAttribute('aria-label') || '').toLowerCase();
          if (elText.includes(searchLower) || searchLower.includes(elText.substring(0, 20))) {
            const info = elementInfo(el);
            if (info) return { element: el, info, strategy: 'text_match', _el: null };
          }
        }
      }

      // Strategy 5: find by role
      if (roleHint || cachedEntry?.role) {
        const role = roleHint || cachedEntry.role;
        const el = document.querySelector(`[role="${role}"]`);
        if (el) return { element: el, info: elementInfo(el), strategy: 'role', _el: null };
      }

      // Strategy 6: find by tag + type from cache
      if (cachedEntry?.tag && cachedEntry?.type) {
        const el = document.querySelector(`${cachedEntry.tag}[type="${cachedEntry.type}"]`);
        if (el) return { element: el, info: elementInfo(el), strategy: 'tag_type', _el: null };
      }

      return { element: null, info: null, strategy: 'not_found' };
    },
    args: [cached, hints.selector, hints.fallbackText, hints.fallbackRole, hints.description],
  });

  const found = result[0]?.result;
  if (!found || !found.info) return null;

  // Update cache with the successful selector
  cache[name] = {
    selector: found.info.selector || hints.selector,
    text: found.info.text,
    tag: found.info.tag,
    type: found.info.type,
    role: found.info.role,
    ariaLabel: found.info.ariaLabel,
    lastUsed: Date.now(),
    strategy: found.strategy,
  };
  await saveSelectorCache(cache);

  return found;
}

async function resilientClick(tabId, name, hints) {
  const found = await findResilientElement(tabId, name, hints);
  if (!found || !found.info) {
    return { error: `Element "${name}" not found after trying all strategies`, strategies: ['selector', 'cached_selector', 'aria_label', 'text_match', 'role', 'tag_type'] };
  }

  // Now click using the found element's position
  const rect = found.info.rect;
  const clickResult = await clickElement(tabId, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

  return {
    clicked: true,
    name,
    strategy: found.strategy,
    element: found.info,
    clickResult,
  };
}

async function resilientFill(tabId, name, value, hints) {
  const found = await findResilientElement(tabId, name, hints);
  if (!found || !found.info) {
    return { error: `Element "${name}" not found after trying all strategies` };
  }

  // Build a selector to use with fillForm
  const selector = found.info.selector || found.info.id ? `#${found.info.id}` : `${found.info.tag}[name="${found.info.name}"]`;

  const fillResult = await fillForm(tabId, [{ selector, value, clear: true }]);

  return {
    filled: true,
    name,
    strategy: found.strategy,
    element: found.info,
    fillResult,
  };
}

async function postResult(cmdId, result) {
  // Strip screenshot data from result before posting if it's too large (>5MB)
  let postData = result;
  const jsonSize = JSON.stringify(result).length;
  if (jsonSize > 5 * 1024 * 1024) {
    console.warn(`[justclaw Bridge] Result too large (${(jsonSize/1024/1024).toFixed(1)}MB), stripping screenshot`);
    postData = { ...result, screenshot: undefined, screenshotStripped: true, originalSize: jsonSize };
  }

  const resp = await fetch(`${DASHBOARD_BASE}/api/extension-commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmdId, result: postData }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`[justclaw Bridge] Post result failed: ${resp.status} ${text}`);
  }
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'usageData') {
    chrome.storage.local.set({ lastUsage: msg.data });
  }

  // Content script routes POST through us to avoid mixed content (HTTPS → HTTP)
  if (msg.type === 'reportUsage' && msg.data) {
    fetch(`${DASHBOARD_BASE}/api/usage-calibration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.data),
    })
      .then((r) => r.json())
      .then((result) => {
        chrome.storage.local.set({ lastUsage: msg.data });
        sendResponse(result);
      })
      .catch((err) => {
        console.warn('[justclaw Bridge] Usage report failed:', err.message);
        sendResponse({ error: err.message });
      });
    return true; // Keep sendResponse channel open for async
  }
});
