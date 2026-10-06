/**
 * red.js — Attack Builder (Red Team) page controller
 *
 * Five fixed columns, one per attack. Each column has a target select and
 * the same platform / salvo / Add row as the main tool's attack builder.
 * Exports an attacks JSON file that the tool's "Import Attacks" button
 * (and scripts/batch-sim.js) accept.
 *
 * State is held in memory and mirrored to localStorage under its own key so
 * an accidental reload doesn't lose work. Nothing here touches app.js state.
 */

const RED_STORAGE_KEY = 'threatmodel_red_builder_v1';
const ATTACK_SLOTS    = 5;

// Same ordering the main tool uses for its manifest rows
const RED_THREAT_ORDER = { mrbm: 0, srbm: 1, cruise_missile: 2, drone: 3, drone_jet: 4, fpv: 5 };

let attacks     = [];   // [{ targetId: string|null, manifest: [{ platformId, count }] }] × ATTACK_SLOTS
let attacksName = '';

// ─────────────────────────────────────────────────────────────────────────────
// State helpers
// ─────────────────────────────────────────────────────────────────────────────

function emptyAttack() { return { targetId: null, manifest: [] }; }

function resetAttacks() {
  attacks = Array.from({ length: ATTACK_SLOTS }, emptyAttack);
}

function persistRed() {
  saveBuilderState(RED_STORAGE_KEY, { name: attacksName, attacks });
}

function restoreRed() {
  resetAttacks();
  const s = loadBuilderState(RED_STORAGE_KEY);
  if (!s) return;
  attacksName = typeof s.name === 'string' ? s.name : '';
  if (Array.isArray(s.attacks)) {
    for (let i = 0; i < ATTACK_SLOTS; i++) {
      const a = s.attacks[i];
      if (!a) continue;
      attacks[i] = {
        targetId: (a.targetId && getBuilderTarget(a.targetId)) ? a.targetId : null,
        manifest: Array.isArray(a.manifest)
          ? a.manifest.filter(m => m && PLATFORM_CATALOG[m.platformId] && (m.count | 0) > 0)
                      .map(m => ({ platformId: m.platformId, count: m.count | 0 }))
          : []
      };
    }
  }
}

function isComplete(a) { return !!a.targetId && a.manifest.length > 0; }

function completeAttacks() { return attacks.filter(isComplete); }

function hasAnyContent() { return attacks.some(a => a.targetId || a.manifest.length > 0); }

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderColumns() {
  const grid = document.getElementById('attack-grid');
  grid.innerHTML = '';
  for (let i = 0; i < ATTACK_SLOTS; i++) grid.appendChild(buildColumn(i));
}

function buildColumn(index) {
  const col = document.createElement('section');
  col.className     = 'attack-col';
  col.id            = `attack-col-${index}`;
  col.dataset.index = String(index);
  col.innerHTML = `
    <div class="attack-col-head">
      <h2>Attack ${index + 1}</h2>
      <button type="button" class="btn btn-danger btn-sm rc-clear">Clear</button>
    </div>

    <div class="form-group">
      <label>Target</label>
      <select class="rc-target"></select>
    </div>

    <div class="attack-builder">
      <div class="form-group">
        <label>Platform</label>
        <select class="rc-platform"></select>
      </div>
      <div class="red-add-row">
        <div class="form-group quantity-field">
          <label>Salvo</label>
          <input type="number" class="rc-qty" min="1" placeholder="Qty" disabled>
        </div>
        <div class="form-group">
          <label>&nbsp;</label>
          <button type="button" class="btn btn-primary rc-add">Add</button>
        </div>
      </div>
    </div>

    <div class="section-header">
      <h3>Attack Manifest</h3>
      <span class="badge rc-count">0 platforms</span>
    </div>
    <div class="attack-manifest rc-manifest"></div>`;

  const targetSel   = col.querySelector('.rc-target');
  const platformSel = col.querySelector('.rc-platform');
  const qtyInput    = col.querySelector('.rc-qty');

  fillTargetSelect(targetSel);
  fillPlatformSelect(platformSel);
  targetSel.value = attacks[index].targetId || '';

  targetSel.addEventListener('change', () => {
    attacks[index].targetId = targetSel.value || null;
    persistRed();
    updateColumnState(index);
  });

  // Mirrors updateSalvoSelect(): seed with the first salvo size, enable, focus
  platformSel.addEventListener('change', () => {
    const platform = platformSel.value ? PLATFORM_CATALOG[platformSel.value] : null;
    if (!platform) {
      qtyInput.value    = '';
      qtyInput.disabled = true;
      return;
    }
    qtyInput.value    = platform.salvo_sizes?.[0] ?? 1;
    qtyInput.disabled = false;
    qtyInput.focus();
    qtyInput.select();
  });

  const addFromRow = () => {
    const platformId = platformSel.value;
    const qty        = parseInt(qtyInput.value, 10) || 0;
    if (!platformId) { showToast('Please select a platform.', true); return; }
    if (!qty)        { showToast('Please enter a quantity.', true);  return; }
    addPlatform(index, platformId, qty);
    platformSel.value = '';
    qtyInput.value    = '';
    qtyInput.disabled = true;
  };
  col.querySelector('.rc-add').addEventListener('click', addFromRow);
  qtyInput.addEventListener('keydown', e => { if (e.key === 'Enter') addFromRow(); });

  col.querySelector('.rc-clear').addEventListener('click', () => clearColumn(index));

  renderManifest(index, col);
  updateColumnState(index, col);
  return col;
}

function updateColumnState(index, col = document.getElementById(`attack-col-${index}`)) {
  if (!col) return;
  col.classList.toggle('has-attack', isComplete(attacks[index]));
}

/** Same row markup as app.js renderAttackManifest(), scoped to one column. */
function renderManifest(index, col = document.getElementById(`attack-col-${index}`)) {
  if (!col) return;
  const container = col.querySelector('.rc-manifest');
  const badge     = col.querySelector('.rc-count');
  const manifest  = attacks[index].manifest;
  const total     = manifest.reduce((s, e) => s + e.count, 0);

  badge.textContent = `${total} platform${total !== 1 ? 's' : ''}`;

  if (manifest.length === 0) {
    container.innerHTML = '<p class="empty-state">No platforms added</p>';
    updateColumnState(index, col);
    return;
  }

  const sorted = [...manifest].sort((a, b) => {
    const ta = PLATFORM_CATALOG[a.platformId]?.type ?? '';
    const tb = PLATFORM_CATALOG[b.platformId]?.type ?? '';
    return (RED_THREAT_ORDER[ta] ?? 99) - (RED_THREAT_ORDER[tb] ?? 99);
  });

  container.innerHTML = '';
  for (const entry of sorted) {
    const platform = PLATFORM_CATALOG[entry.platformId];
    if (!platform) continue;
    const row = document.createElement('div');
    row.className = `manifest-row threat-row-${platform.type}`;
    row.innerHTML = `
      <span class="manifest-dot threat-dot-${platform.type}"></span>
      <div class="manifest-name-col">
        <span class="manifest-name">${escapeHtml(platform.name)}</span>
        <span class="manifest-type-label">${escapeHtml(THREAT_TYPE_LABELS[platform.type] || platform.type)}</span>
      </div>
      <span class="manifest-count">Qty: ${entry.count}</span>
      <button type="button" class="btn-icon btn-remove-platform" title="Remove">✕</button>`;
    row.querySelector('.btn-remove-platform').addEventListener('click', () => {
      removePlatform(index, entry.platformId);
    });
    container.appendChild(row);
  }

  const totalRow = document.createElement('div');
  totalRow.className = 'manifest-total';
  totalRow.innerHTML = `<span>Total</span><span>${total} platforms</span>`;
  container.appendChild(totalRow);

  updateColumnState(index, col);
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest CRUD — mirrors addPlatformToManifest() / removePlatformFromManifest()
// ─────────────────────────────────────────────────────────────────────────────

function addPlatform(index, platformId, count) {
  if (!platformId || count < 1 || !PLATFORM_CATALOG[platformId]) return;
  const manifest = attacks[index].manifest;
  const existing = manifest.find(e => e.platformId === platformId);
  if (existing) existing.count += count;
  else manifest.push({ platformId, count });
  persistRed();
  renderManifest(index);
}

function removePlatform(index, platformId) {
  attacks[index].manifest = attacks[index].manifest.filter(e => e.platformId !== platformId);
  persistRed();
  renderManifest(index);
}

async function clearColumn(index) {
  const a = attacks[index];
  if (!a.targetId && a.manifest.length === 0) return;
  const ok = await showModal({
    title:   `Clear Attack ${index + 1}?`,
    message: 'Remove the target and all platforms from this attack?',
    buttons: [
      { label: 'Clear',  value: true,  style: 'danger'    },
      { label: 'Cancel', value: false, style: 'secondary' }
    ]
  });
  if (!ok) return;
  attacks[index] = emptyAttack();
  persistRed();
  const col = document.getElementById(`attack-col-${index}`);
  col.replaceWith(buildColumn(index));
}

async function clearAllAttacks() {
  if (!hasAnyContent()) { showToast('Nothing to clear.'); return; }
  const ok = await showModal({
    title:   'Clear All?',
    message: 'Remove the target and platforms from all five attacks?',
    buttons: [
      { label: 'Clear',  value: true,  style: 'danger'    },
      { label: 'Cancel', value: false, style: 'secondary' }
    ]
  });
  if (!ok) return;
  resetAttacks();
  persistRed();
  renderColumns();
  showToast('All attacks cleared.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Import → builder state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an attacks-file object ({ attacks: [{ targetId, platforms }] })
 * into the five columns. Uses the same validation as importAttackQueue().
 * Returns warnings. Does NOT touch attacksName.
 */
function applyAttacksData(data) {
  if (!data || !Array.isArray(data.attacks)) {
    throw new Error('file must contain an "attacks" array');
  }
  const warnings = [];
  const next     = [];

  data.attacks.forEach((attack, ai) => {
    const num = ai + 1;
    if (!attack || !attack.targetId) { warnings.push(`Attack #${num}: missing "targetId" — skipped`); return; }
    if (!getBuilderTarget(attack.targetId)) { warnings.push(`Attack #${num}: unknown targetId "${attack.targetId}" — skipped`); return; }
    if (!Array.isArray(attack.platforms) || attack.platforms.length === 0) {
      warnings.push(`Attack #${num} (${attack.targetId}): "platforms" must be a non-empty array — skipped`); return;
    }
    const manifest = [];
    for (const p of attack.platforms) {
      if (!p || !p.platformId) { warnings.push(`Attack #${num}: platform entry missing "platformId" — skipped`); continue; }
      if (!PLATFORM_CATALOG[p.platformId]) { warnings.push(`Attack #${num}: unknown platformId "${p.platformId}" — skipped`); continue; }
      const qty = parseInt(p.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) { warnings.push(`Attack #${num}: invalid quantity for "${p.platformId}" — skipped`); continue; }
      const existing = manifest.find(e => e.platformId === p.platformId);
      if (existing) existing.count += qty;
      else manifest.push({ platformId: p.platformId, count: qty });
    }
    if (manifest.length === 0) { warnings.push(`Attack #${num}: no valid platforms — skipped`); return; }
    next.push({ targetId: attack.targetId, manifest });
  });

  if (next.length > ATTACK_SLOTS) {
    warnings.push(`File contains ${next.length} attacks; only the first ${ATTACK_SLOTS} were loaded`);
  }

  resetAttacks();
  next.slice(0, ATTACK_SLOTS).forEach((a, i) => { attacks[i] = a; });
  return warnings;
}

async function importAttacksFile(file) {
  if (hasAnyContent()) {
    const ok = await showModal({
      title:   'Import Attacks?',
      message: 'This will replace the attacks currently in this draft. Continue?',
      buttons: [
        { label: 'Continue', value: true,  style: 'danger'    },
        { label: 'Cancel',   value: false, style: 'secondary' }
      ]
    });
    if (!ok) return;
  }

  let data;
  try { data = await readJSONFile(file); }
  catch (err) { showToast('Import failed — ' + err.message, true); return; }

  let warnings;
  try { warnings = applyAttacksData(data); }
  catch (err) { showToast('Import failed — ' + err.message, true); return; }

  if (typeof data.name === 'string' && data.name.trim()) {
    attacksName = data.name.trim();
    document.getElementById('attacks-name').value = attacksName;
  }
  persistRed();
  renderColumns();

  const n = completeAttacks().length;
  let msg = `Attacks imported — ${n} attack${n !== 1 ? 's' : ''} loaded.`;
  if (warnings.length) {
    msg += ` ${warnings.length} warning${warnings.length !== 1 ? 's' : ''} (see console).`;
    console.warn('[red] importAttacksFile warnings:', warnings);
  }
  showToast(msg, warnings.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the attacks file object in the shape importAttackQueue() expects.
 * Only complete columns (target + ≥1 platform) are included, in column order.
 * `type` is informational (the importer validates it against the catalog).
 */
function buildAttacksExport(name) {
  return {
    version: '1.0',
    name,
    attacks: completeAttacks().map(a => ({
      targetId:  a.targetId,
      platforms: a.manifest.map(m => ({
        platformId: m.platformId,
        type:       PLATFORM_CATALOG[m.platformId]?.type,
        quantity:   m.count
      }))
    }))
  };
}

function exportAttacks() {
  const input = document.getElementById('attacks-name');
  const name  = (input.value || '').trim();
  if (!name) {
    showToast('Enter an attack set name before exporting.', true);
    input.focus();
    return;
  }
  const complete = completeAttacks().length;
  if (complete === 0) {
    showToast('Each attack needs a target and at least one platform before exporting.', true);
    return;
  }
  const partial = attacks.filter(a => !isComplete(a) && (a.targetId || a.manifest.length > 0)).length;

  const file = buildAttacksExport(name);
  downloadJSON(`${slugify(name) || 'attacks'}_attacks.json`, file);

  let msg = `Exported "${name}" — ${complete} attack${complete !== 1 ? 's' : ''}.`;
  if (partial) msg += ` ${partial} incomplete column${partial !== 1 ? 's' : ''} skipped.`;
  showToast(msg, partial > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring + bootstrap
// ─────────────────────────────────────────────────────────────────────────────

function wireRedEvents() {
  const nameInput = document.getElementById('attacks-name');
  nameInput.addEventListener('input', () => {
    attacksName = nameInput.value;
    persistRed();
  });

  document.getElementById('btn-clear-all').addEventListener('click', clearAllAttacks);
  document.getElementById('btn-export-attacks').addEventListener('click', exportAttacks);

  document.getElementById('btn-import-attacks').addEventListener('click', () => {
    document.getElementById('import-attacks-input').click();
  });
  document.getElementById('import-attacks-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) importAttacksFile(file);
    e.target.value = '';
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('modal-overlay').classList.contains('hidden')) {
      _resolveModal(false);
    }
  });
}

async function initRed() {
  await loadCatalogs();
  restoreRed();
  document.getElementById('attacks-name').value = attacksName;
  renderColumns();
  wireRedEvents();

  // Automation hooks (used by the Playwright tests)
  window._redState       = () => ({ name: attacksName, attacks: JSON.parse(JSON.stringify(attacks)) });
  window._redBuildExport = buildAttacksExport;
  window._redApplyData   = applyAttacksData;
  window._redReady       = true;
}

document.addEventListener('DOMContentLoaded', initRed);
