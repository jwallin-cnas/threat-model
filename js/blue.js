/**
 * blue.js — Laydown Builder (Blue Team) page controller
 *
 * Shows every target on one page, grouped by country. Each target card has
 * the same "+ Add Defense System" form as the main tool (plus Operator and
 * Reloads fields) and exports a laydown JSON file that the tool's
 * "Import Laydown" button accepts.
 *
 * Quantity semantics: quantities are in FILE units (what defaults.json
 * stores). importLaydown() multiplies by defenses.json `batteries`, so one
 * Patriot "system" becomes 3 batteries (36 interceptors) inside the tool.
 *
 * State is held in memory and mirrored to localStorage under its own key so
 * an accidental reload doesn't lose work. Nothing here touches app.js state.
 */

const BLUE_STORAGE_KEY   = 'threatmodel_blue_builder_v1';
const BLUE_DEFAULT_NAME  = 'Blue Laydown';   // used when the name field is left blank
const RELOAD_OPTIONS   = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

let laydown     = {};   // { [targetId]: [ { system, quantity, notes, operator, reloads } ] }
let laydownName = '';

// ─────────────────────────────────────────────────────────────────────────────
// State helpers
// ─────────────────────────────────────────────────────────────────────────────

function persistBlue() {
  saveBuilderState(BLUE_STORAGE_KEY, { name: laydownName, laydown });
}

/** Returns true if a saved draft existed (even an empty one). */
function restoreBlue() {
  const s = loadBuilderState(BLUE_STORAGE_KEY);
  if (!s) return false;
  laydownName = typeof s.name === 'string' ? s.name : '';
  laydown     = (s.laydown && typeof s.laydown === 'object' && !Array.isArray(s.laydown)) ? s.laydown : {};
  return true;
}

function entriesFor(targetId) { return laydown[targetId] || []; }

function totalEntries() {
  return Object.values(laydown).reduce((n, arr) => n + arr.length, 0);
}

function targetsWithEntries() {
  return Object.keys(laydown).filter(id => laydown[id].length > 0).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function countryDomId(country) { return 'country_' + slugify(country); }

function renderAll() {
  const main  = document.getElementById('builder-main');
  const pills = document.getElementById('country-pills');
  main.innerHTML  = '';
  pills.innerHTML = '';

  for (const [country, targets] of targetsByCountry()) {
    const cid = countryDomId(country);

    const section = document.createElement('section');
    section.className = 'country-section';
    section.id = cid;
    section.innerHTML = `
      <div class="country-header">
        <h2>${escapeHtml(country)}</h2>
        <span class="badge" data-country-badge="${cid}">0 systems</span>
      </div>
      <div class="target-grid"></div>`;
    const grid = section.querySelector('.target-grid');
    for (const t of targets) grid.appendChild(buildCard(t));
    main.appendChild(section);

    const pill = document.createElement('button');
    pill.type      = 'button';
    pill.className = 'country-pill';
    pill.innerHTML = `${escapeHtml(country)} <span class="pill-count" data-pill-count="${cid}">0</span>`;
    pill.addEventListener('click', () => {
      document.getElementById(cid)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    pills.appendChild(pill);
  }

  updateCounts();
}

function updateCounts() {
  for (const [country, targets] of targetsByCountry()) {
    const cid   = countryDomId(country);
    const count = targets.reduce((n, t) => n + entriesFor(t.id).length, 0);
    const badge = document.querySelector(`[data-country-badge="${cid}"]`);
    const pill  = document.querySelector(`[data-pill-count="${cid}"]`);
    if (badge) badge.textContent = `${count} system${count !== 1 ? 's' : ''}`;
    if (pill)  pill.textContent  = String(count);
  }
}

function buildCard(target) {
  const card = document.createElement('div');
  card.className      = 'target-card';
  card.id             = `tc-${target.id}`;
  card.dataset.targetId = target.id;
  fillCard(card, target);
  return card;
}

/** Re-render a single card in place (keeps the rest of the page untouched). */
function refreshCard(targetId) {
  const card   = document.getElementById(`tc-${targetId}`);
  const target = getBuilderTarget(targetId);
  if (card && target) fillCard(card, target);
  updateCounts();
}

function fillCard(card, target) {
  const entries = entriesFor(target.id);
  card.classList.toggle('has-defenses', entries.length > 0);

  const infra = (target.infrastructure || []).join(', ');
  card.innerHTML = `
    <div class="target-card-head">
      <span class="target-card-name">${escapeHtml(target.name)}</span>
      <span class="badge tc-count">${entries.length} system${entries.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="target-card-meta">${escapeHtml(target.country || '')}${infra ? ' · ' + escapeHtml(infra) : ''}</div>
    <div class="tc-defense-list"></div>
    <div class="defense-controls">
      <button type="button" class="btn btn-primary btn-sm tc-btn-add">+ Add Defense System</button>
    </div>

    <div class="add-defense-form tc-add-form hidden">
      <h4>Add Defense System</h4>

      <div class="form-group">
        <label>System</label>
        <select class="tc-system"></select>
      </div>

      <div class="form-group">
        <label>Quantity (batteries / systems)</label>
        <input type="number" class="tc-qty" min="1" value="1">
      </div>

      <div class="defense-magazine-info tc-mag hidden"></div>

      <div class="form-row-2">
        <div class="form-group">
          <label>Operator</label>
          <select class="tc-operator"></select>
        </div>
        <div class="form-group">
          <label>Reloads <span class="label-hint">— number of full loadouts</span></label>
          <select class="tc-reloads"></select>
        </div>
      </div>

      <div class="form-group">
        <label>Notes (optional)</label>
        <input type="text" class="tc-notes" placeholder="e.g., Forward deployed, degraded readiness" autocomplete="off">
      </div>

      <div class="form-row">
        <button type="button" class="btn btn-primary tc-confirm">Add System</button>
        <button type="button" class="btn btn-secondary tc-cancel">Cancel</button>
      </div>
    </div>`;

  // Assigned systems
  const list = card.querySelector('.tc-defense-list');
  if (entries.length === 0) {
    list.innerHTML = '<p class="empty-state">No defenses assigned</p>';
  } else {
    entries.forEach((entry, index) => list.appendChild(buildRow(target.id, entry, index)));
  }

  // Form selects
  const systemSel   = card.querySelector('.tc-system');
  const qtyInput    = card.querySelector('.tc-qty');
  const magInfo     = card.querySelector('.tc-mag');
  const operatorSel = card.querySelector('.tc-operator');
  const reloadsSel  = card.querySelector('.tc-reloads');
  const notesInput  = card.querySelector('.tc-notes');
  const form        = card.querySelector('.tc-add-form');

  fillSystemSelect(systemSel);
  fillOperatorSelect(operatorSel, 'United States');
  reloadsSel.innerHTML = '';
  for (const n of RELOAD_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = String(n); opt.textContent = String(n);
    if (n === 1) opt.selected = true;
    reloadsSel.appendChild(opt);
  }

  const refreshMagInfo = () => {
    const text = magazineInfoText(systemSel.value, parseInt(qtyInput.value, 10));
    magInfo.classList.toggle('hidden', !text);
    magInfo.textContent = text || '';
  };

  // Same behaviour as the main tool: presets and patrol assets lock quantity to 1.
  systemSel.addEventListener('change', () => {
    const val     = systemSel.value;
    const preset  = getBuilderPreset(val);
    const catalog = preset ? null : DEFENSE_CATALOG[val];
    if (preset || catalog?.isShared) {
      qtyInput.value    = 1;
      qtyInput.disabled = true;
    } else {
      qtyInput.disabled = false;
      qtyInput.value    = 1;   // file units — see header comment
    }
    refreshMagInfo();
  });
  qtyInput.addEventListener('input', refreshMagInfo);

  card.querySelector('.tc-btn-add').addEventListener('click', () => openForm(card));
  card.querySelector('.tc-cancel').addEventListener('click', () => closeForm(card));
  card.querySelector('.tc-confirm').addEventListener('click', () => {
    const systemId = systemSel.value;
    const qty      = Math.max(1, parseInt(qtyInput.value, 10) || 1);
    const operator = operatorSel.value || 'United States';
    const reloads  = parseInt(reloadsSel.value, 10);
    const notes    = notesInput.value.trim();

    if (!systemId) { showToast('Please select a system.', true); return; }

    const added = addEntries(target.id, systemId, qty, notes, operator, Number.isInteger(reloads) ? reloads : 1);
    if (added > 0) {
      persistBlue();
      refreshCard(target.id);
      showToast(`Added ${added} system${added !== 1 ? 's' : ''} to ${target.name}.`);
    }
  });

  // Enter in the notes field confirms, as a convenience
  notesInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') card.querySelector('.tc-confirm').click();
  });

  form.classList.add('hidden');
}

function buildRow(targetId, entry, index) {
  const catalog = DEFENSE_CATALOG[entry.system];
  const row = document.createElement('div');
  row.className = 'tc-defense-row';
  row.style.setProperty('--tier-color', TIER_COLORS[catalog?.tier] || '#888');

  const qtyLabel = catalog?.isShared ? 'patrol asset' : `× ${entry.quantity}`;
  const reloads  = entry.reloads;
  row.innerHTML = `
    <div class="tc-defense-main">
      <span class="tc-defense-name">${escapeHtml(catalog?.name || entry.system)}</span>
      <span class="tc-defense-sub">${qtyLabel} · ${escapeHtml(entry.operator || '')} · ↻ ${reloads} reload${reloads !== 1 ? 's' : ''}</span>
      ${entry.notes ? `<span class="tc-defense-notes">${escapeHtml(entry.notes)}</span>` : ''}
    </div>
    <button type="button" class="btn-icon tc-btn-remove" title="Remove">✕</button>`;

  row.querySelector('.tc-btn-remove').addEventListener('click', () => {
    removeEntry(targetId, index);
  });
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Add-form open/close (only one form open at a time)
// ─────────────────────────────────────────────────────────────────────────────

function openForm(card) {
  for (const other of document.querySelectorAll('.tc-add-form:not(.hidden)')) {
    other.classList.add('hidden');
  }
  const form = card.querySelector('.tc-add-form');
  form.classList.remove('hidden');
  card.querySelector('.tc-system').focus();
}

function closeForm(card) {
  const form = card.querySelector('.tc-add-form');
  form.classList.add('hidden');
  card.querySelector('.tc-system').value   = '';
  card.querySelector('.tc-qty').value      = '1';
  card.querySelector('.tc-qty').disabled   = false;
  card.querySelector('.tc-notes').value    = '';
  card.querySelector('.tc-reloads').value  = '1';
  card.querySelector('.tc-operator').value = 'United States';
  card.querySelector('.tc-mag').classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// Laydown CRUD — mirrors addDefense() + the preset expansion in app.js
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the number of entries actually added. */
function addEntries(targetId, systemId, quantity, notes, operator, reloads) {
  const preset = getBuilderPreset(systemId);
  if (preset) {
    let added = 0;
    for (const c of preset.components) {
      added += addOneEntry(targetId, c.system, c.quantity ?? 1, c.notes || '', operator, reloads);
    }
    return added;
  }
  return addOneEntry(targetId, systemId, quantity, notes, operator, reloads);
}

function addOneEntry(targetId, systemId, quantity, notes, operator, reloads) {
  const catalog = DEFENSE_CATALOG[systemId];
  if (!catalog) { showToast(`Unknown system "${systemId}".`, true); return 0; }

  laydown[targetId] = laydown[targetId] || [];

  // Shared patrol assets: one per target (same rule as the tool)
  if (catalog.isShared) {
    if (laydown[targetId].some(e => e.system === systemId)) {
      showToast(`${catalog.name} is already assigned to this target.`, true);
      return 0;
    }
    laydown[targetId].push({ system: systemId, quantity: 1, notes: notes || '', operator, reloads });
    return 1;
  }

  laydown[targetId].push({
    system:   systemId,
    quantity: Math.max(1, quantity | 0),
    notes:    notes || '',
    operator,
    reloads
  });
  return 1;
}

function removeEntry(targetId, index) {
  const arr = laydown[targetId];
  if (!arr || index < 0 || index >= arr.length) return;
  arr.splice(index, 1);
  if (arr.length === 0) delete laydown[targetId];
  persistBlue();
  refreshCard(targetId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Import (file or defaults.json) → builder state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a laydown-file object ({ defaults: { targetId: [entries] } }) into
 * builder state. Unknown targets/systems are skipped with a warning.
 * Returns the list of warnings. Does NOT touch laydownName.
 */
function applyLaydownData(data) {
  if (!data || !data.defaults || typeof data.defaults !== 'object' || Array.isArray(data.defaults)) {
    throw new Error('file must contain a "defaults" object');
  }
  const next     = {};
  const warnings = [];

  for (const [targetId, entries] of Object.entries(data.defaults)) {
    const target = getBuilderTarget(targetId);
    if (!target) { warnings.push(`Unknown target ID "${targetId}" — skipped`); continue; }
    if (!Array.isArray(entries)) { warnings.push(`Expected array for target "${targetId}" — skipped`); continue; }

    const applied = [];
    for (const d of entries) {
      if (!d || !d.system || !DEFENSE_CATALOG[d.system]) {
        warnings.push(`Unknown system "${d?.system}" at target "${targetId}" — skipped`);
        continue;
      }
      const catalog = DEFENSE_CATALOG[d.system];
      const qty     = parseInt(d.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) {
        warnings.push(`Invalid quantity for "${d.system}" at target "${targetId}" — skipped`);
        continue;
      }
      const rl      = parseFloat(d.reloads);
      const reloads = Number.isFinite(rl) ? Math.max(0, rl) : 1;
      applied.push({
        system:   d.system,
        quantity: catalog.isShared ? 1 : qty,
        notes:    typeof d.notes === 'string' ? d.notes : '',
        operator: d.operator || target.country || 'United States',
        reloads
      });
    }
    if (applied.length) next[targetId] = applied;
  }

  laydown = next;
  return warnings;
}

async function confirmDiscardIfNeeded(actionLabel) {
  if (totalEntries() === 0) return true;
  return showModal({
    title:   `${actionLabel}?`,
    message: `This will replace the ${totalEntries()} system${totalEntries() !== 1 ? 's' : ''} currently in this draft. Continue?`,
    buttons: [
      { label: 'Continue', value: true,  style: 'danger'    },
      { label: 'Cancel',   value: false, style: 'secondary' }
    ]
  });
}

/** Fetch data/defaults.json into the draft. Returns warnings, or null on failure. */
async function fetchDefaultsIntoDraft() {
  let data;
  try {
    data = await fetch('data/defaults.json').then(r => r.json());
  } catch (err) {
    showToast('Could not load data/defaults.json: ' + err.message, true);
    return null;
  }
  try { return applyLaydownData(data); }
  catch (err) { showToast('Load failed — ' + err.message, true); return null; }
}

async function loadDefaultLaydown() {
  if (!await confirmDiscardIfNeeded('Load Default Laydown')) return;
  const warnings = await fetchDefaultsIntoDraft();
  if (warnings === null) return;
  persistBlue();
  renderAll();
  finishImportToast('Default laydown loaded', warnings, '[blue] loadDefaultLaydown');
}

async function importLaydownFile(file) {
  if (!await confirmDiscardIfNeeded('Import Laydown')) return;
  let data;
  try { data = await readJSONFile(file); }
  catch (err) { showToast('Import failed — ' + err.message, true); return; }

  let warnings;
  try { warnings = applyLaydownData(data); }
  catch (err) { showToast('Import failed — ' + err.message, true); return; }

  if (typeof data.name === 'string' && data.name.trim()) {
    laydownName = data.name.trim();
    document.getElementById('laydown-name').value = laydownName;
  }
  persistBlue();
  renderAll();
  finishImportToast('Laydown imported', warnings, '[blue] importLaydownFile');
}

function finishImportToast(prefix, warnings, logTag) {
  const n   = totalEntries();
  const t   = targetsWithEntries();
  let msg   = `${prefix} — ${n} system${n !== 1 ? 's' : ''} across ${t} target${t !== 1 ? 's' : ''}.`;
  if (warnings.length) {
    msg += ` ${warnings.length} warning${warnings.length !== 1 ? 's' : ''} (see console).`;
    console.warn(`${logTag} warnings:`, warnings);
  }
  showToast(msg, warnings.length > 0);
}

async function clearAll() {
  if (totalEntries() === 0) { showToast('Nothing to clear.'); return; }
  const ok = await showModal({
    title:   'Clear All?',
    message: `Remove all ${totalEntries()} system${totalEntries() !== 1 ? 's' : ''} from every target in this draft?`,
    buttons: [
      { label: 'Clear',  value: true,  style: 'danger'    },
      { label: 'Cancel', value: false, style: 'secondary' }
    ]
  });
  if (!ok) return;
  laydown = {};
  persistBlue();
  renderAll();
  showToast('Draft cleared.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the laydown file object. Entry ids follow the defaults.json
 * convention `${targetId}_d${n}`; shared patrol assets use `shared_<system>`
 * so their magazine pools across targets exactly as addDefense() does.
 * Targets are emitted in targets.json order.
 */
function buildLaydownExport(name) {
  const defaults = {};
  for (const t of BUILDER_DATA.targets) {
    const entries = laydown[t.id];
    if (!entries || entries.length === 0) continue;
    let n = 0;
    defaults[t.id] = entries.map(e => {
      const catalog = DEFENSE_CATALOG[e.system];
      const id      = catalog?.isShared ? `shared_${e.system}` : `${t.id}_d${++n}`;
      return {
        id,
        system:   e.system,
        quantity: e.quantity,
        notes:    e.notes || '',
        operator: e.operator,
        reloads:  e.reloads
      };
    });
  }
  return { version: '1.0', name, defaults };
}

function exportLaydown() {
  const input = document.getElementById('laydown-name');
  const name  = (input.value || '').trim() || BLUE_DEFAULT_NAME;
  if (totalEntries() === 0) {
    showToast('Add at least one defense system before exporting.', true);
    return;
  }
  const file = buildLaydownExport(name);
  downloadJSON(`${slugify(name) || 'laydown'}_laydown.json`, file);
  const n = totalEntries(), t = targetsWithEntries();
  showToast(`Exported "${name}" — ${n} system${n !== 1 ? 's' : ''} across ${t} target${t !== 1 ? 's' : ''}.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring + bootstrap
// ─────────────────────────────────────────────────────────────────────────────

function wireBlueEvents() {
  const nameInput = document.getElementById('laydown-name');
  nameInput.addEventListener('input', () => {
    laydownName = nameInput.value;
    persistBlue();
  });

  document.getElementById('btn-load-defaults').addEventListener('click', loadDefaultLaydown);
  document.getElementById('btn-clear-all').addEventListener('click', clearAll);
  document.getElementById('btn-export-laydown').addEventListener('click', exportLaydown);

  document.getElementById('btn-import-laydown').addEventListener('click', () => {
    document.getElementById('import-laydown-input').click();
  });
  document.getElementById('import-laydown-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) importLaydownFile(file);
    e.target.value = '';
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('modal-overlay').classList.contains('hidden')) {
      _resolveModal(false);
    }
  });
}

async function initBlue() {
  await loadCatalogs();
  const hadDraft = restoreBlue();
  document.getElementById('laydown-name').value = laydownName;
  renderAll();
  wireBlueEvents();

  // First visit (no saved draft): start from the tool's default laydown so
  // facilitators edit the baseline rather than an empty page.
  if (!hadDraft) {
    const warnings = await fetchDefaultsIntoDraft();
    if (warnings !== null) {
      persistBlue();
      renderAll();
      finishImportToast('Default laydown loaded', warnings, '[blue] initBlue');
    }
  }

  // Automation hooks (used by the Playwright tests)
  window._blueState        = () => ({ name: laydownName, laydown: JSON.parse(JSON.stringify(laydown)) });
  window._blueBuildExport  = buildLaydownExport;
  window._blueApplyData    = applyLaydownData;
  window._blueReady        = true;
}

document.addEventListener('DOMContentLoaded', initBlue);
