/**
 * simulate.js — Browser wrapper for the simulation engine
 *
 * Provides the same runSimulation() interface consumed throughout app.js,
 * delegating to runSimulationCore() in engine.js (loaded first in the browser).
 *
 * applyEngagement(), ENGAGEMENT_PRIORITY, and THREAT_PRIORITY are also defined
 * in engine.js and available as browser globals — no re-declaration needed here.
 *
 * All simulation logic lives in js/engine.js.
 */

/**
 * Run a full layered-defence simulation using the browser's global catalogs.
 *
 * @param {Array}  attackManifest         [{platformId, count}]
 * @param {Array}  defenses               defense entries
 * @param {Object} [initialMagState={}]   { defId: remainingCount }
 * @param {Object} [excluded={}]          { threatType: [defId, ...] }
 * @returns {{ totalIn, totalOut, initialThreats, finalThreats, byThreatType }}
 */
function runSimulation(attackManifest, defenses, initialMagState = {}, excluded = {}) {
  return runSimulationCore(
    attackManifest,
    defenses,
    initialMagState,
    excluded,
    ENGAGEMENT_FUNCTIONS,
    PLATFORM_CATALOG,
    DEFENSE_CATALOG
  );
}
