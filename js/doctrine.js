/**
 * doctrine.js — Doctrine Builder page controller
 *
 * Shows one column per threat type, in the order the engine processes them
 * (doctrine.typeOrder). Each column lists the systems allowed to engage that
 * type, outermost first (doctrine.engage[type]). A system absent from a
 * column never engages that type. The page exports a doctrine JSON file
 * that the tool's "Import Doctrine" button accepts.
 *
 * A system listed in doctrine.locked (an allied asset the facilitator does
 * not control) is shown with a lock, keeps its position, and cannot be
 * removed or cleared.
 *
 * Column headers drag left/right to reorder the types; cards drag up/down
 * to reorder within a column. ◀ ▶ and ▲ ▼ buttons do the same without a
 * pointer. Dragging a card into another column is not supported: a drag
 * only ever reorders within its own column.
 *
 * State is held in memory and mirrored to localStorage under its own key so
 * an accidental reload doesn't lose work. Nothing here touches app.js state.
 */

const DOCTRINE_STORAGE_KEY  = 'threatmodel_doctrine_builder_v1';
const DOCTRINE_DEFAULT_NAME = 'Custom Doctrine';   // used when the name field is left blank
const DRAG_THRESHOLD_PX     = 4;                   // pointer travel before a press becomes a drag

let doctrine     = emptyDoctrine();   // { typeOrder: [type], engage: { [type]: [systemId] }, locked: [systemId] }
let doctrineName = '';

// ─────────────────────────────────────────────────────────────────────────────
// State helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A doctrine with every known threat type, in engine order, and no systems. */
function emptyDoctrine() {
  const engage = {};
  for (const t of THREAT_TYPES) engage[t] = [];
  return { typeOrder: THREAT_TYPES.slice(), engage, locked: [] };
}

/** Locked systems stay where the file put them: no drag, ▲ ▼, ✕ or Clear All. */
function isLocked(systemId) { return (doctrine.locked || []).includes(systemId); }

/**
 * After any reorder of `list`, put every locked system back at the index it
 * held in `before`, so other cards can move around it but never displace it.
 */
function enforceLocked(list, before) {
  for (const id of doctrine.locked || []) {
    const was = before.indexOf(id);
    if (was < 0) continue;
    const now = list.indexOf(id);
    if (now === was) continue;
    if (now >= 0) list.splice(now, 1);
    list.splice(Math.min(was, list.length), 0, id);
  }
  return list;
}

function persistDoctrine() {
  saveBuilderState(DOCTRINE_STORAGE_KEY, { name: doctrineName, doctrine });
}

/** Returns true if a saved draft existed (even an empty one). */
function restoreDoctrine() {
  const s = loadBuilderState(DOCTRINE_STORAGE_KEY);
  if (!s) return false;
  doctrineName = typeof s.name === 'string' ? s.name : '';
  try {
    const warnings = applyDoctrineData(s.doctrine);
    if (warnings.length) console.warn('[doctrine] restoreDoctrine warnings:', warnings);
  } catch {
    doctrine = emptyDoctrine();
  }
  return true;
}

function systemsFor(type) { return doctrine.engage[type] || []; }

function totalEntries() {
  return doctrine.typeOrder.reduce((n, t) => n + systemsFor(t).length, 0);
}

function typesWithEntries() {
  return doctrine.typeOrder.filter(t => systemsFor(t).length > 0).length;
}

/** All catalog systems, ordered by tier then name — the order the picker uses. */
function sortedSystems() {
  return Object.values(DEFENSE_CATALOG).sort((a, b) =>
    (a.tier - b.tier) || a.name.localeCompare(b.name));
}

/** Catalog systems not yet listed in the column for `type`. */
function availableSystems(type) {
  const present = new Set(systemsFor(type));
  return sortedSystems().filter(s => !present.has(s.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function pluralize(n, word) { return `${n} ${word}${n !== 1 ? 's' : ''}`; }

/** "N system entries" — one entry is one system listed under one threat type. */
function entriesLabel(n) { return `${n} system entr${n !== 1 ? 'ies' : 'y'}`; }

/** Rebuild every column from state. */
function renderAll() {
  const main = document.getElementById('builder-main');
  main.innerHTML = '';

  const board = document.createElement('div');
  board.className = 'dc-board';
  board.id = 'dc-board';
  doctrine.typeOrder.forEach((type, index) => board.appendChild(buildColumn(type, index)));
  main.appendChild(board);

  updateCounts();
}

/** Column badges and the ◀ ▶ enabled state, without re-rendering cards. */
function updateCounts() {
  const last = doctrine.typeOrder.length - 1;
  doctrine.typeOrder.forEach((type, index) => {
    const col = columnEl(type);
    if (!col) return;
    const n = systemsFor(type).length;
    col.querySelector('.dc-col-count').textContent = pluralize(n, 'system');
    col.querySelector('.dc-col-order').textContent = String(index + 1);
    col.querySelector('.dc-col-left').disabled  = index === 0;
    col.querySelector('.dc-col-right').disabled = index === last;
    col.classList.toggle('has-systems', n > 0);
  });
}

function columnEl(type) {
  return document.querySelector(`.dc-col[data-type="${type}"]`);
}

/**
 * Build one threat-type column: header (drag handle, order number, label,
 * count badge, ◀ ▶), the card list, and the "+ Add system" slot.
 */
function buildColumn(type, index) {
  const col = document.createElement('section');
  col.className    = 'dc-col';
  col.dataset.type = type;
  col.innerHTML = `
    <div class="dc-col-head" title="Drag to change the processing order">
      <span class="dc-grip" aria-hidden="true">⠿</span>
      <span class="dc-col-order">${index + 1}</span>
      <h2 class="dc-col-title">${escapeHtml(THREAT_TYPE_LABELS[type] || type)}</h2>
      <span class="badge dc-col-count">0 systems</span>
      <span class="dc-col-nav">
        <button type="button" class="btn-icon dc-nav-btn dc-col-left"  title="Process earlier">◀</button>
        <button type="button" class="btn-icon dc-nav-btn dc-col-right" title="Process later">▶</button>
      </span>
    </div>
    <div class="dc-list"></div>
    <div class="dc-add"></div>`;

  const head = col.querySelector('.dc-col-head');
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    startPointerDrag(e, head, col, col.parentElement, 'x', 'dc-col-placeholder', newIndex => {
      moveType(doctrine.typeOrder.indexOf(type), newIndex);
    });
  });
  col.querySelector('.dc-col-left').addEventListener('click', () => {
    const i = doctrine.typeOrder.indexOf(type);
    moveType(i, i - 1);
  });
  col.querySelector('.dc-col-right').addEventListener('click', () => {
    const i = doctrine.typeOrder.indexOf(type);
    moveType(i, i + 1);
  });

  fillColumn(col, type);
  return col;
}

/** Re-render a single column's cards and add slot in place. */
function refreshColumn(type) {
  const col = columnEl(type);
  if (col) fillColumn(col, type);
  updateCounts();
}

function fillColumn(col, type) {
  const list = col.querySelector('.dc-list');
  list.innerHTML = '';
  const systems = systemsFor(type);
  if (systems.length === 0) {
    list.innerHTML = '<p class="empty-state dc-empty">No system engages this type</p>';
  } else {
    systems.forEach((systemId, index) => list.appendChild(buildCard(type, systemId, index, systems.length)));
  }
  renderAddSlot(col, type);
}

/** One system card: tier stripe, name, "tier N · model", ▲ ▼ and ✕. */
function buildCard(type, systemId, index, count) {
  const catalog = DEFENSE_CATALOG[systemId];
  const card = document.createElement('div');
  card.className      = 'dc-card';
  card.dataset.system = systemId;
  card.style.setProperty('--tier-color', TIER_COLORS[catalog?.tier] || '#888');

  const model     = catalog?.engagement?.model || 'kinetic';
  const engages   = systemThreatTypes(doctrine, systemId).map(t => THREAT_TYPE_LABELS[t] || t);
  const locked    = isLocked(systemId);
  card.title      = `${catalog?.name || systemId} — engages: ${engages.join(', ')}`
                  + (locked ? ' — fixed in place: this asset is not under U.S. control and cannot be moved or removed' : '');
  if (locked) card.classList.add('dc-card--locked');
  card.innerHTML  = `
    <span class="${locked ? 'dc-lock' : 'dc-grip'}" aria-hidden="true">${locked ? '🔒' : '⠿'}</span>
    <div class="dc-card-main">
      <span class="dc-card-name">${escapeHtml(catalog ? systemShortLabel(catalog) : systemId)}</span>
      <span class="dc-card-sub">tier ${escapeHtml(catalog?.tier ?? '?')} · ${escapeHtml(model)}${locked ? ' · locked' : ''}</span>
    </div>
    ${locked ? '' : `
    <span class="dc-card-nav">
      <button type="button" class="btn-icon dc-nav-btn dc-btn-up"   title="Move up"   ${index === 0 ? 'disabled' : ''}>▲</button>
      <button type="button" class="btn-icon dc-nav-btn dc-btn-down" title="Move down" ${index === count - 1 ? 'disabled' : ''}>▼</button>
    </span>
    <button type="button" class="btn-icon dc-btn-remove" title="Remove from this type">✕</button>`}`;

  if (locked) return card;   // no reordering, removal, or drag for a locked system

  card.querySelector('.dc-btn-up').addEventListener('click',     () => moveSystem(type, index, index - 1));
  card.querySelector('.dc-btn-down').addEventListener('click',   () => moveSystem(type, index, index + 1));
  card.querySelector('.dc-btn-remove').addEventListener('click', () => removeSystem(type, index));

  card.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    startPointerDrag(e, card, card, card.parentElement, 'y', 'dc-card-placeholder', newIndex => {
      moveSystem(type, systemsFor(type).indexOf(systemId), newIndex);
    });
  });
  return card;
}

// ─────────────────────────────────────────────────────────────────────────────
// "+ Add system" slot and inline picker (only one picker open at a time)
// ─────────────────────────────────────────────────────────────────────────────

function renderAddSlot(col, type) {
  const slot = col.querySelector('.dc-add');
  const available = availableSystems(type);
  slot.innerHTML = '';

  const btn = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'dc-add-slot';
  if (available.length === 0) {
    btn.textContent = 'All systems listed';
    btn.disabled    = true;
  } else {
    btn.textContent = '+ Add system';
    btn.addEventListener('click', () => openPicker(col, type));
  }
  slot.appendChild(btn);
}

function openPicker(col, type) {
  for (const other of document.querySelectorAll('.dc-col .dc-add')) {
    if (other.querySelector('.dc-picker')) renderAddSlot(other.closest('.dc-col'), other.closest('.dc-col').dataset.type);
  }
  const slot = col.querySelector('.dc-add');
  slot.innerHTML = `
    <div class="dc-picker">
      <select class="dc-picker-select"></select>
      <div class="form-row">
        <button type="button" class="btn btn-primary btn-sm dc-picker-add">Add</button>
        <button type="button" class="btn btn-secondary btn-sm dc-picker-cancel">Cancel</button>
      </div>
    </div>`;

  const sel = slot.querySelector('.dc-picker-select');
  for (const sys of availableSystems(type)) {
    const opt = document.createElement('option');
    opt.value       = sys.id;
    opt.textContent = `${systemShortLabel(sys)} — tier ${sys.tier}`;
    sel.appendChild(opt);
  }

  const confirm = () => {
    if (!sel.value) { showToast('Please select a system.', true); return; }
    addSystem(type, sel.value);
  };
  slot.querySelector('.dc-picker-add').addEventListener('click', confirm);
  slot.querySelector('.dc-picker-cancel').addEventListener('click', () => renderAddSlot(col, type));
  sel.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); });
  sel.focus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctrine CRUD
// ─────────────────────────────────────────────────────────────────────────────

/** Append a system to a column (ignored if it is already there). */
function addSystem(type, systemId) {
  const catalog = DEFENSE_CATALOG[systemId];
  if (!catalog) { showToast(`Unknown system "${systemId}".`, true); return; }
  const list = systemsFor(type);
  if (list.includes(systemId)) {
    showToast(`${catalog.name} is already listed for ${THREAT_TYPE_LABELS[type] || type}.`, true);
    return;
  }
  doctrine.engage[type] = [...list, systemId];
  persistDoctrine();
  refreshColumn(type);
  showToast(`Added ${catalog.name} to ${THREAT_TYPE_LABELS[type] || type}.`);
}

function removeSystem(type, index) {
  const list = systemsFor(type);
  if (index < 0 || index >= list.length) return;
  if (isLocked(list[index])) { showToast('That system is locked in place and cannot be removed.', true); return; }
  list.splice(index, 1);
  persistDoctrine();
  refreshColumn(type);
}

/** Move the card at `from` to position `to` within one column. */
function moveSystem(type, from, to) {
  const list = systemsFor(type);
  if (from < 0 || from >= list.length) return;
  to = Math.max(0, Math.min(list.length - 1, to));
  if (from === to) { refreshColumn(type); return; }
  if (isLocked(list[from])) { showToast('That system is locked in place and cannot be moved.', true); refreshColumn(type); return; }
  const before = list.slice();
  const [id] = list.splice(from, 1);
  list.splice(to, 0, id);
  enforceLocked(list, before);
  persistDoctrine();
  refreshColumn(type);
}

/** Move the column at `from` to position `to` in the processing order. */
function moveType(from, to) {
  const order = doctrine.typeOrder;
  if (from < 0 || from >= order.length) return;
  to = Math.max(0, Math.min(order.length - 1, to));
  if (from === to) { renderAll(); return; }
  const [t] = order.splice(from, 1);
  order.splice(to, 0, t);
  persistDoctrine();
  renderAll();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pointer drag — shared by cards (vertical) and column headers (horizontal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Begin a pointer-driven reorder of `item` among the children of
 * `container`. The press becomes a drag after DRAG_THRESHOLD_PX of travel:
 * the item turns into a fixed-position ghost that follows the pointer along
 * `axis`, and a placeholder of the same size holds its gap. The placeholder
 * jumps past a sibling when the pointer crosses that sibling's midpoint.
 * On release, onCommit(newIndex) receives the item's index among its
 * siblings; the caller updates state and re-renders.
 *
 * @param {PointerEvent} e           the pointerdown event
 * @param {HTMLElement}  handle      element that captures the pointer
 * @param {HTMLElement}  item        element that moves (card or column)
 * @param {HTMLElement}  container   parent whose children are reordered
 * @param {'x'|'y'}      axis        drag axis
 * @param {string}       placeholderClass  class for the gap element
 * @param {function(number):void} onCommit
 */
function startPointerDrag(e, handle, item, container, axis, placeholderClass, onCommit) {
  if (e.button !== 0 || !container) return;
  const startX = e.clientX, startY = e.clientY;
  const pointerId = e.pointerId;
  let dragging    = false;
  let placeholder = null;
  let grabDx = 0, grabDy = 0;

  const px = v => `${Math.round(v)}px`;

  const begin = () => {
    dragging = true;
    const r = item.getBoundingClientRect();
    grabDx = startX - r.left;
    grabDy = startY - r.top;

    placeholder = document.createElement('div');
    placeholder.className = placeholderClass;
    placeholder.style.setProperty('--drag-w', px(r.width));
    placeholder.style.setProperty('--drag-h', px(r.height));
    container.insertBefore(placeholder, item);

    item.style.setProperty('--drag-w', px(r.width));
    item.style.setProperty('--drag-h', px(r.height));
    item.style.setProperty('--drag-x', px(r.left));
    item.style.setProperty('--drag-y', px(r.top));
    item.classList.add('drag-ghost');
    document.body.classList.add('is-dragging');
  };

  const siblings = () => [...container.children].filter(el => el !== item && el !== placeholder);

  const onMove = ev => {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX &&
          Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      begin();
    }
    ev.preventDefault();
    if (axis === 'y') item.style.setProperty('--drag-y', px(ev.clientY - grabDy));
    else              item.style.setProperty('--drag-x', px(ev.clientX - grabDx));

    // Place the gap after every sibling whose midpoint the pointer has passed.
    const p = axis === 'y' ? ev.clientY : ev.clientX;
    const sibs = siblings();
    let idx = 0;
    for (const sib of sibs) {
      const r   = sib.getBoundingClientRect();
      const mid = axis === 'y' ? r.top + r.height / 2 : r.left + r.width / 2;
      if (p > mid) idx++;
    }
    container.insertBefore(placeholder, sibs[idx] || null);
  };

  const finish = () => {
    handle.removeEventListener('pointermove',   onMove);
    handle.removeEventListener('pointerup',     onUp);
    handle.removeEventListener('pointercancel', onCancel);
    try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
    if (!dragging) return null;

    const newIndex = [...container.children].filter(el => el !== item).indexOf(placeholder);
    item.classList.remove('drag-ghost');
    for (const prop of ['--drag-w', '--drag-h', '--drag-x', '--drag-y']) item.style.removeProperty(prop);
    placeholder.remove();
    document.body.classList.remove('is-dragging');
    return newIndex;
  };

  const onUp = () => {
    const newIndex = finish();
    if (newIndex !== null && newIndex >= 0) onCommit(newIndex);
  };
  const onCancel = () => { finish(); };

  try { handle.setPointerCapture(pointerId); } catch { /* not a capturable pointer */ }
  handle.addEventListener('pointermove',   onMove);
  handle.addEventListener('pointerup',     onUp);
  handle.addEventListener('pointercancel', onCancel);
}

// ─────────────────────────────────────────────────────────────────────────────
// Import (file or doctrine.json) → builder state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a doctrine-file object ({ typeOrder, engage }) into builder state
 * via normalizeDoctrine(): unknown types and unknown or duplicate systems
 * are dropped with a warning. Threat types missing from typeOrder are
 * appended (with empty lists) so the page always shows every column.
 * Returns the list of warnings. Does NOT touch doctrineName.
 */
function applyDoctrineData(data) {
  if (!data || !Array.isArray(data.typeOrder)) {
    throw new Error('file must contain a "typeOrder" array');
  }
  if (!data.engage || typeof data.engage !== 'object' || Array.isArray(data.engage)) {
    throw new Error('file must contain an "engage" object');
  }
  const { doctrine: norm, warnings } = normalizeDoctrine(data, DEFENSE_CATALOG);

  const next = { typeOrder: norm.typeOrder.slice(), engage: {}, locked: (norm.locked || []).slice() };
  for (const t of THREAT_TYPES) if (!next.typeOrder.includes(t)) next.typeOrder.push(t);
  for (const t of next.typeOrder) next.engage[t] = (norm.engage[t] || []).slice();

  doctrine = next;
  return warnings;
}

async function confirmDiscardIfNeeded(actionLabel) {
  if (totalEntries() === 0) return true;
  return showModal({
    title:   `${actionLabel}?`,
    message: `This will replace the ${entriesLabel(totalEntries())} currently in this draft. Continue?`,
    buttons: [
      { label: 'Continue', value: true,  style: 'danger'    },
      { label: 'Cancel',   value: false, style: 'secondary' }
    ]
  });
}

/** Fetch data/doctrine.json into the draft. Returns warnings, or null on failure. */
async function fetchDefaultsIntoDraft() {
  let data;
  try {
    data = await fetch('data/doctrine.json').then(r => r.json());
  } catch (err) {
    showToast('Could not load data/doctrine.json: ' + err.message, true);
    return null;
  }
  try { return applyDoctrineData(data); }
  catch (err) { showToast('Load failed — ' + err.message, true); return null; }
}

async function loadDefaultDoctrine() {
  if (!await confirmDiscardIfNeeded('Load Default Doctrine')) return;
  const warnings = await fetchDefaultsIntoDraft();
  if (warnings === null) return;
  persistDoctrine();
  renderAll();
  finishImportToast('Default doctrine loaded', warnings, '[doctrine] loadDefaultDoctrine');
}

async function importDoctrineFile(file) {
  if (!await confirmDiscardIfNeeded('Import Doctrine')) return;
  let data;
  try { data = await readJSONFile(file); }
  catch (err) { showToast('Import failed — ' + err.message, true); return; }

  let warnings;
  try { warnings = applyDoctrineData(data); }
  catch (err) { showToast('Import failed — ' + err.message, true); return; }

  if (typeof data.name === 'string' && data.name.trim()) {
    doctrineName = data.name.trim();
    document.getElementById('doctrine-name').value = doctrineName;
  }
  persistDoctrine();
  renderAll();
  finishImportToast('Doctrine imported', warnings, '[doctrine] importDoctrineFile');
}

function finishImportToast(prefix, warnings, logTag) {
  const n = totalEntries();
  const t = typesWithEntries();
  let msg = `${prefix} — ${entriesLabel(n)} across ${pluralize(t, 'threat type')}.`;
  if (warnings.length) {
    msg += ` ${pluralize(warnings.length, 'warning')} (see console).`;
    console.warn(`${logTag} warnings:`, warnings);
  }
  showToast(msg, warnings.length > 0);
}

async function clearAll() {
  if (totalEntries() === 0) { showToast('Nothing to clear.'); return; }
  const ok = await showModal({
    title:   'Clear All?',
    message: `Remove all ${entriesLabel(totalEntries())} from every threat type in this draft?`,
    buttons: [
      { label: 'Clear',  value: true,  style: 'danger'    },
      { label: 'Cancel', value: false, style: 'secondary' }
    ]
  });
  if (!ok) return;
  for (const t of doctrine.typeOrder) doctrine.engage[t] = systemsFor(t).filter(isLocked);   // locked systems stay
  persistDoctrine();
  renderAll();
  showToast(doctrine.locked?.length ? 'Draft cleared — locked systems kept.' : 'Draft cleared.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the doctrine file object. `engage` carries every type in typeOrder,
 * including types with an empty list, so the tool's import sees the full
 * processing order.
 */
function buildDoctrineExport(name) {
  const engage = {};
  for (const t of doctrine.typeOrder) engage[t] = systemsFor(t).slice();
  const locked = (doctrine.locked || []).filter(id => doctrine.typeOrder.some(t => systemsFor(t).includes(id)));
  return { version: '1.0', name, typeOrder: doctrine.typeOrder.slice(), locked, engage };
}

function exportDoctrine() {
  const input = document.getElementById('doctrine-name');
  const name  = (input.value || '').trim() || DOCTRINE_DEFAULT_NAME;
  if (totalEntries() === 0) {
    showToast('Add at least one system to a threat type before exporting.', true);
    return;
  }
  const file = buildDoctrineExport(name);
  downloadJSON(`${slugify(name) || 'doctrine'}_doctrine.json`, file);
  const n = totalEntries(), t = typesWithEntries();
  showToast(`Exported "${name}" — ${entriesLabel(n)} across ${pluralize(t, 'threat type')}.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring + bootstrap
// ─────────────────────────────────────────────────────────────────────────────

function wireDoctrineEvents() {
  const nameInput = document.getElementById('doctrine-name');
  nameInput.addEventListener('input', () => {
    doctrineName = nameInput.value;
    persistDoctrine();
  });

  document.getElementById('btn-load-defaults').addEventListener('click', loadDefaultDoctrine);
  document.getElementById('btn-clear-all').addEventListener('click', clearAll);
  document.getElementById('btn-export-doctrine').addEventListener('click', exportDoctrine);

  document.getElementById('btn-import-doctrine').addEventListener('click', () => {
    document.getElementById('import-doctrine-input').click();
  });
  document.getElementById('import-doctrine-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) importDoctrineFile(file);
    e.target.value = '';
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('modal-overlay').classList.contains('hidden')) {
      _resolveModal(false);
    }
  });
}

async function initDoctrine() {
  await loadCatalogs();
  const hadDraft = restoreDoctrine();
  document.getElementById('doctrine-name').value = doctrineName;
  renderAll();
  wireDoctrineEvents();

  // First visit (no saved draft): start from the tool's default doctrine so
  // facilitators edit the baseline rather than an empty page.
  if (!hadDraft) {
    const warnings = await fetchDefaultsIntoDraft();
    if (warnings !== null) {
      persistDoctrine();
      renderAll();
      finishImportToast('Default doctrine loaded', warnings, '[doctrine] initDoctrine');
    }
  }

  // Automation hooks (used by the Playwright tests)
  window._doctrineState       = () => ({ name: doctrineName, doctrine: JSON.parse(JSON.stringify(doctrine)) });
  window._doctrineBuildExport = buildDoctrineExport;
  window._doctrineApplyData   = data => {
    const warnings = applyDoctrineData(data);
    persistDoctrine();
    renderAll();
    return warnings;
  };
  window._doctrineReady       = true;
}

document.addEventListener('DOMContentLoaded', initDoctrine);
