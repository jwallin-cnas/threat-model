/**
 * runSimulation.test.js
 *
 * Unit / integration tests for runSimulationCore().
 * Uses mock catalogs for determinism — no dependency on real data files.
 * Tests that need real platform IDs are in crossTarget.test.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runSimulationCore,
  MOCK_DEFENSE_CATALOG,
  MOCK_PLATFORM_CATALOG,
  MOCK_ENG_FUNCTIONS
} from './setup.js';

const DC  = MOCK_DEFENSE_CATALOG;
const PC  = MOCK_PLATFORM_CATALOG;
const EF  = MOCK_ENG_FUNCTIONS;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mkDef(id, system, quantity = 1, opts = {}) {
  return { id, system, quantity, notes: '', ...opts };
}

function run(manifest, defenses, magState = {}, excluded = {}) {
  return runSimulationCore(manifest, defenses, magState, excluded, EF, PC, DC);
}

// ─────────────────────────────────────────────────────────────────────────────
// Basic functionality
// ─────────────────────────────────────────────────────────────────────────────

describe('runSimulationCore — basic', () => {

  it('kills all threats with pk=1 and sufficient magazine', () => {
    const manifest = [{ platformId: 'mock_drone', count: 10 }];
    const defenses = [mkDef('d1', 'patriot', 1)]; // 100 interceptors
    const r = run(manifest, defenses);
    expect(r.totalIn).toBe(10);
    expect(r.totalOut).toBe(0);
  });

  it('all threats survive when defenses array is empty', () => {
    const manifest = [{ platformId: 'mock_drone', count: 8 }];
    const r = run(manifest, []);
    expect(r.totalIn).toBe(8);
    expect(r.totalOut).toBe(8);
  });

  it('ignores unknown platform IDs — they contribute 0 to totalIn', () => {
    const manifest = [{ platformId: 'nonexistent_uav', count: 5 }];
    const r = run(manifest, [mkDef('d1', 'patriot', 1)]);
    expect(r.totalIn).toBe(0);
    expect(r.totalOut).toBe(0);
  });

  it('ignores unknown defense system IDs', () => {
    const manifest = [{ platformId: 'mock_drone', count: 3 }];
    const r = run(manifest, [mkDef('d1', 'unknown_system', 1)]);
    expect(r.totalIn).toBe(3);
    expect(r.totalOut).toBe(3);  // no defense fired
  });

  it('returns correct initialThreats and finalThreats', () => {
    const manifest = [{ platformId: 'mock_drone', count: 4 }];
    const defenses = [mkDef('d1', 'patriot', 1)];
    const r = run(manifest, defenses);
    expect(r.initialThreats).toEqual([{ type: 'drone', count: 4 }]);
    expect(r.finalThreats).toHaveLength(0); // all killed
  });

  it('finalThreats only includes types with survivors', () => {
    // magazine only holds 4 shots (2 shots × 2 threats)
    const manifest = [{ platformId: 'mock_drone', count: 10 }];
    const defenses = [mkDef('d1', 'patriot', 1)];
    // override mag to 4
    const r = runSimulationCore(manifest, defenses, { d1: 4 }, {}, EF, PC, DC);
    expect(r.finalThreats).toEqual([{ type: 'drone', count: 8 }]);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Magazine accounting
// ─────────────────────────────────────────────────────────────────────────────

describe('runSimulationCore — magazine accounting', () => {

  it('depletes magazine correctly (shots=2)', () => {
    const manifest = [{ platformId: 'mock_drone', count: 5 }];
    const defenses = [mkDef('d1', 'patriot', 1)];
    const r = run(manifest, defenses);
    const eng = r.byThreatType[0].engagements[0];
    expect(eng.interceptorsUsed).toBe(10); // 5 × 2
    expect(eng.magazineRemaining).toBe(90); // 100 - 10
  });

  it('uses initialMagazineState when provided', () => {
    const manifest = [{ platformId: 'mock_drone', count: 3 }];
    const defenses = [mkDef('d1', 'patriot', 1)];
    const r = runSimulationCore(manifest, defenses, { d1: 10 }, {}, EF, PC, DC);
    const eng = r.byThreatType[0].engagements[0];
    expect(eng.magazineAtStart).toBe(10);
    expect(eng.interceptorsUsed).toBe(6); // 3 × 2
    expect(eng.magazineRemaining).toBe(4);
  });

  it('magazine carries over between threat types', () => {
    // Two threat types; patriot handles both drone and srbm
    const manifest = [
      { platformId: 'mock_drone', count: 2 },
      { platformId: 'mock_srbm',  count: 2 }
    ];
    const defenses = [mkDef('d1', 'patriot', 1)]; // 100 interceptors

    // srbm is processed first (THREAT_PRIORITY: mrbm, srbm, ... , drone)
    const r = run(manifest, defenses);

    const srbmGroup  = r.byThreatType.find(g => g.threatType === 'srbm');
    const droneGroup = r.byThreatType.find(g => g.threatType === 'drone');

    expect(srbmGroup).toBeDefined();
    expect(droneGroup).toBeDefined();

    const srbmEng  = srbmGroup.engagements[0];
    const droneEng = droneGroup.engagements[0];

    // srbm fires first (higher priority): 100 → 100 - 4 = 96
    expect(srbmEng.magazineAtStart).toBe(100);
    expect(srbmEng.interceptorsUsed).toBe(4);

    // drone fires after: 96 → 96 - 4 = 92
    expect(droneEng.magazineAtStart).toBe(96);
    expect(droneEng.interceptorsUsed).toBe(4);
  });

  it('magazine-exhausted note appears when depleted mid-battle', () => {
    // Start with only 2 interceptors — enough for 1 target, not 5
    const manifest = [{ platformId: 'mock_drone', count: 5 }];
    const defenses = [mkDef('d1', 'patriot', 1)];
    const r = runSimulationCore(manifest, defenses, { d1: 2 }, {}, EF, PC, DC);
    expect(r.totalOut).toBe(4); // 1 killed (1 × 2 shots), 4 survive
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Exclusion map (disengage overrides)
// ─────────────────────────────────────────────────────────────────────────────

describe('runSimulationCore — exclusion map', () => {

  it('excluded defense does not fire against the specified threat type', () => {
    const manifest = [{ platformId: 'mock_drone', count: 5 }];
    const defenses = [mkDef('d1', 'patriot', 1)];
    const excluded = { drone: ['d1'] };
    const r = runSimulationCore(manifest, defenses, {}, excluded, EF, PC, DC);
    expect(r.totalOut).toBe(5); // defense excluded → all survive
  });

  it('excluding a defense for one threat type does not affect another', () => {
    const manifest = [
      { platformId: 'mock_drone', count: 3 },
      { platformId: 'mock_srbm',  count: 3 }
    ];
    const defenses = [mkDef('d1', 'patriot', 1)];
    const excluded = { drone: ['d1'] }; // only exclude for drones

    const r = runSimulationCore(manifest, defenses, {}, excluded, EF, PC, DC);

    const srbmGroup  = r.byThreatType.find(g => g.threatType === 'srbm');
    const droneGroup = r.byThreatType.find(g => g.threatType === 'drone');

    expect(srbmGroup.finalCount).toBe(0);  // not excluded → all SRBM killed
    expect(droneGroup.finalCount).toBe(3); // excluded → all drones survive
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// restrictToThreatTypes (cross-target range cap)
// ─────────────────────────────────────────────────────────────────────────────

describe('runSimulationCore — restrictToThreatTypes', () => {

  it('defense with restrictToThreatTypes only fires against listed types', () => {
    const manifest = [
      { platformId: 'mock_drone', count: 3 },
      { platformId: 'mock_srbm',  count: 3 }
    ];
    // This battery is only in range for drones, not SRBMs
    const defenses = [mkDef('d1', 'patriot', 1, { restrictToThreatTypes: ['drone'] })];
    const r = run(manifest, defenses);

    const srbmGroup  = r.byThreatType.find(g => g.threatType === 'srbm');
    const droneGroup = r.byThreatType.find(g => g.threatType === 'drone');

    expect(srbmGroup.finalCount).toBe(3);  // system skipped for SRBM
    expect(droneGroup.finalCount).toBe(0); // system fires for drone
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Multiple batteries of the same system
// ─────────────────────────────────────────────────────────────────────────────

describe('runSimulationCore — multiple batteries', () => {

  it('two independent batteries each fire at whatever survives the first', () => {
    // pk=1, shots=2 — each battery should each kill all remaining threats
    const manifest = [{ platformId: 'mock_drone', count: 5 }];
    const defenses = [
      mkDef('d1', 'patriot', 1),
      mkDef('d2', 'patriot', 1)
    ];
    const r = run(manifest, defenses);
    expect(r.totalOut).toBe(0);

    const group = r.byThreatType[0];
    // d1 fires first (pk=1), kills all 5; d2 sees 0 remaining and is skipped
    expect(group.engagements[0].defId).toBe('d1');
    expect(group.engagements[0].killed).toBe(5);
    // d2 never fires because remaining === 0 before it gets a chance
    expect(group.engagements).toHaveLength(1);
  });

  it('second battery engages remaining threats when first runs out of magazine', () => {
    const manifest = [{ platformId: 'mock_drone', count: 10 }];
    const defenses = [
      mkDef('d1', 'patriot', 1),
      mkDef('d2', 'patriot', 1)
    ];
    // Give d1 only 4 interceptors (handles 2 targets)
    const r = runSimulationCore(manifest, defenses, { d1: 4 }, {}, EF, PC, DC);
    expect(r.totalOut).toBe(0); // d2 has full 100 interceptors, mops up the rest
  });

});
