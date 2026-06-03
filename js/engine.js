/**
 * engine.js — Pure air-defence simulation engine
 *
 * All functions receive their dependencies as explicit parameters so this
 * module can run in:
 *   • Browser  — loaded before simulate.js; simulate.js and app.js reference
 *                these functions as browser globals.
 *   • Node.js  — const { ... } = require('./engine.js') for Vitest unit tests.
 *
 * DO NOT reference browser-only globals (document, window, location, etc.)
 * anywhere in this file.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tier helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Infer engagement tier from range_km so defenses sort outermost-first
 * during simulation. Tier 1 = longest range / exo-atmospheric.
 */
function inferTier(range_km) {
  if (range_km >= 200) return 1;
  if (range_km >= 100) return 2;
  if (range_km >= 50)  return 3;
  if (range_km >= 25)  return 4;
  if (range_km >= 10)  return 5;
  return 6;
}

// Local tier-label map — mirrors catalog.js TIER_LABELS.
// Kept here so engine.js is self-contained in Node.js without requiring catalog.js.
const _TIER_LABELS = {
  1: 'Exo-Atmospheric',
  2: 'Upper Endo-Atmospheric',
  3: 'Mid-Range SAM',
  4: 'Short-Range SAM',
  5: 'SHORAD',
  6: 'Close-In Defense'
};

// ─────────────────────────────────────────────────────────────────────────────
// Catalog builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a defense-system catalog from the raw defenses.json `systems` array.
 * Returns a plain object keyed by system id — does NOT mutate any global.
 *
 * @param {Array} systems  — defenses.json `systems` array
 * @returns {Object}  catalog keyed by system.id
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
      effectiveAgainst:     sys.threats || [],
      threatRangeOverrides: sys.threat_range_overrides || {},
      magazinePerBattery:   sys.armament?.standard_loadout || 0,
      description:          `Range: ${sys.range_km} km`
    };
  }
  return catalog;
}

/**
 * Build an attack-platform catalog from the raw attacks.json `systems` array.
 * Returns a plain object keyed by system id — does NOT mutate any global.
 *
 * @param {Array} systems  — attacks.json `systems` array
 * @returns {Object}  catalog keyed by system.id
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
// Core engagement helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply one system's engagement against a single threat type.
 *
 * @param {number} count     - incoming threats of this type
 * @param {number} pk        - probability of kill per engagement attempt (0–1)
 * @param {number} magazine  - interceptors currently available
 * @param {number} [shots=2] - interceptors expended per target attempt
 * @returns {{ killed, survived, magazineRemaining, isPlaceholder, note }}
 *
 * Special cases:
 *   pk = 0    → placeholder; magazine preserved so downstream systems are
 *               not incorrectly starved during the configuration phase.
 *   shots = 0 → directed-energy / EW; magazine counter is not decremented.
 */
function applyEngagement(count, pk, magazine, shots = 2) {

  // Directed-energy / EW — unlimited shots, no magazine tracking
  if (shots === 0) {
    if (pk === 0) {
      return {
        killed: 0, survived: count,
        magazineRemaining: magazine,
        isPlaceholder: true,
        note: 'PLACEHOLDER — Pk not set'
      };
    }
    return {
      killed:            Math.round(count * pk),
      survived:          count - Math.round(count * pk),
      magazineRemaining: magazine,
      isPlaceholder:     false,
      note:              null
    };
  }

  if (magazine <= 0) {
    return {
      killed: 0, survived: count,
      magazineRemaining: 0,
      isPlaceholder: false,
      note: 'Magazine exhausted'
    };
  }

  // Placeholder — Pk has not been set
  if (pk === 0) {
    return {
      killed: 0, survived: count,
      magazineRemaining: magazine,  // preserved so later systems are unaffected
      isPlaceholder: true,
      note: 'PLACEHOLDER — Pk not set'
    };
  }

  const maxEngageable = Math.max(0, Math.floor(magazine / shots));
  const engageable    = Math.min(count, maxEngageable);
  const killed        = Math.round(engageable * pk);
  const shotsUsed     = engageable * shots;

  return {
    killed,
    survived:          count - killed,
    magazineRemaining: magazine - shotsUsed,
    isPlaceholder:     false,
    note:              null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENGAGEMENT_PRIORITY
// Systems are applied in this sequence. Any system not assigned to the
// current target (directly or via an in-range emplacement) is skipped
// automatically. Reorder to change the engagement sequence.
// ─────────────────────────────────────────────────────────────────────────────

const ENGAGEMENT_PRIORITY = [
  'f15e_patrol',           // 1  — F-15E patrol (AIM-120 AMRAAM, BVR), highest priority
  'fa18_patrol',           // 2  — F/A-18 patrol (AIM-9X Sidewinder)
  'aegis_sm3',             // 3  — longest-range BMD (SM-3), outermost layer
  'thaad',                 // 4  — upper-tier area defense
  'arrow',                 // 5  — Arrow 2/3 exo/endo intercept
  'patriot',               // 6  — PAC-3 MSE area defense
  'davids_sling',          // 7  — medium-long range
  'cheongung2',            // 8  — medium range
  'aegis_sm2',             // 9  — SM-2 area defense
  'aegis_sm6',             // 10 — SM-6 dual-role
  'iron_dome',             // 11 — short-range saturation defense
  'nasams',                // 12 — SHORAD/MSHORAD
  'ifpc2',                 // 13 — indirect fire protection
  'pantsirs1e',            // 14 — gun-missile combination
  'fslids',                // 15 — drone-only point defense
  'merops',                // 16 — electronic attack suite
  'iron_beam',             // 17 — high-energy laser (directed energy)
  'containerized_laser',   // 18 — containerized high-energy laser
  'm_shorad',              // 19 — short-range kinetic (Stinger/Hellfire)
  'phalanx_cram',          // 20 — close-in gun (C-RAM)
  'high_powered_microwave', // 21 — HPM directed energy
  'tactical_jammer',        // 22 — RF jamming, innermost layer
];

// ─────────────────────────────────────────────────────────────────────────────
// THREAT_PRIORITY
// The full defensive stack is applied once for each threat type, in this
// order. Magazine consumed against earlier threat types carries over.
// ─────────────────────────────────────────────────────────────────────────────

const THREAT_PRIORITY = ['mrbm', 'srbm', 'cruise_missile', 'drone', 'fpv'];

// ─────────────────────────────────────────────────────────────────────────────
// Core simulation engine (pure — no global state)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a full layered-defence simulation.
 *
 * This is the pure implementation. All inputs are passed explicitly so the
 * function can run in any environment (browser, Node.js, test runner).
 *
 * @param {Array}  attackManifest        [{platformId, count}]
 * @param {Array}  defenses              defense entries, each with .id and .system
 * @param {Object} [initialMagazineState={}]   { defId: remainingCount }
 * @param {Object} [excludedByThreatType={}]   { threatType: [defId, ...] }
 * @param {Object} engagementFunctions   { systemId: fn(threatType, qty, mag) }
 * @param {Object} platformCatalog       { platformId: { type, ... } }
 * @param {Object} defenseCatalog        { systemId: { magazinePerBattery, ... } }
 * @returns {{ totalIn, totalOut, initialThreats, finalThreats, byThreatType }}
 */
function runSimulationCore(
  attackManifest,
  defenses,
  initialMagazineState = {},
  excludedByThreatType = {},
  engagementFunctions,
  platformCatalog,
  defenseCatalog
) {

  // ── Aggregate attack by threat type ──────────────────────────────────────
  const threatCounts = {};
  for (const entry of attackManifest) {
    const platform = platformCatalog[entry.platformId];
    if (!platform) continue;
    threatCounts[platform.type] = (threatCounts[platform.type] || 0) + entry.count;
  }

  // ── Index deployed defenses by def.id ────────────────────────────────────
  const deployed = {};
  for (const def of defenses) {
    const catalog = defenseCatalog[def.system];
    if (!catalog) continue;
    const fullMag = (catalog.magazinePerBattery || 0) * def.quantity;
    deployed[def.id] = {
      def,
      magazineRemaining: initialMagazineState[def.id] ?? fullMag
    };
  }

  // ── Process each threat type through the full stack in priority order ─────
  const byThreatType = [];
  let totalIn  = 0;
  let totalOut = 0;

  for (const threatType of THREAT_PRIORITY) {
    const initialCount = threatCounts[threatType] || 0;
    if (initialCount === 0) continue;

    // defIds explicitly excluded for this threat type (post-sim disengage overrides)
    const excludedIds = new Set(excludedByThreatType[threatType] || []);

    totalIn += initialCount;
    let remaining = initialCount;
    const engagements = [];

    for (const systemId of ENGAGEMENT_PRIORITY) {
      if (remaining <= 0) break;

      // Find ALL deployed entries for this system type, minus excluded and
      // minus cross-target batteries whose per-type range cap excludes this threat.
      const entries = Object.values(deployed)
        .filter(e => e.def.system === systemId && !excludedIds.has(e.def.id))
        .filter(e => {
          const r = e.def.restrictToThreatTypes;
          return !r || r.includes(threatType);
        });
      if (entries.length === 0) continue;

      const engFn = engagementFunctions?.[systemId];
      if (!engFn) continue;

      // Evaluate engagement parameters for each entry upfront so each battery
      // gets an independent Math.random() draw before any killing occurs.
      const entryParams = entries.map(entry => ({
        entry,
        params: engFn(threatType, entry.def.quantity, entry.magazineRemaining, remaining)
      }));

      // Record "Cannot engage" for entries whose engFn returned null
      for (const { entry, params } of entryParams) {
        if (params !== null) continue;
        engagements.push({
          defId:              entry.def.id,
          systemId,
          systemName:         defenseCatalog[systemId]?.name || systemId,
          quantity:           entry.def.quantity,
          notes:              entry.def.notes || '',
          locationName:       entry.def.locationName    || '',
          locationCountry:    entry.def.locationCountry || '',
          threatType,
          threatsIn:          remaining,
          killed:             0,
          survived:           remaining,
          pk:                 null,
          shotsPerEngagement: 0,
          magazineRemaining:  entry.magazineRemaining,
          magazineAtStart:    entry.magazineRemaining,
          interceptorsUsed:   0,
          isPlaceholder:      false,
          note:               'Cannot engage'
        });
      }

      // Process entries that can engage — each fires at whatever survived
      // the previous entry's salvo.
      for (const { entry, params } of entryParams) {
        if (!params) continue;
        if (remaining <= 0) break;

        const pk                 = params.pk                     ?? 0;
        const shots              = params.shotsPerEngagement     ?? 2;
        const pkTier             = params.pkTier                 ?? null;
        const pkIsFixed          = params.pkIsFixed              ?? false;
        const shotsPerEngageTier = params.shotsPerEngagementTier ?? null;

        const magazineBefore    = entry.magazineRemaining;
        const result            = applyEngagement(remaining, pk, magazineBefore, shots);

        // Persist magazine depletion — carries across threat-type passes and
        // across successive simulation runs (via initialMagazineState).
        entry.magazineRemaining = result.magazineRemaining;

        engagements.push({
          defId:                  entry.def.id,
          systemId,
          systemName:             defenseCatalog[systemId]?.name || systemId,
          quantity:               entry.def.quantity,
          notes:                  entry.def.notes || '',
          locationName:           entry.def.locationName    || '',
          locationCountry:        entry.def.locationCountry || '',
          threatType,
          threatsIn:              remaining,
          killed:                 result.killed,
          survived:               result.survived,
          pk,
          pkTier,
          pkIsFixed,
          shotsPerEngagement:     shots,
          shotsPerEngagementTier: shotsPerEngageTier,
          magazineAtStart:        magazineBefore,
          interceptorsUsed:       magazineBefore - entry.magazineRemaining,
          magazineRemaining:      entry.magazineRemaining,
          isPlaceholder:          result.isPlaceholder,
          note:                   result.note,
          tieredPkCap:            params.tieredPkCap ?? null,
          pkLow:                  params.pkLow       ?? null
        });

        remaining = result.survived;
      }
    }

    totalOut += remaining;
    byThreatType.push({ threatType, initialCount, finalCount: remaining, engagements });
  }

  const initialThreats = byThreatType.map(b => ({ type: b.threatType, count: b.initialCount }));
  const finalThreats   = byThreatType
    .filter(b => b.finalCount > 0)
    .map(b =>   ({ type: b.threatType, count: b.finalCount }));

  return { totalIn, totalOut, initialThreats, finalThreats, byThreatType };
}

// ─────────────────────────────────────────────────────────────────────────────
// Node.js export shim
// The `if` guard is a no-op in the browser (where `module` is undefined),
// so none of the functions here need to be duplicated or conditionally defined.
// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    inferTier,
    buildDefenseCatalog,
    buildPlatformCatalog,
    applyEngagement,
    ENGAGEMENT_PRIORITY,
    THREAT_PRIORITY,
    runSimulationCore
  };
}
