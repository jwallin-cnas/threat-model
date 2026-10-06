/**
 * builder-common.js — Shared helpers for the Blue (laydown) and Red (attack)
 * builder pages.
 *
 * Load order on a builder page:
 *   engine.js → catalog.js → ui.js → builder-common.js → blue.js | red.js
 *
 * These pages are deliberately isolated from app.js: they never read or write
 * the main tool's localStorage keys, so nothing done here affects the tool's
 * targets, defenses, magazines, or history. Their only output is a JSON file.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Loaded data
// ─────────────────────────────────────────────────────────────────────────────

const BUILDER_DATA = {
  targets:        [],   // targets.json  → [{ id, name, country, location, infrastructure }]
  defenseSystems: [],   // defenses.json → raw system records (for `batteries`)
  attackSystems:  [],   // attacks.json  → raw platform records
  presets:        []    // presets.json  → [{ id, name, components:[{system, quantity, notes}] }]
};

/**
 * Fetch the four catalog files and populate DEFENSE_CATALOG / PLATFORM_CATALOG
 * exactly as app.js's loadData() + mergeLoadedData() do. Paths are relative
 * to the repo root; builder pages set <base href="../"> so this works from
 * /blue/ and /red/ as well as from a local static server.
 */
async function loadCatalogs() {
  const [targetsRes, defensesRes, attacksRes, presetsRes] = await Promise.allSettled([
    fetch('data/targets.json').then(r => r.json()),
    fetch('data/defenses.json').then(r => r.json()),
    fetch('data/attacks.json').then(r => r.json()),
    fetch('data/presets.json').then(r => r.json())
  ]);

  if (targetsRes.status  === 'fulfilled') BUILDER_DATA.targets        = targetsRes.value.targets  || [];
  else console.error('Could not load data/targets.json:',  targetsRes.reason);
  if (defensesRes.status === 'fulfilled') BUILDER_DATA.defenseSystems = defensesRes.value.systems || [];
  else console.error('Could not load data/defenses.json:', defensesRes.reason);
  if (attacksRes.status  === 'fulfilled') BUILDER_DATA.attackSystems  = attacksRes.value.systems  || [];
  else console.error('Could not load data/attacks.json:',  attacksRes.reason);
  if (presetsRes.status  === 'fulfilled') BUILDER_DATA.presets        = presetsRes.value.presets  || [];
  else console.warn('Could not load data/presets.json:',   presetsRes.reason);

  for (const key of Object.keys(DEFENSE_CATALOG))  delete DEFENSE_CATALOG[key];
  for (const key of Object.keys(PLATFORM_CATALOG)) delete PLATFORM_CATALOG[key];
  Object.assign(DEFENSE_CATALOG,  buildDefenseCatalog(BUILDER_DATA.defenseSystems));
  Object.assign(PLATFORM_CATALOG, buildPlatformCatalog(BUILDER_DATA.attackSystems));

  return BUILDER_DATA;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookups
// ─────────────────────────────────────────────────────────────────────────────

function getBuilderTarget(id) {
  return BUILDER_DATA.targets.find(t => t.id === id) || null;
}

function getBuilderPreset(id) {
  return BUILDER_DATA.presets.find(p => p.id === id) || null;
}

/** Raw defenses.json `batteries` value for a system (1 when unspecified). */
function getSystemBatteries(systemId) {
  const sys = BUILDER_DATA.defenseSystems.find(s => s.id === systemId);
  return sys?.batteries ?? 1;
}

/**
 * Targets grouped by country, preserving targets.json order within a country.
 * Returns [[country, targets[]], ...] in file order of first appearance —
 * the same order the main tool's target dropdown uses.
 */
function targetsByCountry() {
  const byCountry = new Map();
  for (const t of BUILDER_DATA.targets) {
    const c = t.country || 'Other';
    if (!byCountry.has(c)) byCountry.set(c, []);
    byCountry.get(c).push(t);
  }
  return [...byCountry.entries()];
}

/** Sorted, de-duplicated list of countries for the Operator select. */
function operatorOptions() {
  const set = new Set(BUILDER_DATA.targets.map(t => t.country).filter(Boolean));
  set.add('United States');
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ─────────────────────────────────────────────────────────────────────────────
// <select> population — generalized from app.js (which hardcodes element ids)
// ─────────────────────────────────────────────────────────────────────────────

function fillTargetSelect(sel, placeholder = '— Select Target —') {
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = placeholder;
  sel.appendChild(ph);
  for (const [country, targets] of targetsByCountry()) {
    const grp = document.createElement('optgroup');
    grp.label = country;
    for (const t of targets) {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.name;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
}

/** Presets optgroup first, then Systems alphabetically — mirrors populateDefenseSystemSelect(). */
function fillSystemSelect(sel) {
  sel.innerHTML = '<option value="">— Select System —</option>';
  if (BUILDER_DATA.presets.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = 'Presets';
    for (const p of BUILDER_DATA.presets) {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
  const grp = document.createElement('optgroup');
  grp.label = 'Systems';
  for (const sys of Object.values(DEFENSE_CATALOG).sort((a, b) => a.name.localeCompare(b.name))) {
    const opt = document.createElement('option');
    opt.value = sys.id; opt.textContent = sys.name;
    grp.appendChild(opt);
  }
  sel.appendChild(grp);
}

const PLATFORM_GROUP_LABELS = {
  mrbm:           'Medium-Range Ballistic Missiles (MRBM)',
  srbm:           'Short-Range Ballistic Missiles (SRBM)',
  cruise_missile: 'Cruise Missiles',
  drone:          'Drones & Loitering Munitions',
  drone_jet:      'Jet-Powered Drones',
  fpv:            'FPV Drones',
  hypersonic:     'Hypersonic Glide Vehicles'
};

/** Platforms grouped by threat type — mirrors populatePlatformSelect(). */
function fillPlatformSelect(sel) {
  sel.innerHTML = '<option value="">— Select Platform —</option>';
  const groups = {};
  for (const key of Object.keys(PLATFORM_GROUP_LABELS)) groups[key] = [];
  for (const p of Object.values(PLATFORM_CATALOG)) {
    if (!groups[p.type]) groups[p.type] = [];   // unknown type → its own group
    groups[p.type].push(p);
  }
  for (const [type, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    const grp = document.createElement('optgroup');
    grp.label = PLATFORM_GROUP_LABELS[type] || THREAT_TYPE_LABELS?.[type] || type;
    for (const p of items) {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.country ? `${p.name} (${p.country})` : p.name;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
}

function fillOperatorSelect(sel, defaultValue = 'United States') {
  sel.innerHTML = '';
  for (const c of operatorOptions()) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    if (c === defaultValue) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Magazine hint — quantity is in FILE units (what defaults.json stores).
// importLaydown() multiplies file quantity by defenses.json `batteries`, so
// one Patriot "system" = 3 batteries × 12 = 36 interceptors.
// ─────────────────────────────────────────────────────────────────────────────

function magazineInfoText(systemId, qty) {
  if (!systemId || getBuilderPreset(systemId)) return null;
  const catalog    = DEFENSE_CATALOG[systemId];
  const perBattery = catalog?.magazinePerBattery || 0;
  if (!catalog || perBattery === 0) return null;
  const batteries = catalog.isShared ? 1 : getSystemBatteries(systemId);
  const q         = Math.max(1, qty || 1);
  const total     = perBattery * batteries * q;
  if (batteries === 1) {
    return `${perBattery} interceptors/battery × ${q} batter${q !== 1 ? 'ies' : 'y'} = ${total} total interceptors`;
  }
  return `${perBattery} interceptors/battery × ${batteries} batteries/system × ${q} system${q !== 1 ? 's' : ''} = ${total} total interceptors`;
}

// ─────────────────────────────────────────────────────────────────────────────
// File helpers
// ─────────────────────────────────────────────────────────────────────────────

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a File (from an <input type="file">) and parse it as JSON. */
function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => {
      try { resolve(JSON.parse(e.target.result)); }
      catch (err) { reject(new Error('invalid JSON: ' + err.message)); }
    };
    reader.onerror = () => reject(new Error('could not read file'));
    reader.readAsText(file);
  });
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder draft persistence — keys are distinct from every key app.js uses.
// ─────────────────────────────────────────────────────────────────────────────

function loadBuilderState(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveBuilderState(key, state) {
  try { localStorage.setItem(key, JSON.stringify(state)); }
  catch { /* non-critical */ }
}

function clearBuilderState(key) {
  try { localStorage.removeItem(key); } catch { /* non-critical */ }
}
