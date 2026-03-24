// Content script: runs on claude.ai/settings/usage*
// Extracts all usage data and posts to justclaw dashboard
// Debug data is also sent for remote troubleshooting

(function () {
  'use strict';

  const MAX_DEBUG_TEXT = 3000; // Cap page text to avoid sending sensitive data

  function extractUsage() {
    const allText = document.body.innerText;
    const results = {
      session: null,
      weeklyAll: null,
      weeklySonnet: null,
      extraUsage: null,
      resetTimes: {},
      planInfo: null,
      timestamp: new Date().toISOString(),
      debug: {},
    };

    // ── Collect all percentage values with surrounding context ──
    const pctRegex = /(\d+)%\s*(?:used)?/gi;
    const pctMatches = [];
    let m;
    while ((m = pctRegex.exec(allText)) !== null) {
      const start = Math.max(0, m.index - 100);
      const end = Math.min(allText.length, m.index + m[0].length + 50);
      pctMatches.push({
        percent: parseInt(m[1]),
        context: allText.substring(start, end).replace(/\n+/g, ' ').trim(),
        index: m.index,
      });
    }
    results.debug.pctMatches = pctMatches;

    // ── Match percentages to buckets by nearby context ──
    for (const pm of pctMatches) {
      const ctx = pm.context.toLowerCase();
      if (results.session === null && /session/.test(ctx)) {
        results.session = pm.percent;
      } else if (results.weeklyAll === null && /weekly/.test(ctx) && /all\s*model/.test(ctx)) {
        results.weeklyAll = pm.percent;
      } else if (results.weeklySonnet === null && /sonnet/.test(ctx)) {
        results.weeklySonnet = pm.percent;
      }
    }

    // ── Fallback: ordered "XX% used" patterns ──
    if (results.session === null || results.weeklyAll === null) {
      const usedPcts = pctMatches.filter(
        (p) => p.context.toLowerCase().includes('used') && p.percent <= 100
      );
      if (usedPcts.length >= 1 && results.session === null) results.session = usedPcts[0].percent;
      if (usedPcts.length >= 2 && results.weeklyAll === null) results.weeklyAll = usedPcts[1].percent;
      if (usedPcts.length >= 3 && results.weeklySonnet === null) results.weeklySonnet = usedPcts[2].percent;
    }

    // ── Fallback: aria progressbar values ──
    const bars = document.querySelectorAll('[role="progressbar"]');
    const barValues = [];
    bars.forEach((el) => {
      const v = el.getAttribute('aria-valuenow') || el.getAttribute('aria-valuetext');
      if (v) barValues.push({ value: v, label: el.getAttribute('aria-label') || '' });
    });
    results.debug.barValues = barValues;

    // ── Reset times ──
    const resetMatches = allText.match(/resets?\s+in\s+([\d]+\s*(?:hr?|hour|min|m|d|day)[^\n,.]*)/gi);
    if (resetMatches) {
      results.resetTimes.raw = resetMatches.map((r) => r.trim());
    }

    // ── Extra usage / pay-as-you-go ──
    const extraMatch = allText.match(/extra\s+usage[^]*?(\$[\d.]+)/i);
    const extraPctMatch = allText.match(/extra\s+usage[^]*?(\d+)%/i);
    if (extraMatch || extraPctMatch) {
      results.extraUsage = {
        spent: extraMatch ? extraMatch[1] : null,
        percent: extraPctMatch ? parseInt(extraPctMatch[1]) : null,
      };
    }

    // ── Plan info ──
    const planMatch = allText.match(/(?:current\s+plan|you'?re?\s+on|plan)[:\s]*(pro|max\s*(?:5|20)|free|team)/i);
    if (planMatch) {
      results.planInfo = planMatch[1].trim().toLowerCase().replace(/\s+/, '');
    }

    // ── Billing ──
    const renewMatch = allText.match(/(?:renews?|next\s+billing)[:\s]*(\w+\s+\d+(?:,?\s*\d{4})?)/i);
    if (renewMatch) {
      results.billingRenewal = renewMatch[1].trim();
    }

    // ── Debug: page structure info (no sensitive message content) ──
    // Only send the usage-related portion of the page, not conversations
    const usageSection = allText.substring(0, MAX_DEBUG_TEXT);
    results.debug.pageTextStart = usageSection;
    results.debug.url = window.location.href;
    results.debug.title = document.title;

    // HTML structure hints: section headings and labels
    const headings = [];
    document.querySelectorAll('h1, h2, h3, h4, [class*="heading"], [class*="title"], [class*="label"]').forEach((el) => {
      const t = el.textContent?.trim();
      if (t && t.length < 100) headings.push(t);
    });
    results.debug.headings = headings.slice(0, 30);

    // Data attributes on progress-like elements
    const progressInfo = [];
    document.querySelectorAll('[role="progressbar"], [class*="progress"], [class*="meter"], [class*="usage"], [class*="limit"]').forEach((el) => {
      progressInfo.push({
        tag: el.tagName,
        classes: el.className?.toString().substring(0, 100),
        text: el.textContent?.trim().substring(0, 100),
        ariaValue: el.getAttribute('aria-valuenow'),
        ariaLabel: el.getAttribute('aria-label'),
        style: el.getAttribute('style')?.substring(0, 100),
      });
    });
    results.debug.progressElements = progressInfo.slice(0, 20);

    return results;
  }

  function reportUsage(data) {
    // Route through background service worker to avoid mixed content (HTTPS page → HTTP API)
    chrome.runtime.sendMessage({ type: 'reportUsage', data }, (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[Claude Usage Reporter] Report failed:', chrome.runtime.lastError.message);
        return;
      }
      console.log('[Claude Usage Reporter] Reported:', result);
      chrome.storage?.local?.set({
        lastReport: { ...data, response: result, at: Date.now() },
      });
    });
  }

  // Auto-extract 3s after page load
  setTimeout(() => {
    const data = extractUsage();
    console.log('[Claude Usage Reporter] Extracted:', data);
    reportUsage(data);
    try {
      chrome.runtime.sendMessage({ type: 'usageData', data });
    } catch { /* popup not open */ }
  }, 3000);

  // Listen for triggers from background/popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'extractNow') {
      const data = extractUsage();
      reportUsage(data);
      sendResponse(data);
    }
    if (msg.type === 'getDebug') {
      // Return full debug without reporting
      sendResponse(extractUsage());
    }
  });
})();
