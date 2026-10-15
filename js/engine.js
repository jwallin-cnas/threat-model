/**
 * engine.js — Pure air-defence simulation engine
 *
 * The engine is driven by two data files instead of code:
 *
 *   Pk table  (data/pk-table.json)  per-shot kill probability and shots for
 *                                   every defense system × attack platform
 *   Doctrine  (data/doctrine.json)  the order in which threat types are
 *                                   processed and, for each type, the ordered
 *                                   list of systems allowed to engage it
 *
 * The rule that turns a cell into an engagement lives in
 * engagement-models.js (kinetic, directed_energy, gun, patrol); each system
 * names its model in defenses.json.
 *
 * All functions receive their dependencies as explicit parameters so this
 * module runs in the browser (globals, loaded after engagement-models.js)
 * and in Node.js for the Vitest suite. Do not reference browser-only
 * globals here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The threat types the engine knows. A doctrine's typeOrder is a subset. */
const THREAT_TYPES = ['mrbm', 'srbm', 'cruise_missile', 'drone_jet', 'drone', 'fpv'];

const _TIER_LABELS = {
  1: 'Exo-Atmospheric',
  2: 'Upper Endo-Atmospheric',
  3: 'Mid-Range SAM',
  4: 'Short-Range SAM',
  5: 'SHORAD',
  6: 'Close-In Defense'
};

/** Display tier from range: 1 = longest range / exo-atmospheric. */
function inferTier(range_km) {
  if (range_km >= 200) return 1;
  if (range_km >= 100) return 2;
  if (range_km >= 50)  return 3;
  if (range_km >= 25)  return 4;
  if (range_km >= 10)  return 5;
  return 6;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a defense-system catalog from the raw defenses.json `systems` array.
 * Returns a plain object keyed by system id; does not touch any global.
 */
function buildDefenseCatalog(systems) {
  const catalog = {};
  for (const sys of systems) {
    const tier = inferTier(sys.range_km);
    catalog[sys.id] = {
      id:                   sys.id,
      name:                 sys.name,
      shortName:            sys.name,
      tier,
      tierLabel:            _TIER_LABELS[tier] || 'Unknown',
      type:                 'SAM',
      country:              '',
      range_km:             sys.range_km || 0,
      defaultBatteries:     sys.batteries || 1,
      isShared:             sys.shared || false,
      threatRangeOverrides: sys.threat_range_overrides || {},
      magazinePerBattery:   sys.armament?.standard_loadout || 0,
      engagement:           sys.engagement || { model: 'kinetic' },
      description:          `Range: ${sys.range_km} km`
    };
  }
  return catalog;
}

/**
 * Build an attack-platform catalog from the raw attacks.json `systems` array.
 * Returns a plain object keyed by platform id; does not touch any global.
 */
function buildPlatformCatalog(systems) {
  const catalog = {};
  for (const sys of systems) {
    catalog[sys.id] = {
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
  return catalog;
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctrine helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a doctrine object and report problems. Unknown threat types and
 * unknown or duplicate system ids are dropped with a warning. Every type in
 * typeOrder gets an engage list (empty if missing). The input is not changed.
 *
 * @returns {{ doctrine: object, warnings: string[] }}
 */
function normalizeDoctrine(raw, defenseCatalog) {
  const warnings = [];
  const out = { version: raw?.version || '1.0', name: raw?.name || '', typeOrder: [], engage: {} };

  const seenTypes = new Set();
  for (const t of Array.isArray(raw?.typeOrder) ? raw.typeOrder : []) {
    if (!THREAT_TYPES.includes(t))    { warnings.push(`Unknown threat type "${t}" in typeOrder — dropped`); continue; }
    if (seenTypes.has(t))             { warnings.push(`Duplicate threat type "${t}" in typeOrder — dropped`); continue; }
    seenTypes.add(t);
    out.typeOrder.push(t);
  }
  for (const t of THREAT_TYPES) {
    if (!seenTypes.has(t)) warnings.push(`Threat type "${t}" is not in typeOrder — it will never be processed`);
  }

  for (const t of out.typeOrder) {
    const list = raw?.engage?.[t];
    if (!Array.isArray(list)) { warnings.push(`No engage list for "${t}" — no system engages it`); out.engage[t] = []; continue; }
    const seen = new Set();
    out.engage[t] = [];
    for (const id of list) {
      if (!defenseCatalog[id]) { warnings.push(`Unknown system "${id}" in engage.${t} — dropped`); continue; }
      if (seen.has(id))        { warnings.push(`Duplicate system "${id}" in engage.${t} — dropped`); continue; }
      seen.add(id);
      out.engage[t].push(id);
    }
  }
  for (const t of Object.keys(raw?.engage || {})) {
    if (!seenTypes.has(t)) warnings.push(`engage.${t} is present but "${t}" is not in typeOrder — ignored`);
  }
  return { doctrine: out, warnings };
}

/** Threat types (in doctrine order) whose engage list contains the system. */
function systemThreatTypes(doctrine, systemId) {
  return (doctrine?.typeOrder || []).filter(t => (doctrine.engage?.[t] || []).includes(systemId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pk table helpers
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_CELL = Object.freeze({ pk: 0, shots: 0 });

/**
 * Normalise a Pk table and report problems. The result is dense: every
 * system × platform pair has a cell. Missing cells become { pk: 0, shots: 0 }
 * (cannot engage). Unknown ids are dropped, values are clamped, and the
 * tier multipliers default to 1.0. The input is not changed.
 *
 * @returns {{ table: object, warnings: string[] }}
 */
function normalizePkTable(raw, defenseCatalog, platformCatalog) {
  const warnings = [];
  const tiers = { low: 1, medium: 1, high: 1 };
  for (const k of Object.keys(tiers)) {
    const v = raw?.tiers?.[k];
    if (v == null) continue;
    if (typeof v !== 'number' || !(v >= 0)) { warnings.push(`tiers.${k} is not a number ≥ 0 — using 1.0`); continue; }
    tiers[k] = v;
  }

  const cells = {};
  for (const sysId of Object.keys(defenseCatalog)) {
    cells[sysId] = {};
    for (const platId of Object.keys(platformCatalog)) {
      const c = raw?.cells?.[sysId]?.[platId];
      if (c == null) { cells[sysId][platId] = { pk: 0, shots: 0 }; warnings.push(`No cell for ${sysId} × ${platId} — treated as cannot engage`); continue; }
      let pk    = Number(c.pk);
      let shots = Number(c.shots);
      if (!Number.isFinite(pk))    { warnings.push(`${sysId} × ${platId}: pk is not a number — using 0`); pk = 0; }
      if (!Number.isFinite(shots)) { warnings.push(`${sysId} × ${platId}: shots is not a number — using 0`); shots = 0; }
      if (pk < 0 || pk > 1)        { warnings.push(`${sysId} × ${platId}: pk ${pk} clamped to [0, 1]`); pk = Math.min(1, Math.max(0, pk)); }
      if (shots < 0)               { warnings.push(`${sysId} × ${platId}: shots ${shots} clamped to 0`); shots = 0; }
      cells[sysId][platId] = { pk, shots };
    }
  }
  for (const sysId of Object.keys(raw?.cells || {})) {
    if (!defenseCatalog[sysId]) { warnings.push(`Unknown system "${sysId}" in cells — dropped`); continue; }
    for (const platId of Object.keys(raw.cells[sysId] || {})) {
      if (!platformCatalog[platId]) warnings.push(`Unknown platform "${platId}" under ${sysId} — dropped`);
    }
  }
  return { table: { version: raw?.version || '1.0', name: raw?.name || '', tiers, cells }, warnings };
}

/** The cell for a pairing, or the empty cell. */
function pkCell(table, systemId, platformId) {
  return table?.cells?.[systemId]?.[platformId] || EMPTY_CELL;
}

/**
 * Pick a tier multiplier. When all three multipliers are 1.0 the roll is
 * skipped (no rng call) and the tier name is null, so a deterministic table
 * does not consume random numbers.
 *
 * @returns {{ tier: (string|null), mult: number }}
 */
function rollTier(tiers, rng) {
  if (tiers.low === 1 && tiers.medium === 1 && tiers.high === 1) return { tier: null, mult: 1 };
  const u = rng();
  const tier = u >= 0.67 ? 'high' : u >= 0.33 ? 'medium' : 'low';
  return { tier, mult: tiers[tier] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core engagement arithmetic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply one layer's engagement against a group of threats.
 *
 * @param {number} count          threats inbound to this layer
 * @param {number} P              probability that one engaged threat is killed
 * @param {number} magazine       interceptors available now
 * @param {number} shotsPerThreat magazine cost per engaged threat (0 = no magazine use)
 * @returns {{ killed, survived, engaged, interceptorsUsed, magazineRemaining, note }}
 *
 * shotsPerThreat may be fractional (THAAD 1.5), so magazineRemaining can be.
 * The kill count is the rounded expected value: the only randomness in the
 * engine is the Pk tier and any shot roll, both decided before this call.
 */
function applyEngagement(count, P, magazine, shotsPerThreat) {
  if (count <= 0) return { killed: 0, survived: 0, engaged: 0, interceptorsUsed: 0, magazineRemaining: magazine, note: null };

  if (shotsPerThreat === 0) {
    const killed = Math.round(count * P);
    return { killed, survived: count - killed, engaged: count, interceptorsUsed: 0, magazineRemaining: magazine, note: null };
  }

  if (magazine <= 0) {
    return { killed: 0, survived: count, engaged: 0, interceptorsUsed: 0, magazineRemaining: 0, note: 'Magazine exhausted' };
  }

  const maxEngageable = Math.max(0, Math.floor(magazine / shotsPerThreat));
  const engaged       = Math.min(count, maxEngageable);
  const killed        = Math.round(engaged * P);
  const used          = engaged * shotsPerThreat;
  return {
    killed,
    survived:          count - killed,
    engaged,
    interceptorsUsed:  used,
    magazineRemaining: magazine - used,
    note:              null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Group the attack manifest by threat type, preserving manifest order within
 * a type and merging repeated platform ids. Unknown platforms are skipped.
 *
 * @returns {Object<string, Array<{platformId, count}>>}
 */
function groupManifest(attackManifest, platformCatalog) {
  const groups = {};
  for (const entry of attackManifest || []) {
    const platform = platformCatalog[entry.platformId];
    if (!platform || !(entry.count > 0)) continue;
    const list = groups[platform.type] || (groups[platform.type] = []);
    const existing = list.find(g => g.platformId === entry.platformId);
    if (existing) existing.count += entry.count;
    else list.push({ platformId: entry.platformId, count: entry.count });
  }
  return groups;
}

/**
 * Is this deployed entry excluded for the given type and platform?
 * `excluded[type]` may be an array of def ids (all platforms of the type)
 * or an object keyed by platform id (per platform).
 */
function isExcluded(excludedByThreatType, threatType, platformId, defId) {
  const ex = excludedByThreatType?.[threatType];
  if (!ex) return false;
  if (Array.isArray(ex)) return ex.includes(defId);
  const forAll  = Array.isArray(ex['*']) && ex['*'].includes(defId);
  const forPlat = Array.isArray(ex[platformId]) && ex[platformId].includes(defId);
  return forAll || forPlat;
}

/**
 * Run a full layered-defence simulation.
 *
 * @param {Array}  attackManifest         [{platformId, count}]
 * @param {Array}  defenses               deployed entries: { id, system, quantity, notes?,
 *                                        locationName?, locationCountry?, restrictToThreatTypes? }
 * @param {Object} [initialMagazineState] { defId: interceptorsRemaining }; a missing key = full
 * @param {Object} [excludedByThreatType] { type: [defId] } or { type: { platformId|'*': [defId] } }
 * @param {Object} config                 { pkTable, doctrine, defenseCatalog, platformCatalog,
 *                                        rng = Math.random, models = ENGAGEMENT_MODELS }
 * @returns {{ totalIn, totalOut, initialThreats, finalThreats, byThreatType }}
 *
 * Processing order: doctrine.typeOrder → platforms of that type in manifest
 * order → doctrine.engage[type] → every deployed entry of that system.
 * Magazine depletion persists across platforms, types, and (through
 * initialMagazineState) successive runs.
 */
function runSimulationCore(attackManifest, defenses, initialMagazineState = {}, excludedByThreatType = {}, config = {}) {
  const {
    pkTable, doctrine, defenseCatalog, platformCatalog,
    rng    = Math.random,
    models = (typeof ENGAGEMENT_MODELS !== 'undefined' ? ENGAGEMENT_MODELS : null)
  } = config;
  if (!pkTable || !doctrine || !defenseCatalog || !platformCatalog) {
    throw new Error('runSimulationCore: config needs pkTable, doctrine, defenseCatalog, platformCatalog');
  }
  if (!models) throw new Error('runSimulationCore: config.models (ENGAGEMENT_MODELS) is required');

  const groups = groupManifest(attackManifest, platformCatalog);

  // Deployed entries keyed by def.id, with their running magazine.
  const deployed = {};
  for (const def of defenses) {
    const catalog = defenseCatalog[def.system];
    if (!catalog) continue;
    const fullMag = (catalog.magazinePerBattery || 0) * def.quantity;
    deployed[def.id] = { def, magazineRemaining: initialMagazineState[def.id] ?? fullMag };
  }

  const byThreatType = [];
  let totalIn = 0, totalOut = 0;

  for (const threatType of doctrine.typeOrder) {
    const platformGroups = groups[threatType];
    if (!platformGroups || platformGroups.length === 0) continue;

    // Caps (laser kills, gun bursts, patrol full-Pk count) apply per threat
    // type per run: give every battery a fresh pass-state object here.
    for (const e of Object.values(deployed)) e.pass = {};

    const typeBlock = { threatType, initialCount: 0, finalCount: 0, platforms: [] };

    for (const group of platformGroups) {
      const platform = platformCatalog[group.platformId];
      let remaining  = group.count;
      typeBlock.initialCount += group.count;
      totalIn += group.count;
      const engagements = [];

      for (const systemId of doctrine.engage[threatType] || []) {
        if (remaining <= 0) break;
        const catalog = defenseCatalog[systemId];
        if (!catalog) continue;

        const entries = Object.values(deployed).filter(e =>
          e.def.system === systemId &&
          !isExcluded(excludedByThreatType, threatType, group.platformId, e.def.id) &&
          (!e.def.restrictToThreatTypes || e.def.restrictToThreatTypes.includes(threatType))
        );
        if (entries.length === 0) continue;

        const cell   = pkCell(pkTable, systemId, group.platformId);
        const model  = models[catalog.engagement?.model || 'kinetic'];
        const params = catalog.engagement || {};
        const baseRecord = e => ({
          defId:           e.def.id,
          systemId,
          systemName:      catalog.name || systemId,
          quantity:        e.def.quantity,
          notes:           e.def.notes || '',
          locationName:    e.def.locationName    || '',
          locationCountry: e.def.locationCountry || '',
          threatType,
          platformId:      group.platformId,
          platformName:    platform.name,
          model:           catalog.engagement?.model || 'kinetic',
          modelParams:     params,
          cellShots:       cell.shots
        });

        // A cell with pk 0 means the system cannot engage this platform.
        if (!model || cell.pk <= 0) {
          for (const e of entries) {
            engagements.push({
              ...baseRecord(e),
              threatsIn: remaining, killed: 0, survived: remaining,
              pkShot: 0, pkTier: null, tierMultiplier: 1, pk: 0,
              shotsPerEngagement: 0, shotsPerEngagementTier: null,
              magazineAtStart: e.magazineRemaining, interceptorsUsed: 0,
              magazineRemaining: e.magazineRemaining,
              note: 'Cannot engage'
            });
          }
          continue;
        }

        // Resolve every entry first so each battery gets independent draws
        // before any kill is applied.
        const resolved = entries.map(e => {
          const { tier, mult } = rollTier(pkTable.tiers, rng);
          const pkShot = Math.min(1, cell.pk * mult);
          const ctx = { pkShot, shots: cell.shots, params, threatType, remaining, pass: e.pass, rng };
          const r = model.resolve(ctx);
          return { e, ctx, tier, mult, pkShot, ...r };
        });

        for (const { e, ctx, tier, mult, pkShot, P, shotsPerThreat, shotsTier } of resolved) {
          if (remaining <= 0) break;
          const magazineBefore = e.magazineRemaining;
          const result = applyEngagement(remaining, P, magazineBefore, shotsPerThreat);
          e.magazineRemaining = result.magazineRemaining;
          model.afterEngagement(ctx, result);

          engagements.push({
            ...baseRecord(e),
            threatsIn:              remaining,
            killed:                 result.killed,
            survived:               result.survived,
            pkShot,
            pkTier:                 tier,
            tierMultiplier:         mult,
            pk:                     P,
            shotsPerEngagement:     shotsPerThreat,
            shotsPerEngagementTier: shotsTier,
            magazineAtStart:        magazineBefore,
            interceptorsUsed:       magazineBefore - e.magazineRemaining,
            magazineRemaining:      e.magazineRemaining,
            note:                   result.note
          });
          remaining = result.survived;
        }
      }

      typeBlock.finalCount += remaining;
      totalOut += remaining;
      typeBlock.platforms.push({
        platformId:   group.platformId,
        platformName: platform.name,
        initialCount: group.count,
        finalCount:   remaining,
        engagements
      });
    }

    byThreatType.push(typeBlock);
  }

  const initialThreats = byThreatType.map(b => ({ type: b.threatType, count: b.initialCount }));
  const finalThreats   = byThreatType.filter(b => b.finalCount > 0).map(b => ({ type: b.threatType, count: b.finalCount }));
  return { totalIn, totalOut, initialThreats, finalThreats, byThreatType };
}

/** Flat list of every engagement record in processing order. */
function allEngagements(results) {
  const out = [];
  for (const t of results?.byThreatType || []) for (const p of t.platforms || []) for (const e of p.engagements || []) out.push(e);
  return out;
}

// Node.js export shim — a no-op in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    THREAT_TYPES,
    inferTier,
    buildDefenseCatalog,
    buildPlatformCatalog,
    normalizeDoctrine,
    systemThreatTypes,
    normalizePkTable,
    pkCell,
    rollTier,
    applyEngagement,
    groupManifest,
    runSimulationCore,
    allEngagements
  };
}
