/**
 * app.js — Strike Assessment Tool main application
 *
 * Data persistence strategy (GitHub Pages compatible):
 *   1. On load: fetch data.json as the baseline
 *   2. Merge with any user modifications stored in localStorage
 *   3. All mutations are saved to localStorage immediately
 *   4. "Export JSON" lets the user download the full modified dataset
 *      to commit back into their repo
 */

const STORAGE_KEY    = 'threatmodel_targets_v2';
const MAG_STORAGE_KEY = 'threatmodel_mag_v2';

// ─────────────────────────────────────────────────────────────────────────────
// Application state
// ─────────────────────────────────────────────────────────────────────────────

let appTargets        = [];   // scenario targets from data/data.json (baseline + localStorage overrides)
let appTargetCatalog  = [];   // target catalog from data/targets.json
let appDefenseSystems = [];   // defense system specs from data/defenses.json
let appAttackSystems  = [];   // attack platforms from data/attacks.json
let appDefaultDefenses = {};  // default defense assignments from data/defaults.json  (targetId → defenses[])

let selectedTargetId   = null;
let attackManifest     = [];   // [{platformId, count}]
let globalMagState     = {};   // defId → magazineRemaining (flat, global — shared across all targets)
let _manifestUnchanged = false; // true once a sim has run; reset whenever manifest/target/defenses change

// ── Manual override state ─────────────────────────────────────────────────────
let lastSimResults  = null;   // stored after each simulation run for override re-walks
let lastSimTarget   = null;   // stored alongside lastSimResults
let manualOverrides = {};     // { [threatType]: { [defId]: { survived:number, disengaged:bool } } }

// ── Minimap state ─────────────────────────────────────────────────────────────
let _minimapCrossLayers = [];   // Leaflet layers for cross-target coverage circles

// ── Magazine state helpers ────────────────────────────────────────────────────

/** Return the global magazine state (keyed by def.id). */
function getMagState() { return globalMagState; }

/** Remove one defense's magazine entry (causes next read to return full loadout). */
function deleteMagEntry(defId) { delete globalMagState[defId]; }

/** Set one defense's remaining interceptor count. */
function setMagEntry(defId, value) { globalMagState[defId] = value; }

/**
 * Clear magazine entries for all defenses assigned DIRECTLY to a target.
 * Cross-target defenses owned by other targets are intentionally left alone.
 */
function clearMagStateForTarget(targetId) {
  for (const def of getTargetDefenses(targetId)) delete globalMagState[def.id];
}

/** Persist global magazine state to localStorage. */
function saveMagStateToStorage() {
  try { localStorage.setItem(MAG_STORAGE_KEY, JSON.stringify(globalMagState)); }
  catch (e) { /* non-critical */ }
}

/** Load global magazine state from localStorage. */
function loadMagStateFromStorage() {
  try {
    const raw = localStorage.getItem(MAG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

let _minimap       = null;        // Leaflet map instance
let _minimapMarker = null;        // Leaflet circleMarker instance

// ─────────────────────────────────────────────────────────────────────────────
// Data loading & persistence
// ─────────────────────────────────────────────────────────────────────────────

async function loadData() {
  // Fetch all data files in parallel
  const [scenarioRes, targetsRes, defensesRes, attacksRes, defaultsRes] = await Promise.allSettled([
    fetch('data/data.json').then(r => r.json()),
    fetch('data/targets.json').then(r => r.json()),
    fetch('data/defenses.json').then(r => r.json()),
    fetch('data/attacks.json').then(r => r.json()),
    fetch('data/defaults.json').then(r => r.json())
  ]);

  // Scenario targets (data.json) — merged with localStorage overrides below
  let baseline = [];
  if (scenarioRes.status === 'fulfilled') {
    baseline = scenarioRes.value.targets || [];
  } else {
    console.warn('Could not fetch data/data.json:', scenarioRes.reason);
  }

  // Target catalog (targets.json)
  if (targetsRes.status === 'fulfilled') {
    appTargetCatalog = targetsRes.value.targets || [];
  } else {
    console.error('Could not load data/targets.json:', targetsRes.reason);
  }

  // Defense systems catalog (defenses.json)
  if (defensesRes.status === 'fulfilled') {
    appDefenseSystems = defensesRes.value.systems || [];
  } else {
    console.error('Could not load data/defenses.json:', defensesRes.reason);
  }

  // Attack systems catalog (attacks.json)
  if (attacksRes.status === 'fulfilled') {
    appAttackSystems = attacksRes.value.systems || [];
  } else {
    console.error('Could not load data/attacks.json:', attacksRes.reason);
  }

  // Default defense assignments (defaults.json)
  if (defaultsRes.status === 'fulfilled') {
    appDefaultDefenses = defaultsRes.value.defaults || {};
  } else {
    console.warn('Could not load data/defaults.json:', defaultsRes.reason);
  }

  // Magazine state (localStorage — flat, global, keyed by def.id)
  globalMagState = loadMagStateFromStorage();

  // Keep data.json targets available for backward compatibility
  appTargets = baseline;

  // Stamp each target with its default defenses from defaults.json.
  // These are overridden below if the user has a localStorage entry for that target.
  for (const t of appTargetCatalog) {
    const raw = appDefaultDefenses[t.id];
    t.defenses = Array.isArray(raw) ? raw.map(d => ({ ...d })) : [];
  }

  // Merge localStorage overrides into appTargetCatalog.
  // A stored entry replaces the entire target object (including its defenses),
  // so user-modified assignments take precedence over defaults.
  const stored = loadFromStorage();
  if (stored && stored.length > 0) {
    const storedMap = Object.fromEntries(stored.map(t => [t.id, t]));
    const merged = appTargetCatalog.map(t => storedMap[t.id] || t);
    const baselineIds = new Set(appTargetCatalog.map(t => t.id));
    for (const t of stored) {
      if (!baselineIds.has(t.id)) merged.push(t);
    }
    appTargetCatalog = merged;
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appTargetCatalog));
    showToast('Changes saved to local storage.');
  } catch (e) {
    showToast('Storage error — could not save.', true);
  }
}


function exportData() {
  const payload = JSON.stringify({ $schema: './schemas/schema.json', version: '1.0', targets: appTargets }, null, 2);
  const blob    = new Blob([payload], { type: 'application/json' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href        = url;
  a.download    = 'data.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function resetData() {
  const confirmed = await showModal({
    title:   'Reset to Default?',
    message: 'This will clear all local modifications and reload the default dataset. Any changes not exported will be lost.',
    buttons: [
      { label: 'Reset',  value: true,  style: 'danger'    },
      { label: 'Cancel', value: false, style: 'secondary' }
    ]
  });
  if (!confirmed) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(MAG_STORAGE_KEY);
  location.reload();
}

// ─────────────────────────────────────────────────────────────────────────────
// Populate runtime catalog objects from loaded JSON data
// Clears any existing entries first so the JSON files are the sole source
// of truth. Called once after loadData() completes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Infer engagement tier from range_km so defenses are sorted outermost-first
 * during simulation (tier 1 = longest range / exo-atmospheric).
 */
function inferTier(range_km) {
  if (range_km >= 200) return 1;
  if (range_km >= 100) return 2;
  if (range_km >= 50)  return 3;
  if (range_km >= 25)  return 4;
  if (range_km >= 10)  return 5;
  return 6;
}

function mergeLoadedData() {
  // Clear existing entries — JSON files are the only source of truth
  for (const key of Object.keys(DEFENSE_CATALOG))  delete DEFENSE_CATALOG[key];
  for (const key of Object.keys(PLATFORM_CATALOG)) delete PLATFORM_CATALOG[key];

  // Populate DEFENSE_CATALOG from defenses.json
  for (const sys of appDefenseSystems) {
    const tier = inferTier(sys.range_km);
    DEFENSE_CATALOG[sys.id] = {
      id:                 sys.id,
      name:               sys.name,
      shortName:          sys.name,
      tier:               tier,
      tierLabel:          TIER_LABELS[tier] || 'Unknown',
      type:               'SAM',
      country:            '',
      range_km:           sys.range_km || 0,
      effectiveAgainst:   sys.threats || [],
      magazinePerBattery: sys.armament?.standard_loadout || 0,
      description:        `Range: ${sys.range_km} km`
    };
  }

  // Populate PLATFORM_CATALOG from attacks.json
  for (const sys of appAttackSystems) {
    PLATFORM_CATALOG[sys.id] = {
      id:          sys.id,
      name:        sys.name,
      shortName:   sys.name,
      type:        sys.type,
      country:     '',
      range_km:    sys.range_km,
      warhead_kg:  sys.payload_kg,
      salvo_sizes: sys.salvo_sizes || [],
      description: `Range: ${sys.range_km} km · Payload: ${sys.payload_kg} kg`
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Geographic helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Haversine great-circle distance between two lat/lon points, in kilometres.
 * Accurate to well under 1 km for the distances involved here.
 */
function haversine(lat1, lon1, lat2, lon2) {
  const R     = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a     = Math.sin(dLat / 2) ** 2
              + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Return defenses placed on OTHER targets whose system range_km reaches the
 * given targetId. Each entry is the original defense object annotated with
 * _isCrossTarget, _placedAtTargetId, _placedAtTargetName, and _distanceKm.
 * Sorted nearest-source-target first.
 */
function getCrossTargetDefenses(targetId) {
  const target = getTarget(targetId);
  if (!target || !Array.isArray(target.location) || target.location[0] == null) return [];
  const [tlat, tlon] = target.location;

  const result = [];
  for (const other of appTargetCatalog) {
    if (other.id === targetId) continue;
    if (!Array.isArray(other.location) || other.location[0] == null) continue;
    const [olat, olon] = other.location;
    const dist = haversine(tlat, tlon, olat, olon);

    for (const def of (other.defenses || [])) {
      const catalog = DEFENSE_CATALOG[def.system];
      if (!catalog || catalog.range_km <= 0) continue;
      if (dist <= catalog.range_km) {
        result.push({
          ...def,
          _isCrossTarget:      true,
          _placedAtTargetId:   other.id,
          _placedAtTargetName: other.name,
          _distanceKm:         Math.round(dist)
        });
      }
    }
  }

  result.sort((a, b) => a._distanceKm - b._distanceKm);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Target helpers
// ─────────────────────────────────────────────────────────────────────────────

function getTarget(id) {
  return appTargetCatalog.find(t => t.id === id) || null;
}

function getTargetDefenses(id) {
  const t = getTarget(id);
  return t ? (t.defenses || []) : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — Target dropdown
// ─────────────────────────────────────────────────────────────────────────────

function renderTargetDropdown() {
  const sel = document.getElementById('target-select');
  sel.innerHTML = '<option value="">— Select Target —</option>';

  // Group by country
  const byCountry = {};
  for (const t of appTargetCatalog) {
    const c = t.country || 'Other';
    if (!byCountry[c]) byCountry[c] = [];
    byCountry[c].push(t);
  }

  for (const [country, targets] of Object.entries(byCountry)) {
    const grp = document.createElement('optgroup');
    grp.label = country;
    for (const t of targets) {
      const opt   = document.createElement('option');
      opt.value   = t.id;
      opt.textContent = t.name;
      if (t.id === selectedTargetId) opt.selected = true;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mini-map
// ─────────────────────────────────────────────────────────────────────────────

// Default zoom levels chosen so the whole country is visible at the map size.
const COUNTRY_ZOOM = {
  'Bahrain':              10,
  'Iraq':                  6,
  'Israel':                7,
  'Jordan':                7,
  'Kuwait':                9,
  'Oman':                  6,
  'Qatar':                 9,
  'Saudi Arabia':          5,
  'United Arab Emirates':  7
};

function updateMinimap(target) {
  const container = document.getElementById('target-minimap');

  // Leaflet failed to load from CDN — hide the map widget and bail out
  if (typeof L === 'undefined') {
    container.classList.add('hidden');
    return;
  }

  if (!target || !Array.isArray(target.location) || target.location[0] == null) {
    container.classList.add('hidden');
    return;
  }

  const [lat, lon] = target.location;
  const zoom = COUNTRY_ZOOM[target.country] || 7;

  // Show container before Leaflet queries its size
  container.classList.remove('hidden');

  // Remove stale cross-target coverage circles from a previous target selection
  for (const layer of _minimapCrossLayers) layer.remove();
  _minimapCrossLayers = [];

  if (!_minimap) {
    // First initialisation — create the map instance
    _minimap = L.map('target-minimap', {
      zoomControl:       false,
      attributionControl: false,
      dragging:          false,
      scrollWheelZoom:   false,
      doubleClickZoom:   false,
      touchZoom:         false,
      boxZoom:           false,
      keyboard:          false,
      tap:               false
    }).setView([lat, lon], zoom);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19
    }).addTo(_minimap);

    _minimapMarker = L.circleMarker([lat, lon], {
      radius:      7,
      fillColor:   '#f85149',
      color:       '#ffffff',
      weight:      2,
      opacity:     1,
      fillOpacity: 1
    }).addTo(_minimap);

  } else {
    // Subsequent selections — reuse the existing map
    _minimap.invalidateSize();
    _minimap.setView([lat, lon], zoom);
    _minimapMarker.setLatLng([lat, lon]);
  }

  // Draw coverage circles for defenses on other targets that reach this target
  const crossDefs = getCrossTargetDefenses(target.id);
  const drawnKeys = new Set();

  for (const def of crossDefs) {
    const sourceTarget = getTarget(def._placedAtTargetId);
    if (!sourceTarget || !Array.isArray(sourceTarget.location)) continue;
    const catalog = DEFENSE_CATALOG[def.system];
    if (!catalog) continue;

    // One circle + dot per unique (source-target, defense-entry) pair
    const layerKey = `${def._placedAtTargetId}_${def.id}`;
    if (drawnKeys.has(layerKey)) continue;
    drawnKeys.add(layerKey);

    const [slat, slon] = sourceTarget.location;

    const circle = L.circle([slat, slon], {
      radius:      catalog.range_km * 1000,
      color:       '#58a6ff',
      fillColor:   '#58a6ff',
      fillOpacity: 0.04,
      weight:      1,
      opacity:     0.4,
      dashArray:   '5 5'
    }).addTo(_minimap);

    const dot = L.circleMarker([slat, slon], {
      radius:      4,
      fillColor:   '#58a6ff',
      color:       '#ffffff',
      weight:      1.5,
      opacity:     1,
      fillOpacity: 1
    }).bindTooltip(`${catalog.name} @ ${sourceTarget.name}`, { permanent: false, direction: 'top' })
      .addTo(_minimap);

    _minimapCrossLayers.push(circle, dot);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — Target info panel
// ─────────────────────────────────────────────────────────────────────────────

function renderTargetInfo(target) {
  const infoDiv = document.getElementById('target-info');

  if (!target) {
    infoDiv.classList.add('hidden');
    updateMinimap(null);
    return;
  }

  updateMinimap(target);

  infoDiv.classList.remove('hidden');
  document.getElementById('info-country').textContent = target.country || '—';

  const [lat, lon] = target.location || [];
  document.getElementById('info-coords').textContent =
    lat != null ? `${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E` : '—';

  document.getElementById('info-infrastructure').textContent =
    (target.infrastructure || []).join(', ') || '—';
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — Defense layers
// ─────────────────────────────────────────────────────────────────────────────

function renderDefenseLayers(targetId) {
  const container  = document.getElementById('defense-layers');
  const countBadge = document.getElementById('defense-count');
  const addBtn     = document.getElementById('btn-add-defense');

  if (!targetId) {
    container.innerHTML = '<p class="empty-state">Select a target to view defenses</p>';
    countBadge.textContent = '0 systems';
    addBtn.disabled = true;
    return;
  }

  const ownDefenses   = getTargetDefenses(targetId);
  const crossDefenses = getCrossTargetDefenses(targetId);
  const totalCount    = ownDefenses.length + crossDefenses.length;

  addBtn.disabled = false;
  countBadge.textContent = `${totalCount} system${totalCount !== 1 ? 's' : ''}`;

  if (ownDefenses.length === 0 && crossDefenses.length === 0) {
    container.innerHTML = '<p class="empty-state">No defenses assigned. Add one below.</p>';
    return;
  }

  container.innerHTML = '';

  // Own defenses — sorted by tier, outermost first
  const sorted = [...ownDefenses].sort((a, b) => {
    const ta = DEFENSE_CATALOG[a.system]?.tier ?? 99;
    const tb = DEFENSE_CATALOG[b.system]?.tier ?? 99;
    return ta - tb;
  });
  for (const def of sorted) {
    container.appendChild(buildDefenseCard(def, targetId));
  }

  // Cross-target defenses — defenses on other targets whose range covers this target
  for (const def of crossDefenses) {
    container.appendChild(buildCrossTargetDefenseCard(def));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — Cross-target defense card
// These are defenses placed on another target whose range_km covers the
// currently-viewed target. Magazine is shared via globalMagState[def.id].
// ─────────────────────────────────────────────────────────────────────────────

function buildCrossTargetDefenseCard(def) {
  const catalog = DEFENSE_CATALOG[def.system];
  const tier    = catalog?.tier ?? 0;
  const color   = TIER_COLORS[tier] || '#888';
  const label   = TIER_LABELS[tier] || 'Unknown';

  const initialMag   = (catalog?.magazinePerBattery || 0) * def.quantity;
  const simRemaining = globalMagState[def.id];
  const hasSim       = simRemaining !== undefined && initialMag > 0;

  let magHtml = '';
  if (initialMag > 0) {
    const ea       = `class="mag-count-editable" data-defense-id="${def.id}" data-max="${initialMag}"`;
    const resetBtn = `<button class="btn-icon btn-reset-sys-loadout" data-defense-id="${def.id}" title="Reset to full loadout">↺</button>`;
    if (hasSim) {
      const expended  = initialMag - simRemaining;
      const usedClass = expended > 0 ? ' mag-used' : '';
      magHtml = `
        <div class="defense-card-mag">
          <span class="defense-magazine${usedClass}"><span ${ea}>${simRemaining}</span> / ${initialMag} interceptors</span>
          <span class="mag-expended">${expended > 0 ? `(${expended} expended)` : '(none expended)'}</span>
          ${resetBtn}
        </div>`;
    } else {
      magHtml = `
        <div class="defense-card-mag">
          <span class="defense-magazine"><span ${ea}>${initialMag}</span> interceptors</span>
          ${resetBtn}
        </div>`;
    }
  }

  const effectList = (catalog?.effectiveAgainst || [])
    .map(t => `<span class="threat-chip threat-${t}">${THREAT_TYPE_ICONS[t] || ''} ${THREAT_TYPE_LABELS[t] || t}</span>`)
    .join('');

  const card = document.createElement('div');
  card.className = 'defense-card cross-target-card';
  card.style.setProperty('--tier-color', color);

  card.innerHTML = `
    <div class="defense-card-header">
      <span class="tier-badge" style="background:${color}20;color:${color};border-color:${color}40">${label}</span>
      <span class="cross-target-badge" title="Placed at ${def._placedAtTargetName}">📍 ${def._placedAtTargetName} · ${def._distanceKm} km</span>
    </div>
    <div class="defense-card-body">
      <span class="defense-name">${catalog?.name || def.system}</span>
      <span class="defense-quantity">${def.quantity} batter${def.quantity !== 1 ? 'ies' : 'y'}</span>
    </div>
    ${magHtml}
    ${def.notes ? `<div class="defense-notes">${def.notes}</div>` : ''}
    <div class="defense-threats">${effectList}</div>
  `;

  card.querySelectorAll('.mag-count-editable').forEach(span => {
    span.addEventListener('click', () => activateMagazineEdit(span));
  });

  card.querySelectorAll('.btn-reset-sys-loadout').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteMagEntry(btn.dataset.defenseId);
      saveMagStateToStorage();
      _manifestUnchanged = false;
      document.getElementById('simulation-results').classList.add('hidden');
      if (selectedTargetId) renderDefenseLayers(selectedTargetId);
    });
  });

  return card;
}

function buildDefenseCard(def, targetId) {
  const catalog = DEFENSE_CATALOG[def.system];
  const tier    = catalog?.tier ?? 0;
  const color   = TIER_COLORS[tier] || '#888';
  const label   = TIER_LABELS[tier] || 'Unknown';

  // Magazine display
  const initialMag   = (catalog?.magazinePerBattery || 0) * def.quantity;
  const simRemaining = getMagState()[def.id];
  const hasSim       = simRemaining !== undefined && initialMag > 0;

  let magHtml = '';
  if (initialMag > 0) {
    const ea      = `class="mag-count-editable" data-defense-id="${def.id}" data-max="${initialMag}"`;
    const resetBtn = `<button class="btn-icon btn-reset-sys-loadout" data-defense-id="${def.id}" title="Reset to full loadout">↺</button>`;
    if (hasSim) {
      const expended = initialMag - simRemaining;
      const usedClass = expended > 0 ? ' mag-used' : '';
      magHtml = `
        <div class="defense-card-mag">
          <span class="defense-magazine${usedClass}"><span ${ea}>${simRemaining}</span> / ${initialMag} interceptors</span>
          <span class="mag-expended">${expended > 0 ? `(${expended} expended)` : '(none expended)'}</span>
          ${resetBtn}
        </div>`;
    } else {
      magHtml = `
        <div class="defense-card-mag">
          <span class="defense-magazine"><span ${ea}>${initialMag}</span> interceptors</span>
          ${resetBtn}
        </div>`;
    }
  }

  const card = document.createElement('div');
  card.className = 'defense-card';
  card.style.setProperty('--tier-color', color);

  const effectList = (catalog?.effectiveAgainst || [])
    .map(t => `<span class="threat-chip threat-${t}">${THREAT_TYPE_ICONS[t] || ''} ${THREAT_TYPE_LABELS[t] || t}</span>`)
    .join('');

  card.innerHTML = `
    <div class="defense-card-header">
      <span class="tier-badge" style="background:${color}20;color:${color};border-color:${color}40">${label}</span>
      <button class="btn-icon btn-remove-defense" data-target="${targetId}" data-defense="${def.id}" title="Remove">✕</button>
    </div>
    <div class="defense-card-body">
      <span class="defense-name">${catalog?.name || def.system}</span>
      <span class="defense-quantity">${def.quantity} batter${def.quantity !== 1 ? 'ies' : 'y'}</span>
    </div>
    ${magHtml}
    ${def.notes ? `<div class="defense-notes">${def.notes}</div>` : ''}
    <div class="defense-threats">${effectList}</div>
  `;

  card.querySelectorAll('.mag-count-editable').forEach(span => {
    span.addEventListener('click', () => activateMagazineEdit(span));
  });

  card.querySelectorAll('.btn-reset-sys-loadout').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteMagEntry(btn.dataset.defenseId);
      saveMagStateToStorage();
      _manifestUnchanged = false;
      document.getElementById('simulation-results').classList.add('hidden');
      if (selectedTargetId) renderDefenseLayers(selectedTargetId);
    });
  });

  card.querySelector('.btn-remove-defense').addEventListener('click', (e) => {
    const tid = e.currentTarget.dataset.target;
    const did = e.currentTarget.dataset.defense;
    removeDefense(tid, did);
  });

  return card;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defense system selector (for add-defense form)
// ─────────────────────────────────────────────────────────────────────────────

function populateDefenseSystemSelect() {
  const sel = document.getElementById('defense-system-select');
  sel.innerHTML = '<option value="">— Select System —</option>';

  const systems = Object.values(DEFENSE_CATALOG)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const sys of systems) {
    const opt = document.createElement('option');
    opt.value = sys.id;
    opt.textContent = sys.name;
    sel.appendChild(opt);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Defense CRUD
// ─────────────────────────────────────────────────────────────────────────────

function addDefense(targetId, systemId, quantity, notes) {
  const target = getTarget(targetId);
  if (!target) return;

  const newDef = {
    id:       `${targetId}_d${Date.now()}`,
    system:   systemId,
    quantity: quantity,
    notes:    notes || ''
  };

  target.defenses = target.defenses || [];
  target.defenses.push(newDef);
  saveToStorage();

  // New defense entry has a fresh unique id — no magazine state to evict.
  _manifestUnchanged = false;
  document.getElementById('simulation-results').classList.add('hidden');
  renderDefenseLayers(targetId);
}

function resetLoadouts() {
  if (!selectedTargetId) return;
  clearMagStateForTarget(selectedTargetId);
  saveMagStateToStorage();
  _manifestUnchanged = false;
  document.getElementById('simulation-results').classList.add('hidden');
  renderDefenseLayers(selectedTargetId);
}

async function resetTargetToDefault(targetId) {
  if (!targetId) return;
  const target = getTarget(targetId);
  if (!target) return;

  const confirmed = await showModal({
    title:   'Reset Target to Default?',
    message: `This will restore ${target.name}'s defensive systems to the default laydown. Any additions or removals will be lost.`,
    buttons: [
      { label: 'Reset',  value: true,  style: 'danger'    },
      { label: 'Cancel', value: false, style: 'secondary' }
    ]
  });
  if (!confirmed) return;

  const raw = appDefaultDefenses[targetId];
  target.defenses = Array.isArray(raw) ? raw.map(d => ({ ...d })) : [];
  saveToStorage();

  clearMagStateForTarget(targetId);
  saveMagStateToStorage();
  _manifestUnchanged = false;
  document.getElementById('simulation-results').classList.add('hidden');
  renderDefenseLayers(targetId);
}

function removeDefense(targetId, defenseId) {
  const target = getTarget(targetId);
  if (!target) return;

  target.defenses = (target.defenses || []).filter(d => d.id !== defenseId);
  saveToStorage();

  // Evict only this defense's magazine entry (keyed by def.id) so other
  // systems retain any depletion recorded by prior simulation runs.
  deleteMagEntry(defenseId);
  _manifestUnchanged = false;
  document.getElementById('simulation-results').classList.add('hidden');
  renderDefenseLayers(targetId);
}


// ─────────────────────────────────────────────────────────────────────────────
// Rendering — Platform select (attack builder)
// ─────────────────────────────────────────────────────────────────────────────

function populatePlatformSelect() {
  const sel = document.getElementById('platform-select');
  sel.innerHTML = '<option value="">— Select Platform —</option>';

  const groups = {
    drone:             { label: 'Drones & Loitering Munitions', items: [] },
    cruise_missile:    { label: 'Cruise Missiles',              items: [] },
    ballistic_missile: { label: 'Ballistic Missiles (SRBM/MRBM)', items: [] },
    hypersonic:        { label: 'Hypersonic Glide Vehicles',    items: [] }
  };

  for (const [id, p] of Object.entries(PLATFORM_CATALOG)) {
    if (groups[p.type]) groups[p.type].items.push({ id, ...p });
  }

  for (const [, grp] of Object.entries(groups)) {
    if (grp.items.length === 0) continue;
    const optgrp = document.createElement('optgroup');
    optgrp.label = grp.label;
    for (const p of grp.items) {
      const opt       = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.country ? `${p.name} (${p.country})` : p.name;
      optgrp.appendChild(opt);
    }
    sel.appendChild(optgrp);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Salvo size select — updated whenever a platform is chosen
// ─────────────────────────────────────────────────────────────────────────────

function updateSalvoSelect(platformId) {
  const sel = document.getElementById('attack-quantity');
  sel.innerHTML = '';

  const platform   = platformId ? PLATFORM_CATALOG[platformId] : null;
  const salvoSizes = platform?.salvo_sizes || [];

  if (!platform || salvoSizes.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '—';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }

  sel.disabled = false;
  for (const size of salvoSizes) {
    const opt = document.createElement('option');
    opt.value = size;
    opt.textContent = size;
    sel.appendChild(opt);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Attack manifest CRUD
// ─────────────────────────────────────────────────────────────────────────────

function addPlatformToManifest(platformId, count) {
  if (!platformId || count < 1) return;
  // Merge with existing entry for same platform
  const existing = attackManifest.find(e => e.platformId === platformId);
  if (existing) {
    existing.count += count;
  } else {
    attackManifest.push({ platformId, count });
  }
  _manifestUnchanged = false;
  renderAttackManifest();
}

function removePlatformFromManifest(platformId) {
  attackManifest = attackManifest.filter(e => e.platformId !== platformId);
  _manifestUnchanged = false;
  renderAttackManifest();
}

function clearManifest() {
  attackManifest = [];
  _manifestUnchanged = false;
  renderAttackManifest();
}

function renderAttackManifest() {
  const container  = document.getElementById('attack-manifest');
  const simBtn     = document.getElementById('btn-simulate');
  const totalCount = attackManifest.reduce((s, e) => s + e.count, 0);

  if (attackManifest.length === 0) {
    container.innerHTML = '<p class="empty-state">No platforms added</p>';
    simBtn.disabled = true;
    return;
  }

  simBtn.disabled = !selectedTargetId;

  container.innerHTML = '';
  for (const entry of attackManifest) {
    const platform = PLATFORM_CATALOG[entry.platformId];
    if (!platform) continue;

    const row = document.createElement('div');
    row.className = `manifest-row threat-row-${platform.type}`;

    row.innerHTML = `
      <span class="manifest-dot threat-dot-${platform.type}"></span>
      <div class="manifest-name-col">
        <span class="manifest-name">${platform.name}</span>
        <span class="manifest-type-label">${THREAT_TYPE_LABELS[platform.type] || platform.type}</span>
      </div>
      ${platform.country ? `<span class="manifest-country">(${platform.country})</span>` : ''}
      <span class="manifest-count">Qty: ${entry.count}</span>
      <button class="btn-icon btn-remove-platform" data-pid="${entry.platformId}" title="Remove">✕</button>
    `;

    row.querySelector('.btn-remove-platform').addEventListener('click', (e) => {
      removePlatformFromManifest(e.currentTarget.dataset.pid);
    });

    container.appendChild(row);
  }

  // Total row
  const total = document.createElement('div');
  total.className = 'manifest-total';
  total.innerHTML = `<span>Total</span><span>${totalCount} platforms</span>`;
  container.appendChild(total);
}

// ─────────────────────────────────────────────────────────────────────────────
// Magazine helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk simulation results and record the final magazineRemaining for each
 * system. Because THREAT_PRIORITY iterates BM → CM → drone, the last write
 * per systemId reflects the lowest (final) remaining interceptor count.
 */
function extractMagazineState(results) {
  const state = {};
  for (const group of results.byThreatType) {
    for (const eng of group.engagements) {
      // Keyed by defId so multiple instances of the same system type are tracked
      // independently. The last write per defId is the lowest (final) remaining count.
      state[eng.defId] = eng.magazineRemaining;
    }
  }
  return state;
}

/**
 * Refresh the add-defense form's inline magazine note based on the currently
 * selected system and quantity.
 */
function updateDefenseMagazineInfo() {
  const systemId   = document.getElementById('defense-system-select').value;
  const qty        = Math.max(1, parseInt(document.getElementById('defense-quantity').value) || 1);
  const infoDiv    = document.getElementById('defense-magazine-info');
  const catalog    = systemId ? DEFENSE_CATALOG[systemId] : null;
  const perBattery = catalog?.magazinePerBattery || 0;

  if (!systemId || perBattery === 0) {
    infoDiv.classList.add('hidden');
    return;
  }

  const total = perBattery * qty;
  infoDiv.classList.remove('hidden');
  infoDiv.textContent =
    `${perBattery} interceptors/battery × ${qty} batter${qty !== 1 ? 'ies' : 'y'} = ${total} total interceptors`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline magazine count editor
// ─────────────────────────────────────────────────────────────────────────────

function activateMagazineEdit(span) {
  const defId  = span.dataset.defenseId;
  const maxVal = parseInt(span.dataset.max, 10);
  const currentVal = parseInt(span.textContent, 10);

  // Replace the span with a compact inline input
  const input = document.createElement('input');
  input.type      = 'number';
  input.className = 'mag-count-input';
  input.value     = currentVal;
  input.min = 0;
  input.max = maxVal;

  span.replaceWith(input);
  input.focus();
  input.select();

  let cancelled = false;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { cancelled = true; input.blur(); }
  });

  input.addEventListener('blur', () => {
    if (cancelled) {
      input.replaceWith(span);
      return;
    }

    const raw = input.value.trim();
    const val = parseInt(raw, 10);

    if (raw === '' || isNaN(val)) {
      showToast('Invalid value — must be a whole number.', true);
      input.replaceWith(span);
      return;
    }
    if (val < 0) {
      showToast('Invalid value — interceptor count cannot be negative.', true);
      input.replaceWith(span);
      return;
    }
    if (val > maxVal) {
      showToast(`Invalid value — cannot exceed the default loadout of ${maxVal} interceptors.`, true);
      input.replaceWith(span);
      return;
    }

    // Valid — persist the override, reset dirty flag, and rebuild the cards
    setMagEntry(defId, val);
    saveMagStateToStorage();
    _manifestUnchanged = false;
    if (selectedTargetId) renderDefenseLayers(selectedTargetId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation
// ─────────────────────────────────────────────────────────────────────────────

async function simulate() {
  if (!selectedTargetId || attackManifest.length === 0) return;

  // If nothing has changed since the last run, ask before proceeding
  if (_manifestUnchanged) {
    const proceed = await showModal({
      title:   'Attack Manifest Unchanged',
      message: 'Attack manifest unchanged since last simulation. Simulate anyways?',
      buttons: [
        { label: 'Yes', value: true,  style: 'primary'   },
        { label: 'No',  value: false, style: 'secondary' }
      ]
    });
    if (!proceed) return;
  }

  // New run — discard any overrides from the previous result
  manualOverrides = {};
  document.getElementById('override-notice')?.classList.add('hidden');

  try {
    const target            = getTarget(selectedTargetId);
    const perTargetDefenses = target?.defenses || [];

    // Include defenses from other targets whose range_km covers this target.
    // Their def.id keys into globalMagState, so magazine is shared automatically.
    const crossDefs = getCrossTargetDefenses(selectedTargetId).map(d => ({
      id:       d.id,
      system:   d.system,
      quantity: d.quantity,
      notes:    d.notes || ''
    }));

    const allDefenses = [...perTargetDefenses, ...crossDefs];

    // globalMagState is flat and keyed by def.id — pass directly as initial state.
    const results = runSimulation(attackManifest, allDefenses, globalMagState);

    // Merge updated magazine levels back into globalMagState.
    // Cross-target def.id entries are automatically shared with their source targets.
    const newMagState = extractMagazineState(results);
    Object.assign(globalMagState, newMagState);
    saveMagStateToStorage();

    _manifestUnchanged = true;
    lastSimResults = results;
    lastSimTarget  = target;
    renderDefenseLayers(selectedTargetId);

    renderSimulationResults(results, target);

    document.getElementById('simulation-results').classList.remove('hidden');
    document.getElementById('simulation-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error('Simulation error:', err);
    showToast('Simulation error — check console: ' + err.message, true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual override engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-walk the original simulation results, propagating counts forward from any
 * layer that has a manual override and re-applying downstream engagements with
 * the correct (adjusted) magazine states.
 *
 * Magazine tracking:
 *   - adjMag is seeded from each system's magazineAtStart at its first occurrence
 *     across all threat types, then updated as each engagement (re-)fires.
 *   - Override + disengaged = no interceptors expended.
 *   - Override + engaged    = interceptors recomputed for the new remaining count.
 */
function computeAdjustedResults(originalResults, overrides) {
  // Build magazine map keyed by defId, initialised from the earliest magazineAtStart
  // seen across all groups (= state before the first shot of the simulation).
  const adjMag = {};
  for (const group of originalResults.byThreatType) {
    for (const eng of group.engagements) {
      if (adjMag[eng.defId] === undefined && eng.magazineAtStart !== undefined)
        adjMag[eng.defId] = eng.magazineAtStart;
    }
  }

  let adjTotalOut = 0;

  const adjustedByThreatType = originalResults.byThreatType.map(group => {
    const { threatType, initialCount, engagements } = group;
    const groupOv = overrides[threatType] || {};
    let remaining = initialCount;
    const adjEngagements = [];

    for (const eng of engagements) {
      const magBefore = adjMag[eng.defId] ?? eng.magazineAtStart ?? 0;

      // ── Cannot engage — pass through, just update threatsIn display ─────────
      if (eng.note === 'Cannot engage') {
        adjEngagements.push({ ...eng, threatsIn: remaining });
        continue;
      }

      // ── Manual override at this layer ────────────────────────────────────────
      if (groupOv[eng.defId] !== undefined) {
        const ov = groupOv[eng.defId];
        const forcedSurvived = Math.min(ov.survived, remaining);
        const forcedKilled   = remaining - forcedSurvived;
        let interceptorsUsed, magAfter;

        if (ov.disengaged) {
          // System stood down — no interceptors expended
          interceptorsUsed = 0;
          magAfter = magBefore;
        } else {
          // System fired; recompute expended interceptors for the new remaining count
          const shots = eng.shotsPerEngagement ?? 2;
          if (shots === 0) {
            interceptorsUsed = 0;
            magAfter = magBefore;
          } else {
            const engageable = Math.min(remaining, Math.max(0, Math.floor(magBefore / shots)));
            interceptorsUsed = engageable * shots;
            magAfter = magBefore - interceptorsUsed;
          }
        }

        adjMag[eng.defId] = magAfter;
        adjEngagements.push({
          ...eng,
          threatsIn:         remaining,
          killed:            forcedKilled,
          survived:          forcedSurvived,
          magazineAtStart:   magBefore,
          magazineRemaining: magAfter,
          interceptorsUsed,
          isManualOverride:  true,
          isPlaceholder:     false,
          note: ov.disengaged ? 'Disengaged (manual)' : 'Manual override'
        });
        remaining = forcedSurvived;
        continue;
      }

      // ── Re-apply engagement with updated remaining and adjusted magazine ─────
      const result = applyEngagement(
        remaining,
        eng.pk ?? 0,
        magBefore,
        eng.shotsPerEngagement ?? 2
      );
      adjMag[eng.defId] = result.magazineRemaining;
      adjEngagements.push({
        ...eng,
        threatsIn:         remaining,
        killed:            result.killed,
        survived:          result.survived,
        magazineAtStart:   magBefore,
        magazineRemaining: result.magazineRemaining,
        interceptorsUsed:  magBefore - result.magazineRemaining,
        note:              result.note,
        isPlaceholder:     result.isPlaceholder
      });
      remaining = result.survived;
    }

    adjTotalOut += remaining;
    return { ...group, finalCount: remaining, engagements: adjEngagements };
  });

  const finalThreats = adjustedByThreatType
    .filter(b => b.finalCount > 0)
    .map(b => ({ type: b.threatType, count: b.finalCount }));

  return { ...originalResults, totalOut: adjTotalOut, finalThreats, byThreatType: adjustedByThreatType };
}

/** Store an override for one layer and re-render results. */
function applyLayerOverride(threatType, defId, survived, disengaged = false) {
  if (!manualOverrides[threatType]) manualOverrides[threatType] = {};
  manualOverrides[threatType][defId] = { survived, disengaged };
  rerenderWithOverrides();
}

/** Remove the override for one layer and re-render. */
function clearLayerOverride(threatType, defId) {
  if (manualOverrides[threatType]) {
    delete manualOverrides[threatType][defId];
    if (Object.keys(manualOverrides[threatType]).length === 0)
      delete manualOverrides[threatType];
  }
  rerenderWithOverrides();
}

/** Remove all overrides and re-render. */
function clearAllOverrides() {
  manualOverrides = {};
  rerenderWithOverrides();
}

/** Re-render results panel applying current manualOverrides (or original if none). */
function rerenderWithOverrides() {
  if (!lastSimResults) return;
  const hasOv = Object.keys(manualOverrides).length > 0;
  const display = hasOv
    ? computeAdjustedResults(lastSimResults, manualOverrides)
    : lastSimResults;

  document.getElementById('override-notice')?.classList.toggle('hidden', !hasOv);
  // Always show original inbound totals in the summary
  renderResultsSummary(lastSimResults, lastSimTarget);
  renderResultsLayers(display.byThreatType);
  renderResultsFinal(display);
}

/**
 * Open an inline override form directly below the given engagement row.
 * The user can specify how many were killed, or disengage the system entirely.
 */
function activateOverrideEdit(triggerBtn) {
  // Close any previously open override form first
  document.querySelector('.override-edit-form')?.remove();

  const threatType = triggerBtn.dataset.threat;
  const defId      = triggerBtn.dataset.def;
  const threatsIn  = parseInt(triggerBtn.dataset.threatsIn, 10);
  const killedNow  = parseInt(triggerBtn.dataset.killed,    10);

  const form = document.createElement('div');
  form.className = 'override-edit-form';
  form.innerHTML = `
    <span class="override-edit-label">Killed:</span>
    <input type="number" class="override-killed-input" value="${killedNow}" min="0" max="${threatsIn}">
    <span class="override-edit-label">of ${threatsIn}</span>
    <button class="btn btn-primary btn-sm btn-ov-apply">Apply</button>
    <button class="btn btn-warning btn-sm btn-ov-disengage" title="System does not fire; no interceptors expended">Disengage</button>
    <button class="btn btn-secondary btn-sm btn-ov-cancel">Cancel</button>
  `;

  triggerBtn.closest('.engagement-row').after(form);
  const input = form.querySelector('.override-killed-input');
  input.focus();
  input.select();

  form.querySelector('.btn-ov-apply').addEventListener('click', () => {
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0 || val > threatsIn) {
      showToast(`Enter a whole number between 0 and ${threatsIn}.`, true);
      return;
    }
    form.remove();
    applyLayerOverride(threatType, defId, threatsIn - val, false);
  });

  form.querySelector('.btn-ov-disengage').addEventListener('click', () => {
    form.remove();
    applyLayerOverride(threatType, defId, threatsIn, true);
  });

  form.querySelector('.btn-ov-cancel').addEventListener('click', () => form.remove());

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); form.querySelector('.btn-ov-apply').click(); }
    if (e.key === 'Escape') { e.preventDefault(); form.querySelector('.btn-ov-cancel').click(); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — Simulation results
// ─────────────────────────────────────────────────────────────────────────────

function renderSimulationResults(results, target) {
  renderResultsSummary(results, target);
  renderResultsLayers(results.byThreatType);
  renderResultsFinal(results);
}

function renderResultsSummary(results, target) {
  const el = document.getElementById('results-summary');

  const typeHtml = results.initialThreats.map(t =>
    `<span class="threat-chip threat-${t.type}">${THREAT_TYPE_ICONS[t.type] || ''} ${t.count}× ${THREAT_TYPE_LABELS[t.type] || t.type}</span>`
  ).join('');

  const systemsEngaged = new Set(
    results.byThreatType.flatMap(b => b.engagements.map(e => e.systemId))
  ).size;

  el.innerHTML = `
    <div class="summary-header">
      <div>
        <div class="summary-target">${target?.name || 'Unknown Target'}</div>
        <div class="summary-meta">${target?.country || ''}</div>
      </div>
      <div class="summary-count">${results.totalIn} platforms inbound</div>
    </div>
    <div class="summary-threats">${typeHtml}</div>
    <div class="summary-layers-note">${systemsEngaged} defensive system${systemsEngaged !== 1 ? 's' : ''} engaged</div>
  `;
}

function renderResultsLayers(byThreatType) {
  const container = document.getElementById('results-layers');
  container.innerHTML = '';

  if (byThreatType.length === 0) {
    container.innerHTML = '<p class="empty-state">No defensive systems at this target.</p>';
    return;
  }

  for (const group of byThreatType) {
    container.appendChild(buildThreatTypeSection(group));
  }
}

function buildThreatTypeSection(group) {
  const { threatType, initialCount, finalCount, engagements } = group;
  const icon  = THREAT_TYPE_ICONS[threatType]  || '';
  const label = THREAT_TYPE_LABELS[threatType] || threatType;

  const section = document.createElement('div');
  section.className = 'threat-section';

  // ── Header ──────────────────────────────────────────────────────────────
  const hdr = document.createElement('div');
  hdr.className = `threat-section-header threat-section-${threatType}`;
  hdr.innerHTML = `
    <span class="threat-section-icon">${icon}</span>
    <span class="threat-section-label">${label}</span>
    <span class="threat-section-count">${initialCount} inbound</span>
  `;
  section.appendChild(hdr);

  // ── Engagement rows ──────────────────────────────────────────────────────
  if (engagements.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'engagement-row engagement-pass';
    empty.textContent = 'No systems assigned — all pass through';
    section.appendChild(empty);
  } else {
    for (const eng of engagements) {
      section.appendChild(buildEngagementRow(eng, threatType));
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  const allKilled  = finalCount === 0;
  const noneKilled = finalCount === initialCount;
  const ftrClass   = allKilled ? 'ftr-all' : noneKilled ? 'ftr-none' : 'ftr-partial';
  const ftrText    = allKilled
    ? `All ${initialCount} intercepted`
    : `${finalCount} of ${initialCount} penetrate`;

  const ftr = document.createElement('div');
  ftr.className = `threat-section-footer ${ftrClass}`;
  ftr.textContent = ftrText;
  section.appendChild(ftr);

  return section;
}

function buildEngagementRow(eng, threatType = '') {
  const row = document.createElement('div');

  if (eng.note === 'Cannot engage') {
    row.className = 'engagement-row eng-no-capability';
    row.innerHTML = `
      <span class="eng-name">${eng.systemName}</span>
      <span class="eng-note-text">Cannot engage this threat type — passes through</span>
    `;
    return row;
  }

  if (eng.note === 'Magazine exhausted') {
    row.className = 'engagement-row eng-exhausted';
    row.innerHTML = `
      <span class="eng-name">${eng.systemName}</span>
      <span class="eng-note-text">Magazine exhausted — ${eng.threatsIn} pass through</span>
    `;
    return row;
  }

  // ── Disengaged (manual override with zero kills) ─────────────────────────
  if (eng.note === 'Disengaged (manual)') {
    row.className = 'engagement-row eng-none eng-overridden';
    row.innerHTML = `
      <div class="eng-system">
        <span class="eng-name">${eng.systemName}</span>
        <span class="eng-qty">${eng.quantity} batt.</span>
        ${eng.notes ? `<span class="eng-notes">${eng.notes}</span>` : ''}
        <span class="override-badge">⚡ Disengaged</span>
      </div>
      <div class="eng-stats">
        <span class="eng-killed">0 killed</span>
        <span class="eng-sep">/</span>
        <span class="eng-in">${eng.threatsIn} in</span>
      </div>
      <button class="btn-icon btn-clear-override"
        data-threat="${threatType}" data-def="${eng.defId}" title="Clear override">✕</button>
    `;
    row.querySelector('.btn-clear-override')
      .addEventListener('click', e => clearLayerOverride(e.currentTarget.dataset.threat, e.currentTarget.dataset.def));
    return row;
  }

  // ── Normal / manually-overridden engagement ──────────────────────────────
  const isOverride    = !!eng.isManualOverride;
  const isPlaceholder = !!eng.isPlaceholder;
  const statusClass   = eng.killed === 0 ? 'eng-none'
                      : eng.survived === 0 ? 'eng-all' : 'eng-partial';

  row.className = `engagement-row ${statusClass}`
    + (isPlaceholder ? ' eng-placeholder' : '')
    + (isOverride    ? ' eng-overridden'  : '');

  const pkText = isPlaceholder
    ? '<span class="eng-placeholder-badge">PLACEHOLDER</span>'
    : `<span class="eng-pk">Pk = ${(eng.pk ?? 0).toFixed(2)}</span>`;

  const intUsed = eng.interceptorsUsed ?? 0;

  const overrideBadge = isOverride
    ? `<span class="override-badge">⚡ Override
         <button class="btn-icon btn-clear-override"
           data-threat="${threatType}" data-def="${eng.defId}" title="Clear override">✕</button>
       </span>`
    : '';

  // Edit button only appears on un-overridden rows when a simulation is stored
  const editBtn = (!isOverride && threatType && lastSimResults)
    ? `<button class="btn-icon btn-override-eng"
         data-threat="${threatType}" data-def="${eng.defId}"
         data-threats-in="${eng.threatsIn}" data-killed="${eng.killed}"
         title="Override this layer's result">⚙</button>`
    : '';

  row.innerHTML = `
    <div class="eng-system">
      <span class="eng-name">${eng.systemName}</span>
      <span class="eng-qty">${eng.quantity} batt.</span>
      ${eng.notes ? `<span class="eng-notes">${eng.notes}</span>` : ''}
      ${overrideBadge}
    </div>
    <div class="eng-stats">
      <span class="eng-killed">${eng.killed} killed</span>
      <span class="eng-sep">/</span>
      <span class="eng-in">${eng.threatsIn} in</span>
      ${pkText}
      ${intUsed > 0 ? `<span class="eng-interceptors">${intUsed} int.</span>` : ''}
    </div>
    ${editBtn}
  `;

  row.querySelector('.btn-override-eng')
    ?.addEventListener('click', e => activateOverrideEdit(e.currentTarget));

  row.querySelectorAll('.btn-clear-override')
    .forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      clearLayerOverride(e.currentTarget.dataset.threat, e.currentTarget.dataset.def);
    }));

  return row;
}

function renderResultsFinal(results) {
  const el = document.getElementById('results-final');

  const penetrators = results.finalThreats.filter(t => t.count > 0);
  const allKilled   = results.totalOut === 0;
  const noneKilled  = results.totalOut === results.totalIn;

  const hasPlaceholder = results.byThreatType.some(b => b.engagements.some(e => e.isPlaceholder));

  let html = `<div class="final-result ${allKilled ? 'final-all-killed' : noneKilled ? 'final-none-killed' : 'final-partial'}">`;

  if (allKilled) {
    html += `
      <div class="final-headline">All ${results.totalIn} platforms intercepted</div>
      <div class="final-sub">No penetrators reached the target.</div>`;
  } else {
    html += `
      <div class="final-headline">${results.totalOut} of ${results.totalIn} platforms penetrate defenses</div>`;

    if (penetrators.length > 0) {
      const chips = penetrators.map(t =>
        `<span class="threat-chip threat-${t.type}">${THREAT_TYPE_ICONS[t.type] || ''} ${t.count}× ${THREAT_TYPE_LABELS[t.type] || t.type}</span>`
      ).join('');
      html += `<div class="final-penetrators">${chips}</div>`;
    }
  }

  if (hasPlaceholder) {
    html += `<div class="placeholder-notice">⚠ One or more defensive layers used placeholder Pk = 0.00. Set actual Pk values in js/simulate.js for meaningful results.</div>`;
  }

  html += '</div>';
  el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal dialog
// ─────────────────────────────────────────────────────────────────────────────

let _modalResolve = null;

/**
 * Show a blocking in-page modal dialog.
 *
 * @param {object}   config
 * @param {string}   config.title    — Dialog heading
 * @param {string}   config.message  — Body text (plain text; no HTML)
 * @param {Array}    config.buttons  — Button descriptors, rendered left-to-right.
 *                                     Each: { label, value, style }
 *                                     style: 'primary' | 'secondary' | 'danger'
 *                                     Defaults to a single OK button.
 * @returns {Promise<any>}  Resolves with the `value` of the button clicked,
 *                          or false if dismissed via the ESC key.
 *
 * Usage:
 *   const ok = await showModal({
 *     title:   'Confirm Reset',
 *     message: 'All local changes will be lost.',
 *     buttons: [
 *       { label: 'Reset', value: true,  style: 'danger'     },
 *       { label: 'Cancel', value: false, style: 'secondary' }
 *     ]
 *   });
 *   if (ok) { ... }
 */
function showModal({ title, message, buttons = [{ label: 'OK', value: true, style: 'primary' }] }) {
  return new Promise(resolve => {
    _modalResolve = resolve;

    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').textContent  = message;

    const footer = document.getElementById('modal-footer');
    footer.innerHTML = '';
    for (const btn of buttons) {
      const el     = document.createElement('button');
      el.className = `btn btn-${btn.style || 'secondary'}`;
      el.textContent = btn.label;
      el.addEventListener('click', () => _resolveModal(btn.value));
      footer.appendChild(el);
    }

    document.getElementById('modal-overlay').classList.remove('hidden');

    // Put focus on the first button so keyboard users can act immediately
    const firstBtn = footer.querySelector('.btn');
    if (firstBtn) firstBtn.focus();
  });
}

function _resolveModal(value) {
  document.getElementById('modal-overlay').classList.add('hidden');
  if (_modalResolve) {
    _modalResolve(value);
    _modalResolve = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast notification
// ─────────────────────────────────────────────────────────────────────────────

function showToast(message, isError = false) {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id    = 'toast';
  toast.className = `toast ${isError ? 'toast-error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add('toast-show'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────────────────────────────────────

function wireEvents() {
  // Target selection
  document.getElementById('target-select').addEventListener('change', (e) => {
    selectedTargetId = e.target.value || null;
    const target = getTarget(selectedTargetId);
    renderTargetInfo(target);

    // Switching targets — reset dirty flag so the next sim runs freely.
    // globalMagState is intentionally preserved so cross-target magazine
    // depletion carries across target selections.
    _manifestUnchanged = false;
    renderDefenseLayers(selectedTargetId);

    // Update simulate / reset-loadouts button states
    const simBtn = document.getElementById('btn-simulate');
    simBtn.disabled = !selectedTargetId || attackManifest.length === 0;
    document.getElementById('btn-reset-loadouts').disabled      = !selectedTargetId;
    document.getElementById('btn-reset-target-default').disabled = !selectedTargetId;

    // Hide results when target changes
    document.getElementById('simulation-results').classList.add('hidden');
  });

  // Add defense toggle
  document.getElementById('btn-add-defense').addEventListener('click', () => {
    const form = document.getElementById('add-defense-form');
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) {
      populateDefenseSystemSelect();
      document.getElementById('defense-system-select').focus();
      // Reset magazine info when form opens
      document.getElementById('defense-magazine-info').classList.add('hidden');
    }
  });

  // Magazine info — update when system or quantity changes
  document.getElementById('defense-system-select').addEventListener('change', updateDefenseMagazineInfo);
  document.getElementById('defense-quantity').addEventListener('input', updateDefenseMagazineInfo);

  // Confirm add defense
  document.getElementById('btn-confirm-add-defense').addEventListener('click', () => {
    const systemId = document.getElementById('defense-system-select').value;
    const qty      = parseInt(document.getElementById('defense-quantity').value) || 1;
    const notes    = document.getElementById('defense-notes').value.trim();

    if (!systemId) { showToast('Please select a system.', true); return; }
    if (!selectedTargetId) { showToast('Please select a target first.', true); return; }

    addDefense(selectedTargetId, systemId, Math.max(1, qty), notes);
    document.getElementById('add-defense-form').classList.add('hidden');
    document.getElementById('defense-system-select').value = '';
    document.getElementById('defense-quantity').value = '1';
    document.getElementById('defense-notes').value = '';
  });

  // Cancel add defense
  document.getElementById('btn-cancel-add-defense').addEventListener('click', () => {
    document.getElementById('add-defense-form').classList.add('hidden');
  });

  // Update salvo options when platform changes
  document.getElementById('platform-select').addEventListener('change', (e) => {
    updateSalvoSelect(e.target.value || null);
  });

  // Add platform to attack
  document.getElementById('btn-add-platform').addEventListener('click', () => {
    const platformId = document.getElementById('platform-select').value;
    const qty        = parseInt(document.getElementById('attack-quantity').value) || 0;
    if (!platformId) { showToast('Please select a platform.', true); return; }
    if (!qty)        { showToast('Please select a salvo size.', true); return; }
    addPlatformToManifest(platformId, qty);
    document.getElementById('platform-select').value = '';
    updateSalvoSelect(null);
  });

  // Clear attack manifest
  document.getElementById('btn-clear-attack').addEventListener('click', clearManifest);

  // Reset loadouts
  document.getElementById('btn-reset-loadouts').addEventListener('click', resetLoadouts);

  // Reset target to default laydown
  document.getElementById('btn-reset-target-default').addEventListener('click', () => resetTargetToDefault(selectedTargetId));

  // Simulate
  document.getElementById('btn-simulate').addEventListener('click', simulate);

  // Clear results
  document.getElementById('btn-clear-results').addEventListener('click', () => {
    document.getElementById('simulation-results').classList.add('hidden');
  });

  // Clear all manual overrides
  document.getElementById('btn-clear-overrides').addEventListener('click', clearAllOverrides);

  // Export JSON
  document.getElementById('btn-export').addEventListener('click', exportData);

  // Reset to default
  document.getElementById('btn-reset').addEventListener('click', resetData);

  // ── Modal — ESC key dismisses ─────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!document.getElementById('modal-overlay').classList.contains('hidden')) {
        _resolveModal(false);
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  await loadData();
  mergeLoadedData();
  renderTargetDropdown();
  populatePlatformSelect();
  renderDefenseLayers(null);
  wireEvents();
}

document.addEventListener('DOMContentLoaded', init);
