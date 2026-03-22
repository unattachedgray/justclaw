/** Dashboard edit mode — drag-and-drop reorder, hide/show, collapse panels. */

export function getEditToggleHtml(): string {
  return `<button class="theme-toggle edit-toggle" id="edit-toggle" onclick="toggleEditMode()" title="Customize dashboard layout">
  &#9998; <span id="edit-label">Edit</span>
</button>`;
}

export function getEditModeStyles(): string {
  return `
/* Edit mode toggle */
.edit-toggle.active { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 8px rgba(88,166,255,0.3); }

/* Drag handle + hide/collapse buttons — hidden outside edit mode */
.drag-handle, .hide-btn, .collapse-btn { display: none; }
body.edit-mode .drag-handle { display: inline-block; cursor: grab; padding: 0 4px; color: var(--text2); font-size: 0.85rem; user-select: none; }
body.edit-mode .hide-btn, body.edit-mode .collapse-btn {
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 1px 5px; font-size: 0.65rem; color: var(--text2);
  background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; margin-left: 4px;
}
body.edit-mode .hide-btn:hover { color: var(--red); border-color: var(--red); }
body.edit-mode .collapse-btn:hover { color: var(--accent); border-color: var(--accent); }

/* Edit mode visual: dashed outline on panels */
body.edit-mode .grid-overview .panel { outline: 2px dashed rgba(88,166,255,0.25); outline-offset: -2px; }
body.edit-mode .stat-card { outline: 1px dashed rgba(88,166,255,0.2); outline-offset: -1px; cursor: grab; }

/* Drag states */
.dragging { opacity: 0.3 !important; }
.drag-over { outline: 2px solid var(--accent) !important; outline-offset: -2px; }

/* Hidden items */
.panel-hidden { display: none !important; }
body.edit-mode .panel-hidden { display: flex !important; opacity: 0.25; border-style: dashed !important; }
body.edit-mode .stat-card.panel-hidden { display: block !important; opacity: 0.25; border-style: dashed !important; }

/* Collapsed panels — show header only */
.panel.collapsed .panel-body { display: none; }
.panel.collapsed { min-height: 0; }
.collapse-indicator { font-size: 0.6rem; color: var(--text2); margin-left: 4px; transition: transform 0.15s; display: inline-block; }
.panel.collapsed .collapse-indicator { transform: rotate(-90deg); }

/* Double-click hint in edit mode */
body.edit-mode .panel-header { cursor: pointer; }

/* Reset button */
.reset-layout-btn {
  display: none; font-size: 0.6rem; padding: 2px 8px; margin-left: 4px;
  color: var(--red); border: 1px solid var(--red); border-radius: 4px;
  background: transparent; cursor: pointer;
}
body.edit-mode .reset-layout-btn { display: inline-block; }
.reset-layout-btn:hover { background: var(--red); color: #fff; }
`;
}

export function getEditModeScripts(): string {
  return `
// --- Dashboard Edit Mode ---
let _editMode = false;
const LAYOUT_KEY = 'justclaw-dashboard-layout';
const DEFAULT_GRID_ORDER = ['panel-tasks','panel-scheduled','panel-memories','panel-convos','panel-dailylog','panel-heatmap'];
const DEFAULT_STAT_ORDER = ['stat-messages','stat-queue','stat-runs','stat-memories','stat-ram','stat-disk'];

function getLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { return {}; }
}
function saveLayout() {
  const grid = document.querySelector('.grid-overview');
  const stats = $('stats');
  const layout = {
    hidden: [...document.querySelectorAll('.panel-hidden')].map(e => e.dataset.pid).filter(Boolean),
    collapsed: [...document.querySelectorAll('.panel.collapsed')].map(e => e.dataset.pid).filter(Boolean),
    gridOrder: grid ? [...grid.children].map(e => e.dataset.pid).filter(Boolean) : [],
    statOrder: stats ? [...stats.children].map(e => e.dataset.sid).filter(Boolean) : [],
  };
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
}

function applyLayout() {
  const layout = getLayout();
  if (!layout.gridOrder && !layout.hidden) return;
  // Reorder grid panels
  const grid = document.querySelector('.grid-overview');
  if (grid && layout.gridOrder?.length) {
    for (const id of layout.gridOrder) {
      const el = grid.querySelector('[data-pid="' + id + '"]');
      if (el) grid.appendChild(el);
    }
  }
  // Apply hidden
  if (layout.hidden) {
    for (const id of layout.hidden) {
      const el = document.querySelector('[data-pid="' + id + '"], [data-sid="' + id + '"]');
      if (el) el.classList.add('panel-hidden');
    }
  }
  // Apply collapsed
  if (layout.collapsed) {
    for (const id of layout.collapsed) {
      const el = document.querySelector('[data-pid="' + id + '"]');
      if (el) el.classList.add('collapsed');
    }
  }
}

function applyStatLayout() {
  const layout = getLayout();
  const stats = $('stats');
  if (!stats) return;
  // Reorder stat cards
  if (layout.statOrder?.length) {
    for (const id of layout.statOrder) {
      const el = stats.querySelector('[data-sid="' + id + '"]');
      if (el) stats.appendChild(el);
    }
  }
  // Re-apply hidden to stats
  if (layout.hidden) {
    for (const id of layout.hidden) {
      const el = stats.querySelector('[data-sid="' + id + '"]');
      if (el) el.classList.add('panel-hidden');
    }
  }
}

function toggleEditMode() {
  _editMode = !_editMode;
  document.body.classList.toggle('edit-mode', _editMode);
  $('edit-toggle').classList.toggle('active', _editMode);
  $('edit-label').textContent = _editMode ? 'Done' : 'Edit';
  const grid = document.querySelector('.grid-overview');
  // Inject or remove edit controls
  if (_editMode) {
    // Panels: add drag handle, hide btn, collapse btn
    grid?.querySelectorAll('.panel[data-pid]').forEach(panel => {
      panel.setAttribute('draggable', 'true');
      const hdr = panel.querySelector('.panel-header');
      if (hdr && !hdr.querySelector('.drag-handle')) {
        hdr.insertAdjacentHTML('afterbegin', '<span class="drag-handle" title="Drag to reorder">&#9776;</span>');
        hdr.insertAdjacentHTML('beforeend',
          '<span class="collapse-btn" onclick="event.stopPropagation();toggleCollapse(\\'' + panel.dataset.pid + '\\')" title="Collapse">&#9660;</span>' +
          '<span class="hide-btn" onclick="event.stopPropagation();toggleHide(\\'' + panel.dataset.pid + '\\')" title="Hide">&#10005;</span>');
      }
    });
    // Stat cards: add hide btn
    $('stats')?.querySelectorAll('.stat-card[data-sid]').forEach(card => {
      card.setAttribute('draggable', 'true');
      if (!card.querySelector('.hide-btn')) {
        card.insertAdjacentHTML('beforeend',
          '<span class="hide-btn" onclick="event.stopPropagation();toggleHide(\\'' + card.dataset.sid + '\\')" style="position:absolute;top:4px;right:4px" title="Hide">&#10005;</span>');
        card.style.position = 'relative';
      }
    });
  } else {
    // Remove all injected controls
    document.querySelectorAll('.drag-handle, .hide-btn, .collapse-btn').forEach(e => e.remove());
    document.querySelectorAll('[draggable="true"]').forEach(e => e.setAttribute('draggable', 'false'));
    document.querySelectorAll('.stat-card').forEach(e => { e.style.position = ''; });
    saveLayout();
  }
}

function toggleHide(id) {
  const el = document.querySelector('[data-pid="' + id + '"], [data-sid="' + id + '"]');
  if (el) { el.classList.toggle('panel-hidden'); saveLayout(); }
}

function toggleCollapse(id) {
  const el = document.querySelector('[data-pid="' + id + '"]');
  if (el) { el.classList.toggle('collapsed'); saveLayout(); }
}

function resetLayout() {
  localStorage.removeItem(LAYOUT_KEY);
  document.querySelectorAll('.panel-hidden').forEach(e => e.classList.remove('panel-hidden'));
  document.querySelectorAll('.collapsed').forEach(e => e.classList.remove('collapsed'));
  const grid = document.querySelector('.grid-overview');
  if (grid) DEFAULT_GRID_ORDER.forEach(id => { const el = grid.querySelector('[data-pid="' + id + '"]'); if (el) grid.appendChild(el); });
  saveLayout();
}

// Double-click panel header to collapse (works outside edit mode too)
document.addEventListener('dblclick', e => {
  const hdr = e.target.closest('.panel-header');
  if (!hdr) return;
  const panel = hdr.closest('.panel[data-pid]');
  if (panel) { panel.classList.toggle('collapsed'); saveLayout(); }
});

// --- HTML5 Drag-and-Drop ---
function initDrag(containerSel, itemAttr) {
  const container = document.querySelector(containerSel);
  if (!container) return;
  let dragEl = null;
  container.addEventListener('dragstart', e => {
    if (!_editMode) { e.preventDefault(); return; }
    dragEl = e.target.closest('[' + itemAttr + ']');
    if (!dragEl) return;
    dragEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  });
  container.addEventListener('dragover', e => {
    if (!_editMode || !dragEl) return;
    e.preventDefault();
    const target = e.target.closest('[' + itemAttr + ']');
    if (!target || target === dragEl) return;
    const rect = target.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (e.clientY < mid) container.insertBefore(dragEl, target);
    else container.insertBefore(dragEl, target.nextSibling);
  });
  container.addEventListener('dragenter', e => {
    const target = e.target.closest('[' + itemAttr + ']');
    if (target && target !== dragEl) target.classList.add('drag-over');
  });
  container.addEventListener('dragleave', e => {
    const target = e.target.closest('[' + itemAttr + ']');
    if (target) target.classList.remove('drag-over');
  });
  container.addEventListener('drop', e => {
    e.preventDefault();
    container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  container.addEventListener('dragend', () => {
    if (dragEl) dragEl.classList.remove('dragging');
    container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    dragEl = null;
    saveLayout();
  });
}

// Init drag on grid panels and stat cards
initDrag('.grid-overview', 'data-pid');
initDrag('#stats', 'data-sid');

// Apply saved layout on load
applyLayout();
`;
}
