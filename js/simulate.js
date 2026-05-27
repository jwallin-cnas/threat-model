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
 * Run a full layered-defence simulation.
 *
 * @param {Array<{platformId:string, count:number}>} attackManifest
 * @param {Array<{id:string, system:string, quantity:number, notes:string}>} defenses
 *   Each entry must have a unique `id`. Per-target defenses and emplacement-
 *   derived defenses are passed together; the caller is responsible for
 *   building the combined list.
 * @param {Object} [initialMagazineState={}]
 *   Keyed by def.id (not system type). Allows the caller to pass persisted
 *   magazine levels from prior simulation runs.
 * @returns {{ totalIn, totalOut, initialThreats, finalThreats, byThreatType }}
 *
 * byThreatType: Array<{
 *   threatType:   string,
 *   initialCount: number,
 *   finalCount:   number,
 *   engagements:  Array<{
 *     defId, systemId, systemName, quantity, notes,
 *     threatType, threatsIn, killed, survived,
 *     pk, shotsPerEngagement, magazineAtStart, magazineRemaining,
 *     interceptorsUsed, isPlaceholder, note
 *   }>
 * }>
 */
function runSimulation(attackManifest, defenses, initialMagazineState = {}, excludedByThreatType = {}) {

  // ── Aggregate attack by threat type ──────────────────────────────────────
  const threatCounts = {};
  for (const entry of attackManifest) {
    const platform = PLATFORM_CATALOG[entry.platformId];
    if (!platform) continue;
    threatCounts[platform.type] = (threatCounts[platform.type] || 0) + entry.count;
  }

  // ── Index deployed defenses by def.id ────────────────────────────────────
  // Keyed by def.id (not def.system) so multiple instances of the same system
  // type coexist — e.g., a per-target Patriot battery plus an emplacement-
  // based Patriot covering the same target both operate independently with
  // their own magazines.
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

      // Find ALL deployed entries for this system type, minus any excluded for
      // this specific threat type (per-threat-type disengage overrides), and
      // minus cross-target batteries whose per-type range cap excludes this threat.
      const entries = Object.values(deployed)
        .filter(e => e.def.system === systemId && !excludedIds.has(e.def.id))
        .filter(e => {
          // restrictToThreatTypes is set on cross-target defenses when a system's
          // per-threat-type range (threat_range_overrides in the catalog) is
          // shorter than its general range_km for some types.
          // null → no restriction; the battery engages all applicable threat types.
          const r = e.def.restrictToThreatTypes;
          return !r || r.includes(threatType);
        });
      if (entries.length === 0) continue;

      const engFn = (typeof ENGAGEMENT_FUNCTIONS !== 'undefined')
        ? ENGAGEMENT_FUNCTIONS[systemId]
        : undefined;
      if (!engFn) continue;

      // Evaluate engagement parameters for each entry upfront so that each
      // battery gets an independent Math.random() draw before any killing occurs.
      const entryParams = entries.map(entry => ({
        entry,
        params: engFn(threatType, entry.def.quantity, entry.magazineRemaining)
      }));

      // Record "Cannot engage" for entries whose engFn returned null.
      for (const { entry, params } of entryParams) {
        if (params !== null) continue;
        engagements.push({
          defId:              entry.def.id,
          systemId,
          systemName:         DEFENSE_CATALOG[systemId]?.name || systemId,
          quantity:           entry.def.quantity,
          notes:              entry.def.notes || '',
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

      // Process entries that can engage, in order.
      // Each fires at whatever survived the previous entry's salvo.
      for (const { entry, params } of entryParams) {
        if (!params) continue;
        if (remaining <= 0) break;

        const pk                   = params.pk                    ?? 0;
        const shots                = params.shotsPerEngagement    ?? 2;
        const pkTier               = params.pkTier                ?? null;
        const pkIsFixed            = params.pkIsFixed             ?? false;
        const shotsPerEngageTier   = params.shotsPerEngagementTier ?? null;

        const magazineBefore    = entry.magazineRemaining;
        const result            = applyEngagement(remaining, pk, magazineBefore, shots);

        // Persist magazine depletion — carries across threat-type passes and
        // across successive simulation runs (via initialMagazineState).
        entry.magazineRemaining = result.magazineRemaining;

        engagements.push({
          defId:                  entry.def.id,
          systemId,
          systemName:             DEFENSE_CATALOG[systemId]?.name || systemId,
          quantity:               entry.def.quantity,
          notes:                  entry.def.notes || '',
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
          note:                   result.note
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
