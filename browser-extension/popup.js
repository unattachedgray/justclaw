document.getElementById('extract').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.url?.includes('claude.ai')) {
      document.getElementById('content').innerHTML =
        '<div class="status warn">Navigate to claude.ai/settings/usage first</div>';
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'extractNow' }, (data) => {
      if (chrome.runtime.lastError) {
        document.getElementById('content').innerHTML =
          '<div class="status warn">Reload the page (F5) and try again</div>';
        return;
      }
      showData(data);
    });
  });
});

document.getElementById('openUsage').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://claude.ai/settings/usage' });
});

// Load last stored report
chrome.storage.local.get('lastReport', (result) => {
  if (result.lastReport) showData(result.lastReport);
});

function showData(data) {
  if (!data) return;
  const content = document.getElementById('content');
  let html = '';

  const hasData = data.session !== null || data.weeklyAll !== null;
  html += hasData
    ? '<div class="status ok">Connected — reporting to dashboard</div>'
    : '<div class="status warn">Could not parse usage from page</div>';

  function meter(label, pct) {
    if (pct === null || pct === undefined) return '';
    const cls = pct > 80 ? 'high' : pct > 50 ? 'mid' : 'low';
    return `
      <div class="meter">
        <div class="meter-label"><span>${label}</span><span>${pct}%</span></div>
        <div class="meter-bar"><div class="meter-fill ${cls}" style="width:${Math.max(2, pct)}%"></div></div>
      </div>`;
  }

  html += meter('Session', data.session);
  html += meter('Weekly (all)', data.weeklyAll);
  html += meter('Weekly (Sonnet)', data.weeklySonnet);

  const extras = [];
  if (data.planInfo) extras.push({ label: 'Plan', value: data.planInfo });
  if (data.extraUsage?.spent) extras.push({ label: 'Extra spent', value: data.extraUsage.spent });
  if (data.resetTimes?.raw?.length) extras.push({ label: 'Resets', value: data.resetTimes.raw[0] });

  if (extras.length > 0) {
    html += '<div class="divider"></div>';
    for (const e of extras) {
      html += `<div class="info-row"><span class="label">${e.label}</span><span>${e.value}</span></div>`;
    }
  }

  content.innerHTML = html;

  const ts = data.timestamp || data.at;
  if (ts) {
    document.getElementById('lastUpdate').textContent =
      'Last update: ' + new Date(ts).toLocaleTimeString();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'usageData') showData(msg.data);
});
