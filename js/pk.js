/**
 * pk.js — Pk Table Builder page controller
 *
 * Shows one matrix: attack platforms as rows (grouped by threat type in the
 * default doctrine's processing order), defense systems as columns (grouped
 * by tier). Every cell holds the per-shot probability of kill `pk` and the
 * `shots` fired per threat for that system × platform pairing. The page
 * starts from data/pk-table.json, lets the user edit cells and the three
 * tier multipliers, and exports a file that the tool's "Import Pk Table"
 * button accepts.
 *
 * Cell semantics (see data/schemas/pk-table.schema.json):
 *   pk = 0            the system cannot engage that platform
 *   shots             interceptors per threat (kinetic, patrol), rounds per
 *                     burst (gun), ignored for directed-energy systems
 *
 * State is held in memory and mirrored to localStorage under its own key so
 * an accidental reload doesn't lose work. Nothing here touches app.js state.
 */

const PK_STORAGE_KEY_BUILDER = 'threatmodel_pk_builder_v1';
const PK_DEFAULT_NAME        = 'Custom Pk Table';   // used when the name field is left blank

let pkTable  = null;   // { version, name, tiers:{low,medium,high}, cells:{ [systemId]: { [platformId]: {pk, shots} } } }
let pkName   = '';
let doctrineForShading = null;   // normalized default doctrine, used only to shade unused pairings

// ─────────────────────────────────────────────────────────────────────────────
// State helpers
// ─────────────────────────────────────────────────────────────────────────────

function persistPk() {
  saveBuilderState(PK_STORAGE_KEY_BUILDER, { name: pkName, table: pkTable });
}

/** Returns true if a saved draft existed. */
function restorePk() {
  const s = loadBuilderState(PK_STORAGE_KEY_BUILDER);
  if (!s || !s.table || typeof s.table !== 'object') return false;
  pkName  = typeof s.name === 'string' ? s.name : '';
  pkTable = normalizePkTable(s.table, DEFENSE_CATALOG, PLATFORM_CATALOG).table;
  return true;
}

/** Systems in column order: tier ascending, then name. */
function systemColumns() {
  return Object.values(DEFENSE_CATALOG).sort((a, b) => (a.tier - b.tier) || a.name.localeCompare(b.name));
}

/** Platforms in row order: grouped by threat type (doctrine order), then catalog order. */
function platformRows() {
  const order = doctrineForShading?.typeOrder?.length ? doctrineForShading.typeOrder : THREAT_TYPES;
  const rank  = Object.fromEntries(order.map((t, i) => [t, i]));
  return Object.values(PLATFORM_CATALOG)
    .map((p, i) => ({ ...p, _i: i }))
    .sort((a, b) => ((rank[a.type] ?? 99) - (rank[b.type] ?? 99)) || (a._i - b._i));
}

function cellOf(systemId, platformId) {
  return pkTable.cells[systemId]?.[platformId] || { pk: 0, shots: 0 };
}

function setCell(systemId, platformId, patch) {
  const row = pkTable.cells[systemId] || (pkTable.cells[systemId] = {});
  row[platformId] = { ...cellOf(systemId, platformId), ...patch };
}

/** Is the pairing reachable under the default doctrine (system listed for the platform's type)? */
function pairingUsed(systemId, platform) {
  if (!doctrineForShading) return true;
  return (doctrineForShading.engage?.[platform.type] || []).includes(systemId);
}

function countEngageable() {
  let n = 0, total = 0;
  for (const row of Object.values(pkTable.cells)) for (const c of Object.values(row)) { total++; if (c.pk > 0) n++; }
  return { n, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderAll() {
  const wrap = document.getElementById('pk-table-wrap');
  const systems   = systemColumns();
  const platforms = platformRows();

  const table = document.createElement('table');
  table.className = 'pk-table';

  // ── Header: tier group row + system row ──────────────────────────────────
  const thead = document.createElement('thead');
  const tierRow = document.createElement('tr');
  tierRow.className = 'pk-tier-row';
  tierRow.innerHTML = '<th class="pk-corner" rowspan="2">Platform</th>';
  let i = 0;
  while (i < systems.length) {
    const tier = systems[i].tier;
    let span = 0;
    while (i + span < systems.length && systems[i + span].tier === tier) span++;
    const th = document.createElement('th');
    th.className = 'pk-tier-head';
    th.colSpan = span;
    th.style.setProperty('--tier-color', TIER_COLORS[tier] || '#888');
    th.textContent = `${TIER_LABELS[tier] || 'Tier ' + tier}`;
    tierRow.appendChild(th);
    i += span;
  }
  thead.appendChild(tierRow);

  const sysRow = document.createElement('tr');
  sysRow.className = 'pk-sys-row';
  for (const sys of systems) {
    const th = document.createElement('th');
    th.className = 'pk-sys-head';
    th.style.setProperty('--tier-color', TIER_COLORS[sys.tier] || '#888');
    th.title = `${sys.name} — model: ${sys.engagement?.model || 'kinetic'}`;
    th.innerHTML = `<span class="pk-sys-name">${escapeHtml(columnLabel(sys))}</span><span class="pk-sys-model">${escapeHtml(sys.engagement?.model || 'kinetic')}</span>`;
    sysRow.appendChild(th);
  }
  thead.appendChild(sysRow);
  table.appendChild(thead);

  // ── Body: one group row per threat type, one row per platform ────────────
  const tbody = document.createElement('tbody');
  let lastType = null;
  for (const plat of platforms) {
    if (plat.type !== lastType) {
      const gr = document.createElement('tr');
      gr.className = `pk-group-row threat-row-${plat.type}`;
      gr.innerHTML = `<th colspan="${systems.length + 1}">${escapeHtml(THREAT_TYPE_LABELS[plat.type] || plat.type)}</th>`;
      tbody.appendChild(gr);
      lastType = plat.type;
    }
    const tr = document.createElement('tr');
    tr.className = 'pk-row';
    tr.dataset.platform = plat.id;
    const rowHead = document.createElement('th');
    rowHead.className = 'pk-row-head';
    rowHead.innerHTML = `<span class="pk-plat-name">${escapeHtml(plat.name)}</span>`;
    tr.appendChild(rowHead);
    for (const sys of systems) tr.appendChild(buildCell(sys, plat));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  wrap.innerHTML = '';
  wrap.appendChild(table);
  updateSummary();
}

/**
 * Column label: the abbreviation in trailing parentheses when the catalog
 * name has one ("… (THAAD)" → "THAAD"), else the full name. The full name
 * stays in the header tooltip.
 */
function columnLabel(sys) {
  const m = /\(([^()]{2,12})\)\s*$/.exec(sys.name || '');
  return m ? m[1] : (sys.shortName || sys.name);
}

/** Build one editable cell (pk input over shots input). */
function buildCell(sys, plat) {
  const td   = document.createElement('td');
  const cell = cellOf(sys.id, plat.id);
  const isDE = (sys.engagement?.model || 'kinetic') === 'directed_energy';
  td.className = 'pk-cell';
  td.dataset.system = sys.id;
  td.dataset.platform = plat.id;
  td.innerHTML = `
    <input type="number" class="pk-in" min="0" max="1" step="0.01" value="${cell.pk}" title="${escapeHtml(sys.name)} vs ${escapeHtml(plat.name)}: per-shot pk" aria-label="pk">
    <input type="number" class="shots-in" min="0" step="0.5" value="${cell.shots}" title="${isDE ? 'Directed energy: no interceptors' : 'shots per threat'}" aria-label="shots" ${isDE ? 'disabled' : ''}>`;
  applyCellClasses(td, sys, plat, cell);

  const pkIn    = td.querySelector('.pk-in');
  const shotsIn = td.querySelector('.shots-in');

  const commit = () => {
    let pk = parseFloat(pkIn.value);
    let shots = isDE ? 0 : parseFloat(shotsIn.value);
    if (!Number.isFinite(pk)) pk = 0;
    if (!Number.isFinite(shots)) shots = 0;
    pk    = Math.min(1, Math.max(0, Math.round(pk * 10000) / 10000));
    shots = Math.max(0, Math.round(shots * 100) / 100);
    pkIn.value = pk; if (!isDE) shotsIn.value = shots;
    setCell(sys.id, plat.id, { pk, shots });
    applyCellClasses(td, sys, plat, { pk, shots });
    persistPk();
    updateSummary();
  };
  pkIn.addEventListener('change', commit);
  shotsIn.addEventListener('change', commit);
  // Enter commits and moves down a row in the same column; Escape reverts.
  for (const input of [pkIn, shotsIn]) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); focusNeighbour(td, input.classList.contains('pk-in') ? '.pk-in' : '.shots-in', 1); }
      if (e.key === 'Escape') { const c = cellOf(sys.id, plat.id); pkIn.value = c.pk; shotsIn.value = c.shots; input.blur(); }
    });
    input.addEventListener('focus', () => input.select());
  }
  return td;
}

function applyCellClasses(td, sys, plat, cell) {
  td.classList.toggle('pk-zero',   !(cell.pk > 0));
  td.classList.toggle('pk-unused', !pairingUsed(sys.id, plat));
}

/** Move focus to the same input in the row `delta` rows away. */
function focusNeighbour(td, selector, delta) {
  const tr   = td.parentElement;
  const idx  = [...tr.children].indexOf(td);
  let next = tr;
  do { next = delta > 0 ? next.nextElementSibling : next.previousElementSibling; }
  while (next && !next.classList.contains('pk-row'));
  next?.children[idx]?.querySelector(selector)?.focus();
}

function updateSummary() {
  const { n, total } = countEngageable();
  document.getElementById('pk-summary').textContent = `${n} of ${total} pairings engage`;
}

function renderTiers() {
  document.getElementById('tier-low').value    = pkTable.tiers.low;
  document.getElementById('tier-medium').value = pkTable.tiers.medium;
  document.getElementById('tier-high').value   = pkTable.tiers.high;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import / defaults / clear
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adopt a Pk-table file object. Unknown ids are dropped and missing cells
 * become pk 0 (normalizePkTable). Returns the warnings. Does NOT touch pkName.
 */
function applyPkData(data) {
  if (!data || typeof data.cells !== 'object' || Array.isArray(data.cells)) {
    throw new Error('file must contain a "cells" object');
  }
  const { table, warnings } = normalizePkTable(data, DEFENSE_CATALOG, PLATFORM_CATALOG);
  pkTable = table;
  return warnings;
}

async function confirmReplaceIfNeeded(actionLabel) {
  const { n } = countEngageable();
  if (n === 0) return true;
  return showModal({
    title:   `${actionLabel}?`,
    message: `This will replace every cell in the current draft (${n} engageable pairings). Continue?`,
    buttons: [
      { label: 'Continue', value: true,  style: 'danger'    },
      { label: 'Cancel',   value: false, style: 'secondary' }
    ]
  });
}

/** Fetch data/pk-table.json into the draft. Returns warnings, or null on failure. */
async function fetchDefaultsIntoDraft() {
  let data;
  try { data = await fetch('data/pk-table.json').then(r => r.json()); }
  catch (err) { showToast('Could not load data/pk-table.json: ' + err.message, true); return null; }
  try { return applyPkData(data); }
  catch (err) { showToast('Load failed — ' + err.message, true); return null; }
}

async function loadDefaultTable() {
  if (!await confirmReplaceIfNeeded('Load Default Table')) return;
  const warnings = await fetchDefaultsIntoDraft();
  if (warnings === null) return;
  persistPk();
  renderTiers();
  renderAll();
  finishPkToast('Default Pk table loaded', warnings, '[pk] loadDefaultTable');
}

async function importPkFile(file) {
  if (!await confirmReplaceIfNeeded('Import Pk Table')) return;
  let data;
  try { data = await readJSONFile(file); }
  catch (err) { showToast('Import failed — ' + err.message, true); return; }
  let warnings;
  try { warnings = applyPkData(data); }
  catch (err) { showToast('Import failed — ' + err.message, true); return; }
  if (typeof data.name === 'string' && data.name.trim()) {
    pkName = data.name.trim();
    document.getElementById('pk-name').value = pkName;
  }
  persistPk();
  renderTiers();
  renderAll();
  finishPkToast('Pk table imported', warnings, '[pk] importPkFile');
}

function finishPkToast(prefix, warnings, logTag) {
  const { n, total } = countEngageable();
  let msg = `${prefix} — ${n} of ${total} pairings engage.`;
  if (warnings.length) {
    msg += ` ${warnings.length} warning${warnings.length !== 1 ? 's' : ''} (see console).`;
    console.warn(`${logTag} warnings:`, warnings);
  }
  showToast(msg, warnings.length > 0);
}

async function clearAll() {
  const { n } = countEngageable();
  if (n === 0) { showToast('Nothing to clear.'); return; }
  const ok = await showModal({
    title:   'Clear All?',
    message: `Set every cell to pk 0 / 0 shots (no system engages anything)?`,
    buttons: [
      { label: 'Clear',  value: true,  style: 'danger'    },
      { label: 'Cancel', value: false, style: 'secondary' }
    ]
  });
  if (!ok) return;
  for (const row of Object.values(pkTable.cells)) for (const k of Object.keys(row)) row[k] = { pk: 0, shots: 0 };
  persistPk();
  renderAll();
  showToast('Draft cleared.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

/** Build the file object: dense cells in catalog order, tiers, name. */
function buildPkExport(name) {
  const cells = {};
  for (const sys of Object.values(DEFENSE_CATALOG)) {
    cells[sys.id] = {};
    for (const plat of Object.values(PLATFORM_CATALOG)) {
      const c = cellOf(sys.id, plat.id);
      cells[sys.id][plat.id] = { pk: c.pk, shots: c.shots };
    }
  }
  return { version: '1.0', name, tiers: { ...pkTable.tiers }, cells };
}

function exportPk() {
  const input = document.getElementById('pk-name');
  const name  = (input.value || '').trim() || PK_DEFAULT_NAME;
  if (countEngageable().n === 0) {
    showToast('Every cell is 0 — set at least one pairing before exporting.', true);
    return;
  }
  const file = buildPkExport(name);
  downloadJSON(`${slugify(name) || 'pk_table'}_pk_table.json`, file);
  const { n, total } = countEngageable();
  showToast(`Exported "${name}" — ${n} of ${total} pairings engage.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring + bootstrap
// ─────────────────────────────────────────────────────────────────────────────

function wirePkEvents() {
  const nameInput = document.getElementById('pk-name');
  nameInput.addEventListener('input', () => { pkName = nameInput.value; persistPk(); });

  for (const key of ['low', 'medium', 'high']) {
    const el = document.getElementById(`tier-${key}`);
    el.addEventListener('change', () => {
      let v = parseFloat(el.value);
      if (!Number.isFinite(v) || v < 0) v = 1;
      v = Math.round(v * 1000) / 1000;
      el.value = v;
      pkTable.tiers[key] = v;
      persistPk();
    });
  }

  document.getElementById('btn-load-defaults').addEventListener('click', loadDefaultTable);
  document.getElementById('btn-clear-all').addEventListener('click', clearAll);
  document.getElementById('btn-export-pk').addEventListener('click', exportPk);
  document.getElementById('btn-import-pk').addEventListener('click', () => {
    document.getElementById('import-pk-input').click();
  });
  document.getElementById('import-pk-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) importPkFile(file);
    e.target.value = '';
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('modal-overlay').classList.contains('hidden')) {
      _resolveModal(false);
    }
  });
}

async function initPk() {
  await loadCatalogs();

  // Default doctrine, used only to shade pairings it never uses.
  try {
    const raw = await fetch('data/doctrine.json').then(r => r.json());
    doctrineForShading = normalizeDoctrine(raw, DEFENSE_CATALOG).doctrine;
  } catch (err) {
    console.warn('[pk] could not load data/doctrine.json for shading:', err.message);
  }

  const hadDraft = restorePk();
  if (!hadDraft) {
    const warnings = await fetchDefaultsIntoDraft();
    if (warnings === null) pkTable = normalizePkTable({}, DEFENSE_CATALOG, PLATFORM_CATALOG).table;
    else if (warnings.length) console.warn('[pk] initPk warnings:', warnings);
    persistPk();
  }
  document.getElementById('pk-name').value = pkName;
  renderTiers();
  renderAll();
  wirePkEvents();
  if (!hadDraft) finishPkToast('Default Pk table loaded', [], '[pk] initPk');

  // Automation hooks (used by the Playwright checks)
  window._pkState       = () => ({ name: pkName, table: JSON.parse(JSON.stringify(pkTable)) });
  window._pkBuildExport = buildPkExport;
  window._pkApplyData   = data => { const w = applyPkData(data); persistPk(); renderTiers(); renderAll(); return w; };
  window._pkReady       = true;
}

document.addEventListener('DOMContentLoaded', initPk);
