/**
 * tests/setup.js — Shared test utilities
 *
 * Loads engine.js and engagement.js by executing their source with an
 * explicit `module` / `exports` scope via new Function(). This bypasses
 * Vitest's Vite transform (which strips the `module` global and breaks the
 * CJS shim) while still running the exact same source that the browser loads.
 *
 * All exports from this file are re-exported for direct import in test files.
 */

import { readFileSync }  from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// Script loader
// Executes a browser-style JS file in a custom scope that provides `module`
// and `exports`. The CJS shim at the bottom of each file writes its exports
// to module.exports, which we return after execution.
// ─────────────────────────────────────────────────────────────────────────────

function loadBrowserScript(relPath) {
  const code = readFileSync(join(ROOT, relPath), 'utf8');
  const mod  = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn   = new Function('module', 'exports', code);
  fn(mod, mod.exports);
  return mod.exports;
}

// ── Engine functions (pure, no browser globals) ───────────────────────────────
const _engine = loadBrowserScript('js/engine.js');

export const inferTier            = _engine.inferTier;
export const buildDefenseCatalog  = _engine.buildDefenseCatalog;
export const buildPlatformCatalog = _engine.buildPlatformCatalog;
export const applyEngagement      = _engine.applyEngagement;
export const ENGAGEMENT_PRIORITY  = _engine.ENGAGEMENT_PRIORITY;
export const THREAT_PRIORITY      = _engine.THREAT_PRIORITY;
export const runSimulationCore    = _engine.runSimulationCore;

// ── Engagement functions (pure Math.random-based per-system functions) ────────
const _engagement = loadBrowserScript('js/engagement.js');
export const { ENGAGEMENT_FUNCTIONS } = _engagement;

// ─────────────────────────────────────────────────────────────────────────────
// Real catalog builder — loads the actual project JSON data files
// ─────────────────────────────────────────────────────────────────────────────

function _loadJson(filename) {
  return JSON.parse(readFileSync(join(ROOT, 'data', filename), 'utf8'));
}

/**
 * Build defense and platform catalogs from the project's actual data files.
 * Use these for integration-level tests that need real system IDs and Pk values.
 */
export function buildTestCatalogs() {
  const { systems: defenseSystems } = _loadJson('defenses.json');
  const { systems: attackSystems  } = _loadJson('attacks.json');
  return {
    defenseCatalog:  buildDefenseCatalog(defenseSystems),
    platformCatalog: buildPlatformCatalog(attackSystems)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock catalogs — deterministic, no external data dependency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal defense catalog using 'patriot' — a real system ID present in
 * ENGAGEMENT_PRIORITY. The engine iterates ENGAGEMENT_PRIORITY to find
 * deployed batteries, so mock system IDs are silently skipped.
 * magazinePerBattery is set to 100 to give deterministic capacity arithmetic.
 */
export const MOCK_DEFENSE_CATALOG = {
  patriot: {
    id:                   'patriot',
    name:                 'Mock Patriot',
    magazinePerBattery:   100,
    effectiveAgainst:     ['drone', 'srbm', 'cruise_missile'],
    threatRangeOverrides: {}
  }
};

/** Minimal platform catalog: a drone, an SRBM, and a cruise missile. */
export const MOCK_PLATFORM_CATALOG = {
  mock_drone: { id: 'mock_drone', name: 'Mock Drone',         type: 'drone'          },
  mock_srbm:  { id: 'mock_srbm',  name: 'Mock SRBM',          type: 'srbm'           },
  mock_cm:    { id: 'mock_cm',    name: 'Mock Cruise Missile', type: 'cruise_missile' }
};

/**
 * Deterministic engagement functions (pk=1, shots=2) for 'patriot'.
 * Overrides the stochastic real engagement function so tests are reproducible.
 * Tests that need non-trivial Pk should supply their own engFunctions object.
 */
export const MOCK_ENG_FUNCTIONS = {
  patriot: (threatType) => {
    if (!['drone', 'srbm', 'cruise_missile'].includes(threatType)) return null;
    return {
      pk:                     1.0,
      pkTier:                 'high',
      pkIsFixed:              true,
      shotsPerEngagement:     2,
      shotsPerEngagementTier: null
    };
  }
};
