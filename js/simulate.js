/**
 * simulate.js — Air defense simulation engine
 *
 * This file contains only the simulation machinery:
 *   • applyEngagement()     core engagement math
 *   • ENGAGEMENT_PRIORITY   system ordering
 *   • THREAT_PRIORITY       threat-type processing order
 *   • runSimulation()       orchestrator
 *
 * Platform-specific logic (Pk values, shots-per-engagement, random draws)
 * lives entirely in js/engagement.js. Edit that file to configure and
 * customise how each system performs.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core engagement helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply one system's engagement against a single threat type.
 *
 * @param {number} count    - number of incoming threats of this type
 * @param {number} pk       - probability of kill per engagement attempt (0–1)
 * @param {number} magazine - interceptors currently available
 * @param {number} [shots=2] - interceptors expended per target attempt
 * @returns {{ killed, survived, magazineRemaining, isPlaceholder, note }}
 *
 * Magazine behaviour:
 *   pk > 0  → magazine is consumed normally (shots × min(count, floor(mag/shots)))
 *   pk = 0  → treated as a placeholder; magazine is NOT consumed so that
 *              downstream systems are not incorrectly starved of interceptors
 *              during the configuration phase.
 *   shots = 0 → directed-energy / EW with effectively unlimited shots;
 *               magazine counter is not decremented.
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

  // Placeholder — Pk has not been set yet
  if (pk === 0) {
    return {
      killed: 0, survived: count,
      magazineRemaining: magazine,      // preserved so later systems are unaffected
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
  'f15e_patrol',         // 1  — F-15E patrol (AIM-120 AMRAAM, BVR), highest priority
  'fa18_patrol',         // 2  — F/A-18 patrol (AIM-9X Sidewinder)
  'aegis_sm3',           // 3  — longest-range BMD (SM-3), outermost layer
  'thaad',               // 4  — upper-tier area defense
  'arrow',               // 5  — Arrow 2/3 exo/endo intercept
  'patriot',             // 6  — PAC-3 MSE area defense
  'davids_sling',        // 7  — medium-long range
  'cheongung2',          // 8  — medium range
  'aegis_sm2',           // 9  — SM-2 area defense
  'aegis_sm6',           // 10 — SM-6 dual-role
  'iron_dome',           // 11 — short-range saturation defense
  'nasams',              // 12 — SHORAD/MSHORAD
  'ifpc2',               // 13 — indirect fire protection
  'pantsirs1e',          // 14 — gun-missile combination
  'fslids',              // 15 — drone-only point defense
  'merops',              // 16 — electronic attack suite
  'iron_beam',           // 17 — high-energy laser (directed energy)
  'containerized_laser', // 18 — containerized high-energy laser
  'm_shorad',            // 19 — short-range kinetic (Stinger/Hellfire)
  'phalanx_cram',        // 20 — close-in gun (C-RAM)
  'high_powered_microwave', // 21 — HPM directed energy
  'tactical_jammer',        // 22 — RF jamming, innermost layer
];

// ─────────────────────────────────────────────────────────────────────────────
// THREAT_PRIORITY
// The full defensive stack is applied once for each threat type, in this
// order. Magazine consumed against earlier threat types carries over.
// ─────────────────────────────────────────────────────────────────────────────

const THREAT_PRIORITY = ['ballistic_missile', 'cruise_missile', 'drone'];

// ─────────────────────────────────────────────────────────────────────────────
// Main simulation orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a full layered-defence simulation, processing each platform in the
 * attack manifest independently so that engagement functions receive the
 * specific platformId and can apply per-platform Pk values.
 *
 * @param {Array<{platformId:string, count:number}>} attackManifest
 * @param {Array<{id:string, system:string, quantity:number, notes:string}>} defenses
 * @param {Object} [initialMagazineState={}]   Keyed by def.id.
 * @param {Object} [excludedByThreatType={}]   { [threatType]: defId[] } — systems
 *   to skip for a specific threat type (used by post-sim disengage overrides).
 *
 * @returns {{ totalIn, totalOut, initialThreats, finalThreats, byThreatType }}
 *
 * byThreatType: Array<{
 *   threatType:   string,
 *   initialCount: number,      // sum across all platforms of this type
 *   finalCount:   number,
 *   platforms: Array<{
 *     platformId:   string,
 *     platformName: string,
 *     initialCount: number,
 *     finalCount:   number,
 *     engagements:  Array<{
 *       defId, systemId, systemName, quantity, notes,
 *       threatType, platformId, platformName,
 *       threatsIn, killed, survived,
 *       pk, pkTier, pkIsFixed,
 *       shotsPerEngagement, shotsPerEngagementTier,
 *       magazineAtStart, magazineRemaining,
 *       interceptorsUsed, isPlaceholder, note
 *     }>
 *   }>
 * }>
 */
function runSimulation(attackManifest, defenses, initialMagazineState = {}, excludedByThreatType = {}) {

  // ── Sort manifest by THREAT_PRIORITY so upper-tier magazine is consumed
  //    correctly before lower-tier engagements. ──────────────────────────────
  const threatOrder = Object.fromEntries(THREAT_PRIORITY.map((t, i) => [t, i]));
  const sortedManifest = [...attackManifest]
    .filter(entry => PLATFORM_CATALOG[entry.platformId])
    .sort((a, b) => {
      const ta = PLATFORM_CATALOG[a.platformId].type;
      const tb = PLATFORM_CATALOG[b.platformId].type;
      return (threatOrder[ta] ?? 99) - (threatOrder[tb] ?? 99);
    });

  // ── Index deployed defenses by def.id ────────────────────────────────────
  const deployed = {};
  for (const def of defenses) {
    const catalog = DEFENSE_CATALOG[def.system];
    if (!catalog) continue;
    const fullMag = (catalog.magazinePerBattery || 0) * def.quantity;
    deployed[def.id] = {
      def,
      magazineRemaining: initialMagazineState[def.id] ?? fullMag
    };
  }

  // ── Process each platform through the full defensive stack ───────────────
  // Magazine carries over across all platforms (in sorted order).
  const byThreatTypeMap = {};
  let totalIn  = 0;
  let totalOut = 0;

  for (const manifestEntry of sortedManifest) {
    const platform     = PLATFORM_CATALOG[manifestEntry.platformId];
    const threatType   = platform.type;
    const platformId   = manifestEntry.platformId;
    const platformName = platform.name || platformId;
    const initialCount = manifestEntry.count || 0;

    if (initialCount === 0) continue;

    if (!byThreatTypeMap[threatType]) {
      byThreatTypeMap[threatType] = { threatType, initialCount: 0, finalCount: 0, platforms: [] };
    }

    const excludedIds = new Set(excludedByThreatType[threatType] || []);
    totalIn += initialCount;
    let remaining = initialCount;
    const engagements = [];

    for (const systemId of ENGAGEMENT_PRIORITY) {
      if (remaining <= 0) break;

      const entries = Object.values(deployed)
        .filter(e => e.def.system === systemId && !excludedIds.has(e.def.id));
      if (entries.length === 0) continue;

      const engFn = (typeof ENGAGEMENT_FUNCTIONS !== 'undefined')
        ? ENGAGEMENT_FUNCTIONS[systemId]
        : undefined;
      if (!engFn) continue;

      // Draw random parameters for every battery upfront so each gets an
      // independent roll before any kills are applied.
      const entryParams = entries.map(entry => ({
        entry,
        params: engFn(threatType, entry.def.quantity, entry.magazineRemaining, platformId)
      }));

      // Record "Cannot engage" rows.
      for (const { entry, params } of entryParams) {
        if (params !== null) continue;
        engagements.push({
          defId:                  entry.def.id,
          systemId,
          systemName:             DEFENSE_CATALOG[systemId]?.name || systemId,
          quantity:               entry.def.quantity,
          notes:                  entry.def.notes || '',
          threatType,
          platformId,
          platformName,
          threatsIn:              remaining,
          killed:                 0,
          survived:               remaining,
          pk:                     null,
          pkTier:                 null,
          pkIsFixed:              false,
          shotsPerEngagement:     0,
          shotsPerEngagementTier: null,
          magazineRemaining:      entry.magazineRemaining,
          magazineAtStart:        entry.magazineRemaining,
          interceptorsUsed:       0,
          isPlaceholder:          false,
          note:                   'Cannot engage'
        });
      }

      // Engage in order; each battery fires at whatever survived the previous.
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
        entry.magazineRemaining = result.magazineRemaining;

        engagements.push({
          defId:                  entry.def.id,
          systemId,
          systemName:             DEFENSE_CATALOG[systemId]?.name || systemId,
          quantity:               entry.def.quantity,
          notes:                  entry.def.notes || '',
          threatType,
          platformId,
          platformName,
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
          note:                   result.note
        });

        remaining = result.survived;
      }
    }

    totalOut += remaining;
    byThreatTypeMap[threatType].initialCount += initialCount;
    byThreatTypeMap[threatType].finalCount   += remaining;
    byThreatTypeMap[threatType].platforms.push({
      platformId, platformName, initialCount, finalCount: remaining, engagements
    });
  }

  // ── Emit results in THREAT_PRIORITY order ────────────────────────────────
  const byThreatType = THREAT_PRIORITY
    .filter(t => byThreatTypeMap[t])
    .map(t => byThreatTypeMap[t]);

  const initialThreats = byThreatType.map(b => ({ type: b.threatType, count: b.initialCount }));
  const finalThreats   = byThreatType
    .filter(b => b.finalCount > 0)
    .map(b =>   ({ type: b.threatType, count: b.finalCount }));

  return { totalIn, totalOut, initialThreats, finalThreats, byThreatType };
}
