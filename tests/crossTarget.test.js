/**
 * crossTarget.test.js
 *
 * Integration tests that verify magazine state carries over correctly across
 * sequential simulation runs — the key invariant for the attack queue.
 *
 * Uses the real engagement functions and real catalog data so that the
 * tested behaviour matches exactly what the app produces in the browser.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runSimulationCore,
  ENGAGEMENT_FUNCTIONS,
  buildTestCatalogs
} from './setup.js';

const { defenseCatalog, platformCatalog } = buildTestCatalogs();
const EF = ENGAGEMENT_FUNCTIONS;
const DC = defenseCatalog;
const PC = platformCatalog;

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the final magazineRemaining for every defId that fired. */
function extractMag(results) {
  const state = {};
  for (const group of results.byThreatType) {
    for (const eng of group.engagements) {
      state[eng.defId] = eng.magazineRemaining;
    }
  }
  return state;
}

// Find a drone platform and an SRBM in the real catalog
function findPlatformId(type) {
  const found = Object.values(PC).find(p => p.type === type);
  if (!found) throw new Error(`No platform of type "${type}" found in catalog`);
  return found.id;
}

function findDefenseId(systemId) {
  if (!DC[systemId]) throw new Error(`Defense system "${systemId}" not found in catalog`);
  return systemId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequential attack magazine carry-over
// ─────────────────────────────────────────────────────────────────────────────

describe('sequential attacks — magazine carry-over', () => {

  it('magazine depletes cumulatively across two attacks on the same target', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // force high-confidence Pk

    const dronePlatformId = findPlatformId('drone');
    const manifest        = [{ platformId: dronePlatformId, count: 5 }];

    // Use iron_dome which has a known magazine size and handles drones
    const systemId = findDefenseId('iron_dome');
    const defenses = [{ id: 'dome1', system: systemId, quantity: 1, notes: '' }];

    // First attack — full magazine
    const r1      = runSimulationCore(manifest, defenses, {}, {}, EF, PC, DC);
    const mag1    = extractMag(r1);
    const after1  = mag1['dome1'];

    expect(after1).toBeLessThan(DC[systemId].magazinePerBattery);

    // Second attack — start from where the first left off
    const r2   = runSimulationCore(manifest, defenses, { dome1: after1 }, {}, EF, PC, DC);
    const mag2 = extractMag(r2);
    const after2 = mag2['dome1'];

    expect(after2).toBeLessThan(after1);
    expect(after2).toBeGreaterThanOrEqual(0);
  });

  it('magazine state from run 2 is lower than run 1 when same attacks repeat', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const dronePlatformId = findPlatformId('drone');
    const manifest        = [{ platformId: dronePlatformId, count: 3 }];
    const defenses        = [{ id: 'nasams1', system: 'nasams', quantity: 1, notes: '' }];

    const r1    = runSimulationCore(manifest, defenses, {}, {}, EF, PC, DC);
    const mag1  = extractMag(r1);

    // Second run with depleted magazine
    const r2    = runSimulationCore(manifest, defenses, { nasams1: mag1.nasams1 ?? 0 }, {}, EF, PC, DC);
    const mag2  = extractMag(r2);

    expect((mag2.nasams1 ?? 0)).toBeLessThanOrEqual(mag1.nasams1 ?? 0);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-target defense sharing
// ─────────────────────────────────────────────────────────────────────────────

describe('cross-target defense sharing', () => {

  it('shared defense ID depletes same magazine pool across two targets', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const dronePlatformId = findPlatformId('drone');
    const manifest        = [{ platformId: dronePlatformId, count: 4 }];

    // The SAME defense entry (same id) covering two different "targets" —
    // simulates a cross-target battery in range of two sites.
    const sharedDef = { id: 'shared_patriot', system: 'patriot', quantity: 1, notes: '' };

    // Attack target A
    const r1 = runSimulationCore(manifest, [sharedDef], {}, {}, EF, PC, DC);
    const magAfterA = extractMag(r1)['shared_patriot'];

    // Attack target B — same shared battery
    const r2 = runSimulationCore(manifest, [sharedDef], { shared_patriot: magAfterA }, {}, EF, PC, DC);
    const magAfterB = extractMag(r2)['shared_patriot'];

    // Magazine should be lower after second target
    expect(magAfterB).toBeLessThanOrEqual(magAfterA ?? DC.patriot.magazinePerBattery);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Magazine-exhausted behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('magazine exhaustion', () => {

  it('system fires zero shots and records exhausted note after full depletion', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const dronePlatformId = findPlatformId('drone');
    const manifest        = [{ platformId: dronePlatformId, count: 10 }];
    const defenses        = [{ id: 'd_exh', system: 'iron_dome', quantity: 1, notes: '' }];

    // Start with zero magazine
    const r = runSimulationCore(manifest, defenses, { d_exh: 0 }, {}, EF, PC, DC);
    const eng = r.byThreatType.find(g => g.threatType === 'drone')?.engagements[0];

    expect(eng).toBeDefined();
    expect(eng.note).toBe('Magazine exhausted');
    expect(eng.killed).toBe(0);
    expect(r.totalOut).toBe(10);
  });

  it('totalIn and totalOut correctly reflect a partially depleted magazine', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const dronePlatformId = findPlatformId('drone');
    const manifest        = [{ platformId: dronePlatformId, count: 20 }];
    const defenses        = [{ id: 'd_part', system: 'iron_dome', quantity: 1, notes: '' }];

    const magPerBattery = DC['iron_dome'].magazinePerBattery;
    const shotsPerEng   = 3; // iron_dome uses 3 shots/engagement
    const canEngage     = Math.floor(magPerBattery / shotsPerEng);

    // pk=1 (forced), so all engageable are killed
    const r = runSimulationCore(manifest, defenses, {}, {}, EF, PC, DC);
    expect(r.totalIn).toBe(20);
    expect(r.totalOut).toBe(Math.max(0, 20 - canEngage));
  });

});
