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
 * @param {number} count   - number of incoming threats of this type
 * @param {number} pk      - probability of kill per engagement attempt (0–1)
 * @param {number} magazine - interceptors currently available
 * @param {number} [shots=2] - interceptors expended per target attempt
 * @returns {{ killed, survived, magazineRemaining, isPlaceholder, note }}
 *
 * Magazine behaviour:
 *   pk > 0  → magazine is consumed normally (shots × min(count, floor(mag/shots)))
 *   pk = 0  → treated as a placeholder; magazine is NOT consumed so that
 *              downstream systems are not incorrectly starved of interceptors
 *              during the configuration phase.
 */
function applyEngagement(count, pk, magazine, shots = 2) {

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
// current target is skipped automatically. Reorder to change engagement
// sequence across all scenarios.
// ─────────────────────────────────────────────────────────────────────────────

const ENGAGEMENT_PRIORITY = [
  'aegis_sm3',           // 1  — longest-range BMD (SM-3), outermost layer
  'thaad',               // 2  — upper-tier area defense
  'arrow',               // 3  — Arrow 2/3 exo/endo intercept
  'patriot',             // 4  — PAC-3 MSE area defense
  'davids_sling',        // 5  — medium-long range
  'cheongung2',          // 6  — medium range
  'aegis_sm2',           // 7  — SM-2 area defense
  'aegis_sm6',           // 8  — SM-6 dual-role
  'iron_dome',           // 9  — short-range saturation defense
  'nasams',              // 10 — SHORAD/MSHORAD
  'ifpc2',               // 11 — indirect fire protection
  'pantsirs1e',          // 12 — gun-missile combination
  'fslids',              // 13 — drone-only point defense
  'merops',              // 14 — electronic attack suite
  'iron_beam',           // 15 — high-energy laser (directed energy)
  'containerized_laser', // 16 — containerized high-energy laser
  'm_shorad',            // 17 — short-range kinetic (Stinger/Hellfire)
  'phalanx_cram',           // 18 — close-in gun (C-RAM)
  'high_powered_microwave', // 19 — HPM directed energy
  'tactical_jammer',        // 20 — RF jamming, innermost layer
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
 * @param {Array<{system:string, quantity:number, id:string, notes:string}>} defenses
 * @returns {{ totalIn, totalOut, initialThreats, finalThreats, byThreatType }}
 *
 * byThreatType: Array<{
 *   threatType:   string,
 *   initialCount: number,
 *   finalCount:   number,
 *   engagements:  Array<{
 *     systemId, systemName, quantity, notes,
 *     threatType, threatsIn, killed, survived,
 *     pk, shotsPerEngagement, magazineRemaining,
 *     isPlaceholder, note
 *   }>
 * }>
 */
function runSimulation(attackManifest, defenses, initialMagazineState = {}) {

  // ── Aggregate attack by threat type ──────────────────────────────────────
  const threatCounts = {};
  for (const entry of attackManifest) {
    const platform = PLATFORM_CATALOG[entry.platformId];
    if (!platform) continue;
    threatCounts[platform.type] = (threatCounts[platform.type] || 0) + entry.count;
  }

  // ── Index deployed defenses; initialise live magazine per instance ────────
  // If initialMagazineState has a value for this system, start from there
  // (persisting depletion across successive simulation runs). Otherwise start
  // from the full battery loadout — which is the case on first run or after a
  // target / defence change that clears lastSimMagazineState.
  const deployed = {};
  for (const def of defenses) {
    const catalog = DEFENSE_CATALOG[def.system];
    if (!catalog) continue;
    const fullMag = (catalog.magazinePerBattery || 0) * def.quantity;
    deployed[def.system] = {
      def,
      magazineRemaining: initialMagazineState[def.system] ?? fullMag
    };
  }

  // ── Process each threat type through the full stack in priority order ─────
  const byThreatType = [];
  let totalIn  = 0;
  let totalOut = 0;

  for (const threatType of THREAT_PRIORITY) {
    const initialCount = threatCounts[threatType] || 0;
    if (initialCount === 0) continue;

    totalIn += initialCount;
    let remaining = initialCount;
    const engagements = [];

    for (const systemId of ENGAGEMENT_PRIORITY) {
      const entry = deployed[systemId];
      if (!entry) continue;  // system not assigned to this target

      // Ask the engagement function for this system's parameters
      const engFn = (typeof ENGAGEMENT_FUNCTIONS !== 'undefined')
        ? ENGAGEMENT_FUNCTIONS[systemId]
        : undefined;

      if (!engFn) continue;  // no engagement function defined for this system

      const params = engFn(threatType, entry.def.quantity, entry.magazineRemaining);

      // System deployed at target but cannot engage this threat type —
      // record it so the UI can show the gap; no interceptors consumed.
      if (!params) {
        engagements.push({
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
        continue;
      }

      if (remaining <= 0) break;

      const pk    = params.pk    ?? 0;
      const shots = params.shotsPerEngagement ?? 2;

      const magazineBefore    = entry.magazineRemaining;
      const result            = applyEngagement(remaining, pk, magazineBefore, shots);

      // Persist magazine consumption across all threat-type passes
      entry.magazineRemaining = result.magazineRemaining;

      engagements.push({
        systemId,
        systemName:         DEFENSE_CATALOG[systemId]?.name || systemId,
        quantity:           entry.def.quantity,
        notes:              entry.def.notes || '',
        threatType,
        threatsIn:          remaining,
        killed:             result.killed,
        survived:           result.survived,
        pk,
        shotsPerEngagement: shots,
        magazineAtStart:    magazineBefore,
        interceptorsUsed:   magazineBefore - entry.magazineRemaining,
        magazineRemaining:  entry.magazineRemaining,
        isPlaceholder:      result.isPlaceholder,
        note:               result.note
      });

      remaining = result.survived;
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
