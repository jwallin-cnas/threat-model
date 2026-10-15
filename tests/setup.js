/**
 * tests/setup.js — Shared test utilities
 *
 * Loads js/engagement-models.js and js/engine.js by executing their source
 * with an explicit `module` / `exports` scope via new Function(). This
 * bypasses Vitest's Vite transform (which strips the `module` global and
 * breaks the CommonJS shim) while running the exact bytes the browser loads.
 */

import { readFileSync }  from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

function loadBrowserScript(relPath, globals = {}) {
  const code  = readFileSync(join(ROOT, relPath), 'utf8');
  const mod   = { exports: {} };
  const names = Object.keys(globals);
  // eslint-disable-next-line no-new-func
  const fn    = new Function('module', 'exports', ...names, code);
  fn(mod, mod.exports, ...names.map(n => globals[n]));
  return mod.exports;
}

const _models = loadBrowserScript('js/engagement-models.js');
export const { ENGAGEMENT_MODELS } = _models;

const _engine = loadBrowserScript('js/engine.js', { ENGAGEMENT_MODELS });
export const {
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
} = _engine;

// ─────────────────────────────────────────────────────────────────────────────
// Real data
// ─────────────────────────────────────────────────────────────────────────────

export function loadJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

/**
 * Build a full engine config from the project's real data files. Use for
 * integration tests that need real ids and the shipped Pk table / doctrine.
 * `rng` defaults to a constant 0.5 so tier rolls (if any) land on medium.
 */
export function buildRealConfig(overrides = {}) {
  const defenseCatalog  = buildDefenseCatalog(loadJson('data/defenses.json').systems);
  const platformCatalog = buildPlatformCatalog(loadJson('data/attacks.json').systems);
  const { table: pkTable, warnings: pkWarnings }    = normalizePkTable(loadJson('data/pk-table.json'), defenseCatalog, platformCatalog);
  const { doctrine, warnings: doctrineWarnings }    = normalizeDoctrine(loadJson('data/doctrine.json'), defenseCatalog);
  return {
    pkTable, doctrine, defenseCatalog, platformCatalog,
    models: ENGAGEMENT_MODELS,
    rng: () => 0.5,
    _warnings: { pk: pkWarnings, doctrine: doctrineWarnings },
    ...overrides
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock data — small, deterministic, no file dependency
// ─────────────────────────────────────────────────────────────────────────────

export const MOCK_DEFENSE_SYSTEMS = [
  { id: 'sam',   name: 'Mock SAM',   range_km: 100, batteries: 1, armament: { standard_loadout: 100 }, engagement: { model: 'kinetic' } },
  { id: 'bmd',   name: 'Mock BMD',   range_km: 300, batteries: 1, armament: { standard_loadout: 10 },  engagement: { model: 'kinetic', shotRoll: { mrbm: { chance: 0.1, shots: 1.5 } } } },
  { id: 'laser', name: 'Mock Laser', range_km: 5,   batteries: 1, armament: { standard_loadout: 999 }, engagement: { model: 'directed_energy', killCapPerPass: 10 } },
  { id: 'gun',   name: 'Mock Gun',   range_km: 2,   batteries: 1, armament: { standard_loadout: 450 }, engagement: { model: 'gun', burstsPerPass: 1 } },
  { id: 'cap',   name: 'Mock CAP',   range_km: 200, batteries: 1, shared: true, armament: { standard_loadout: 50 }, engagement: { model: 'patrol', cap: 20, pLow: 0.5 } }
];

export const MOCK_PLATFORMS = [
  { id: 'drone_a', name: 'Drone A', type: 'drone',  payload_kg: 40,  range_km: 2000, salvo_sizes: [2, 10, 50] },
  { id: 'drone_b', name: 'Drone B', type: 'drone',  payload_kg: 50,  range_km: 2000, salvo_sizes: [2, 10, 50] },
  { id: 'srbm_a',  name: 'SRBM A',  type: 'srbm',   payload_kg: 450, range_km: 300,  salvo_sizes: [2, 10, 50] },
  { id: 'mrbm_a',  name: 'MRBM A',  type: 'mrbm',   payload_kg: 750, range_km: 1600, salvo_sizes: [2, 10, 50] },
  { id: 'cm_a',    name: 'CM A',    type: 'cruise_missile', payload_kg: 170, range_km: 1000, salvo_sizes: [2, 10, 50] }
];

/** pk 1.0 everywhere the system is allowed, 2 shots; a few deliberate gaps. */
export const MOCK_PK_TABLE = {
  version: '1.0', name: 'mock', tiers: { low: 1, medium: 1, high: 1 },
  cells: {
    sam:   { drone_a: { pk: 1, shots: 2 }, drone_b: { pk: 1, shots: 2 }, srbm_a: { pk: 1, shots: 2 }, mrbm_a: { pk: 0, shots: 0 }, cm_a: { pk: 1, shots: 2 } },
    bmd:   { drone_a: { pk: 0, shots: 0 }, drone_b: { pk: 0, shots: 0 }, srbm_a: { pk: 1, shots: 2 }, mrbm_a: { pk: 1, shots: 1 }, cm_a: { pk: 0, shots: 0 } },
    laser: { drone_a: { pk: 0.3, shots: 0 }, drone_b: { pk: 0.3, shots: 0 }, srbm_a: { pk: 0, shots: 0 }, mrbm_a: { pk: 0, shots: 0 }, cm_a: { pk: 0, shots: 0 } },
    gun:   { drone_a: { pk: 1, shots: 150 }, drone_b: { pk: 1, shots: 150 }, srbm_a: { pk: 0, shots: 0 }, mrbm_a: { pk: 0, shots: 0 }, cm_a: { pk: 0, shots: 0 } },
    cap:   { drone_a: { pk: 1, shots: 1 }, drone_b: { pk: 1, shots: 1 }, srbm_a: { pk: 0, shots: 0 }, mrbm_a: { pk: 0, shots: 0 }, cm_a: { pk: 1, shots: 1 } }
  }
};

export const MOCK_DOCTRINE = {
  version: '1.0', name: 'mock',
  typeOrder: ['mrbm', 'srbm', 'cruise_missile', 'drone_jet', 'drone', 'fpv'],
  engage: {
    mrbm:           ['bmd', 'sam'],
    srbm:           ['bmd', 'sam'],
    cruise_missile: ['cap', 'sam'],
    drone_jet:      [],
    drone:          ['cap', 'sam', 'laser', 'gun'],
    fpv:            []
  }
};

/** Build a mock config; pass overrides for pkTable/doctrine/rng/etc. */
export function buildMockConfig(overrides = {}) {
  const defenseCatalog  = buildDefenseCatalog(MOCK_DEFENSE_SYSTEMS);
  const platformCatalog = buildPlatformCatalog(MOCK_PLATFORMS);
  const { table: pkTable }  = normalizePkTable(overrides.pkTableRaw || MOCK_PK_TABLE, defenseCatalog, platformCatalog);
  const { doctrine }        = normalizeDoctrine(overrides.doctrineRaw || MOCK_DOCTRINE, defenseCatalog);
  const { pkTableRaw, doctrineRaw, ...rest } = overrides;
  return { pkTable, doctrine, defenseCatalog, platformCatalog, models: ENGAGEMENT_MODELS, rng: () => 0.5, ...rest };
}

/** A deployed defense entry. */
export function mkDef(id, system, quantity = 1, opts = {}) {
  return { id, system, quantity, notes: '', ...opts };
}

/** Final magazineRemaining per defId, last write wins (same as the app's extractMagazineState). */
export function extractMag(results) {
  const state = {};
  for (const e of allEngagements(results)) state[e.defId] = e.magazineRemaining;
  return state;
}

/** A deterministic rng that returns the given sequence, then repeats the last value. */
export function seq(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}
