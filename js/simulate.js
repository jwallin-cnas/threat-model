/**
 * simulate.js — Browser wrapper for the simulation engine
 *
 * Provides the runSimulation() interface consumed throughout app.js,
 * delegating to runSimulationCore() in engine.js with the browser's global
 * catalogs and the active engagement configuration (Pk table + doctrine)
 * that app.js keeps in activePkTable / activeDoctrine.
 *
 * All simulation logic lives in js/engine.js and js/engagement-models.js.
 */

/** The engine config for the active Pk table and doctrine. */
function engineConfig() {
  return {
    pkTable:         activePkTable,
    doctrine:        activeDoctrine,
    defenseCatalog:  DEFENSE_CATALOG,
    platformCatalog: PLATFORM_CATALOG,
    models:          ENGAGEMENT_MODELS
  };
}

/**
 * Run a full layered-defence simulation using the browser's global catalogs.
 *
 * @param {Array}  attackManifest         [{platformId, count}]
 * @param {Array}  defenses               defense entries
 * @param {Object} [initialMagState={}]   { defId: remainingCount }
 * @param {Object} [excluded={}]          { threatType: [defId] } or { threatType: { platformId: [defId] } }
 * @returns {{ totalIn, totalOut, initialThreats, finalThreats, byThreatType }}
 */
function runSimulation(attackManifest, defenses, initialMagState = {}, excluded = {}) {
  if (!activePkTable || !activeDoctrine) {
    throw new Error('No Pk table or doctrine is loaded.');
  }
  return runSimulationCore(attackManifest, defenses, initialMagState, excluded, engineConfig());
}
