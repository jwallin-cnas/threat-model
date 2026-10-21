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

/**
 * Short display label for a defense system: the abbreviation in trailing
 * parentheses when the catalog name has one ("… (THAAD)" → "THAAD"), else the
 * full name. Use the full name in a tooltip alongside it.
 */
function systemShortLabel(sys) {
  // Only an upper-case abbreviation counts ("THAAD", "FS-LIDS", "IFPC-2");
  // a trailing count such as "(×4)" is part of the name and stays.
  const m = /\(([A-Z][A-Z0-9/-]{1,11})\)\s*$/.exec(sys?.name || '');
  return m ? m[1] : (sys?.shortName || sys?.name || '');
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
/** Item list for the Blue system search box: Presets group, then Systems by name. */
function systemTypeAheadItems() {
  const items = BUILDER_DATA.presets.map(p => ({
    id: p.id, label: p.name, group: 'Presets', tag: 'Preset', keywords: [p.id, systemShortLabel(p)]
  }));
  for (const sys of Object.values(DEFENSE_CATALOG).sort((a, b) => a.name.localeCompare(b.name))) {
    items.push({ id: sys.id, label: sys.name, group: 'Systems', tag: '', keywords: [sys.id, systemShortLabel(sys)] });
  }
  return items;
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

/** Short threat-type tag shown on each row of a filtered platform list. */
const PLATFORM_SEARCH_TAGS = {
  mrbm: 'MRBM', srbm: 'SRBM', cruise_missile: 'Cruise missile', drone: 'Drone',
  drone_jet: 'Jet drone', fpv: 'FPV', hypersonic: 'Hypersonic'
};

/** Item list for the Red platform search box, grouped by threat type. */
function platformTypeAheadItems() {
  const groups = {};
  for (const key of Object.keys(PLATFORM_GROUP_LABELS)) groups[key] = [];
  for (const p of Object.values(PLATFORM_CATALOG)) {
    if (!groups[p.type]) groups[p.type] = [];   // unknown type → its own group
    groups[p.type].push(p);
  }
  const items = [];
  for (const [type, list] of Object.entries(groups)) {
    const group = PLATFORM_GROUP_LABELS[type] || THREAT_TYPE_LABELS?.[type] || type;
    for (const p of list) {
      items.push({
        id:       p.id,
        label:    p.country ? `${p.name} (${p.country})` : p.name,
        group,
        tag:      PLATFORM_SEARCH_TAGS[type] || group,
        keywords: [p.id, type]          // "mrbm" lists every MRBM
      });
    }
  }
  return items;
}

/** Common abbreviations an operator can be found by in the search box. */
const OPERATOR_SEARCH_KEYWORDS = {
  'United States':        ['US', 'U.S.', 'USA'],
  'United Arab Emirates': ['UAE', 'U.A.E.'],
  'Saudi Arabia':         ['KSA'],
  'United Kingdom':       ['UK', 'U.K.']
};

/** Item list for the Blue operator search box (no groups). */
function operatorTypeAheadItems() {
  return operatorOptions().map(c => ({ id: c, label: c, group: null, keywords: OPERATOR_SEARCH_KEYWORDS[c] || [] }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Type-ahead search box (WAI-ARIA combobox with a listbox popup)
//
// Replaces a <select>: the user types part of a name, the popup lists the
// matches, and Enter or a click chooses one. The box only holds values from
// its list; on blur, text that is not a valid choice reverts.
// ─────────────────────────────────────────────────────────────────────────────

/** Lower-case, letters and digits only: "F-15E" → "f15e", "U.S." → "us". */
function _taCompact(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

/**
 * Rank how well `item` matches `query` (lower is better, -1 = no match):
 *   0  name starts with the query       ("pat"   → Patriot, "f15" → F-15E)
 *   1  a word in the name starts with it ("dome"  → Iron Dome, "sm" → Aegis SM3)
 *   2  a keyword starts with it          ("thaad", "nasams", "uae", "mrbm")
 *   3  the name contains it anywhere     ("atr"   → Patriot, Patrol)
 */
function typeAheadRank(item, query) {
  const q  = String(query || '').trim().toLowerCase();
  if (!q) return 0;
  const qc   = _taCompact(q);
  const name = item.label.toLowerCase();
  if (name.startsWith(q) || (qc && _taCompact(name).startsWith(qc))) return 0;
  const words = name.split(/[\s\-\/(),.]+/).filter(Boolean);
  if (words.some(w => w.startsWith(q) || (qc && w.startsWith(qc)))) return 1;
  for (const k of item.keywords || []) {
    const kl = String(k).toLowerCase();
    if (kl.startsWith(q) || (qc && _taCompact(kl).startsWith(qc))) return 2;
  }
  if (name.includes(q) || (qc && _taCompact(name).includes(qc))) return 3;
  return -1;
}

/** Matching items, best rank first, catalog order within a rank. */
function typeAheadFilter(items, query) {
  return items
    .map((item, i) => ({ item, i, r: typeAheadRank(item, query) }))
    .filter(x => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.item);
}

let _taSeq = 0;

/**
 * Turn a text <input> inside a `.ta-wrap` element into a search box.
 *
 * @param {HTMLInputElement} input
 * @param {object}   opts
 * @param {Array}    opts.items      [{ id, label, group, tag, keywords }] — `group`
 *                                   heads the full list; `tag` (default: group)
 *                                   labels each row of a filtered list
 * @param {Function} [opts.onChange] (item|null) — the chosen value changed
 * @param {Function} [opts.onEnter]  (item, how) — the user confirmed a value with
 *                                   Enter or a click (how = 'enter' | 'click');
 *                                   pages use it to move focus to the next field
 * @param {boolean}  [opts.clearable=true] Escape on a closed popup clears the box
 * @param {string}   [opts.emptyText='No matches']
 * @returns {{ value: Function, setValue: Function, clear: Function, focus: Function }}
 */
function attachTypeAhead(input, opts) {
  const items     = opts.items || [];
  const clearable = opts.clearable !== false;
  const byId      = new Map(items.map(it => [it.id, it]));
  const listId    = `ta-list-${++_taSeq}`;

  const list = document.createElement('ul');
  list.className = 'ta-list hidden';
  list.id        = listId;
  list.setAttribute('role', 'listbox');
  input.insertAdjacentElement('afterend', list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';
  input.spellcheck   = false;

  let selected = null;   // chosen item (committed value)
  let shown    = [];     // items currently listed, in display order
  let active   = -1;     // index into `shown` of the highlighted row
  let isOpen   = false;

  const typedQuery = () => (selected && input.value === selected.label) ? '' : input.value;

  function render() {
    const q = typedQuery().trim();
    shown = q ? typeAheadFilter(items, q) : items.slice();
    list.innerHTML = '';
    if (shown.length === 0) {
      const li = document.createElement('li');
      li.className   = 'ta-empty';
      li.textContent = opts.emptyText || 'No matches';
      list.appendChild(li);
      active = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let lastGroup = null;
    shown.forEach((item, i) => {
      // Full list: group headings as in the old <select>. Filtered list: a
      // flat ranked list, with the group as a small tag on each row.
      if (!q && item.group && item.group !== lastGroup) {
        const h = document.createElement('li');
        h.className = 'ta-group';
        h.setAttribute('role', 'presentation');
        h.textContent = item.group;
        list.appendChild(h);
        lastGroup = item.group;
      }
      const li = document.createElement('li');
      li.className = 'ta-option';
      li.id        = `${listId}-${i}`;
      li.dataset.index = String(i);
      li.setAttribute('role', 'option');
      li.innerHTML = `<span class="ta-option-label">${escapeHtml(item.label)}</span>`
                   + (q && (item.tag ?? item.group) ? `<span class="ta-option-tag">${escapeHtml(item.tag ?? item.group)}</span>` : '');
      list.appendChild(li);
    });
    highlight(q ? 0 : Math.max(0, shown.indexOf(selected)));
  }

  function highlight(i) {
    const rows = list.querySelectorAll('.ta-option');
    rows.forEach(r => { r.classList.remove('is-active'); r.setAttribute('aria-selected', 'false'); });
    if (shown.length === 0) { active = -1; return; }
    active = (i + shown.length) % shown.length;
    const row = rows[active];
    row.classList.add('is-active');
    row.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', row.id);
    // Scroll the popup only; scrollIntoView() would also scroll the page.
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }

  function open()  { if (!isOpen) { isOpen = true; list.classList.remove('hidden'); input.setAttribute('aria-expanded', 'true'); } render(); }
  function close() {
    isOpen = false;
    list.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function commit(item) {
    const changed = item !== selected;
    selected    = item;
    input.value = item ? item.label : '';
    close();
    if (changed) opts.onChange?.(item);
  }

  /** Exact (case-insensitive) label typed in full counts as a choice. */
  function exactMatch() {
    const t = input.value.trim().toLowerCase();
    return t ? items.find(it => it.label.toLowerCase() === t) || null : null;
  }

  // Focus opens the full list only on an empty box. A filled box (Operator
  // arrives filled) opens on typing, ↓/↑ or a click, so its popup does not
  // cover the fields and buttons below it when focus moves in from Enter.
  input.addEventListener('focus', () => { input.select(); if (!input.value) open(); });
  input.addEventListener('click', () => { if (!isOpen) open(); });
  // Typing only filters. The chosen value stays until a new one is picked,
  // so text that matches nothing reverts to it on blur.
  input.addEventListener('input', open);

  input.addEventListener('keydown', e => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) open();
        else highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
        break;
      case 'Enter': {
        e.preventDefault();
        const clean = selected && input.value === selected.label;
        const item  = isOpen ? (shown[active] || null) : (clean ? selected : exactMatch());
        if (!item) { open(); break; }   // no match: show why; nothing else happens
        commit(item);
        opts.onEnter?.(item, 'enter');
        break;
      }
      case 'Tab':
        // Typed text + Tab takes the highlighted row; focus then moves on as usual.
        if (isOpen && typedQuery().trim() && shown[active]) commit(shown[active]);
        else close();
        break;
      case 'Escape':
        if (isOpen) { e.preventDefault(); e.stopPropagation(); close(); }
        else if (clearable && input.value) { e.preventDefault(); commit(null); }
        break;
    }
  });

  // On blur: an exact label typed in full is taken; an emptied box clears
  // (when clearable); anything else reverts to the last chosen value.
  input.addEventListener('blur', () => {
    close();
    if (selected && input.value === selected.label) return;
    const exact = exactMatch();
    if (exact) commit(exact);
    else if (clearable && !input.value.trim()) commit(null);
    else input.value = selected ? selected.label : '';
  });

  // mousedown (not click) so the input keeps focus and blur does not revert first
  list.addEventListener('mousedown', e => {
    e.preventDefault();
    const row = e.target.closest('.ta-option');
    if (!row) return;
    const item = shown[parseInt(row.dataset.index, 10)];
    if (!item) return;
    commit(item);
    opts.onEnter?.(item, 'click');
  });

  return {
    value:    () => selected?.id ?? '',
    setValue: id => commit(byId.get(id) || null),
    clear:    () => commit(null),
    focus:    () => input.focus()
  };
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
    return `${perBattery} interceptors/system × ${q} system${q !== 1 ? 's' : ''} = ${total} total interceptors`;
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
