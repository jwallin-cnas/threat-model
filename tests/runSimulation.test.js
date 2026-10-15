/**
 * runSimulation.test.js — runSimulationCore() with mock catalogs, a mock Pk
 * table and a mock doctrine. Deterministic: tiers are 1.0 and rng is fixed.
 */

import { describe, it, expect } from 'vitest';
import {
  runSimulationCore, normalizeDoctrine, normalizePkTable, groupManifest, allEngagements,
  buildMockConfig, MOCK_DOCTRINE, MOCK_PK_TABLE, mkDef, extractMag, seq
} from './setup.js';

const cfg = buildMockConfig();
const run = (manifest, defenses, mag = {}, excluded = {}, config = cfg) =>
  runSimulationCore(manifest, defenses, mag, excluded, config);

// ── Manifest grouping ─────────────────────────────────────────────────────────

describe('groupManifest', () => {
  it('groups by type, keeps manifest order, merges repeats, skips unknowns', () => {
    const g = groupManifest([
      { platformId: 'drone_b', count: 5 },
      { platformId: 'srbm_a',  count: 2 },
      { platformId: 'drone_a', count: 3 },
      { platformId: 'drone_b', count: 1 },
      { platformId: 'nope',    count: 9 }
    ], cfg.platformCatalog);
    expect(g.drone.map(x => [x.platformId, x.count])).toEqual([['drone_b', 6], ['drone_a', 3]]);
    expect(g.srbm).toEqual([{ platformId: 'srbm_a', count: 2 }]);
  });
});

// ── Basic flow ────────────────────────────────────────────────────────────────

describe('runSimulationCore — basic', () => {

  it('kills everything with pk 1 and enough magazine', () => {
    const r = run([{ platformId: 'drone_a', count: 10 }], [mkDef('d1', 'sam')]);
    expect(r.totalIn).toBe(10);
    expect(r.totalOut).toBe(0);
    expect(r.finalThreats).toEqual([]);
  });

  it('shapes results as type → platform → engagements', () => {
    const r = run([{ platformId: 'drone_a', count: 4 }, { platformId: 'drone_b', count: 6 }], [mkDef('d1', 'sam')]);
    expect(r.byThreatType).toHaveLength(1);
    const t = r.byThreatType[0];
    expect(t.threatType).toBe('drone');
    expect(t.initialCount).toBe(10);
    expect(t.platforms.map(p => [p.platformId, p.initialCount, p.finalCount])).toEqual([['drone_a', 4, 0], ['drone_b', 6, 0]]);
    expect(t.platforms[0].engagements[0]).toMatchObject({ defId: 'd1', systemId: 'sam', platformId: 'drone_a', threatsIn: 4, killed: 4, pk: 1, pkShot: 1, shotsPerEngagement: 2, interceptorsUsed: 8 });
  });

  it('passes everything through when nothing is deployed', () => {
    const r = run([{ platformId: 'drone_a', count: 7 }], []);
    expect(r.totalOut).toBe(7);
    expect(r.byThreatType[0].platforms[0].engagements).toEqual([]);
  });

  it('throws without a complete config', () => {
    expect(() => runSimulationCore([], [], {}, {}, { pkTable: cfg.pkTable })).toThrow(/config needs/);
  });
});

// ── Doctrine ──────────────────────────────────────────────────────────────────

describe('runSimulationCore — doctrine', () => {

  it('engages systems in the doctrine order for the type', () => {
    const r = run([{ platformId: 'srbm_a', count: 10 }], [mkDef('s1', 'sam'), mkDef('b1', 'bmd')]);
    const ids = allEngagements(r).map(e => e.systemId);
    expect(ids).toEqual(['bmd', 'sam']);           // bmd first per MOCK_DOCTRINE.srbm
    expect(allEngagements(r)[0].killed).toBe(5);   // bmd: 10 interceptors / 2 shots = 5 engaged
    expect(allEngagements(r)[1].threatsIn).toBe(5);
  });

  it('never engages a system that is not in the type list, even if the Pk cell is positive', () => {
    const doctrineRaw = { ...MOCK_DOCTRINE, engage: { ...MOCK_DOCTRINE.engage, drone: ['laser'] } };
    const r = run([{ platformId: 'drone_a', count: 10 }], [mkDef('d1', 'sam'), mkDef('l1', 'laser')], {}, {}, buildMockConfig({ doctrineRaw }));
    expect(allEngagements(r).map(e => e.systemId)).toEqual(['laser']);
  });

  it('records "Cannot engage" for a listed system whose cell is pk 0', () => {
    // bmd has only 2 interceptors (1 shot each) so 1 MRBM reaches sam.
    const r = run([{ platformId: 'mrbm_a', count: 3 }], [mkDef('s1', 'sam'), mkDef('b1', 'bmd')], { b1: 2 });
    const e = allEngagements(r);
    expect(e.map(x => [x.systemId, x.note])).toEqual([['bmd', null], ['sam', 'Cannot engage']]);
    expect(e[1]).toMatchObject({ threatsIn: 1, killed: 0, survived: 1, interceptorsUsed: 0, pk: 0 });
    expect(r.totalOut).toBe(1);
  });

  it('processes threat types in typeOrder and carries magazine between them', () => {
    // sam has 100 interceptors; 40 srbm × 2 shots use 80, leaving 20 for drones.
    const r = run([{ platformId: 'drone_a', count: 20 }, { platformId: 'srbm_a', count: 40 }], [mkDef('s1', 'sam')]);
    expect(r.byThreatType.map(t => t.threatType)).toEqual(['srbm', 'drone']);
    const drone = r.byThreatType[1].platforms[0].engagements[0];
    expect(drone.magazineAtStart).toBe(20);
    expect(drone.killed).toBe(10);
    expect(r.byThreatType[1].finalCount).toBe(10);
  });

  it('honours a custom typeOrder', () => {
    const doctrineRaw = { ...MOCK_DOCTRINE, typeOrder: ['drone', 'srbm'] };
    const r = run([{ platformId: 'drone_a', count: 20 }, { platformId: 'srbm_a', count: 40 }], [mkDef('s1', 'sam')], {}, {}, buildMockConfig({ doctrineRaw }));
    expect(r.byThreatType.map(t => t.threatType)).toEqual(['drone', 'srbm']);
    expect(r.byThreatType[0].finalCount).toBe(0);    // drones served first now
    expect(r.byThreatType[1].finalCount).toBe(10);   // 60 left / 2 = 30 of 40 srbm killed
  });

  it('skips a type with an empty engage list', () => {
    const doctrineRaw = { ...MOCK_DOCTRINE, engage: { ...MOCK_DOCTRINE.engage, drone: [] } };
    const r = run([{ platformId: 'drone_a', count: 5 }], [mkDef('s1', 'sam')], {}, {}, buildMockConfig({ doctrineRaw }));
    expect(r.totalOut).toBe(5);
    expect(allEngagements(r)).toEqual([]);
  });

  it('ignores a type that is not in typeOrder', () => {
    const doctrineRaw = { ...MOCK_DOCTRINE, typeOrder: ['srbm'] };
    const r = run([{ platformId: 'drone_a', count: 5 }], [mkDef('s1', 'sam')], {}, {}, buildMockConfig({ doctrineRaw }));
    expect(r.totalIn).toBe(0);
    expect(r.byThreatType).toEqual([]);
  });
});

// ── Platforms within a type ───────────────────────────────────────────────────

describe('runSimulationCore — platforms', () => {

  it('engages platforms in manifest order and carries magazine between them', () => {
    // sam: 100 interceptors, 2 shots. drone_b first (manifest order), 60 × 2 = 120 > 100 → 50 killed.
    const r = run([{ platformId: 'drone_b', count: 60 }, { platformId: 'drone_a', count: 10 }], [mkDef('s1', 'sam')]);
    const [b, a] = r.byThreatType[0].platforms;
    expect(b.platformId).toBe('drone_b');
    expect(b.finalCount).toBe(10);
    expect(a.engagements[0].note).toBe('Magazine exhausted');
    expect(a.finalCount).toBe(10);
  });

  it('uses the cell for each platform separately', () => {
    const pkTableRaw = JSON.parse(JSON.stringify(MOCK_PK_TABLE));
    pkTableRaw.cells.sam.drone_b = { pk: 0.5, shots: 1 };
    const r = run([{ platformId: 'drone_a', count: 10 }, { platformId: 'drone_b', count: 10 }], [mkDef('s1', 'sam')], {}, {}, buildMockConfig({ pkTableRaw }));
    const [a, b] = r.byThreatType[0].platforms;
    expect(a.engagements[0]).toMatchObject({ pkShot: 1,   pk: 1,   shotsPerEngagement: 2, killed: 10 });
    expect(b.engagements[0]).toMatchObject({ pkShot: 0.5, pk: 0.5, shotsPerEngagement: 1, killed: 5 });
  });
});

// ── Exclusions and range restrictions ─────────────────────────────────────────

describe('runSimulationCore — exclusions', () => {

  it('excludes a def id for a whole type (array form)', () => {
    const r = run([{ platformId: 'drone_a', count: 10 }], [mkDef('s1', 'sam'), mkDef('s2', 'sam')], {}, { drone: ['s1'] });
    expect(allEngagements(r).map(e => e.defId)).toEqual(['s2']);
  });

  it('excludes a def id for one platform only (object form)', () => {
    const r = run([{ platformId: 'drone_a', count: 4 }, { platformId: 'drone_b', count: 4 }], [mkDef('s1', 'sam')], {}, { drone: { drone_a: ['s1'] } });
    const [a, b] = r.byThreatType[0].platforms;
    expect(a.engagements).toEqual([]);
    expect(b.engagements.map(e => e.defId)).toEqual(['s1']);
  });

  it('supports "*" in the object form for all platforms', () => {
    const r = run([{ platformId: 'drone_a', count: 4 }, { platformId: 'drone_b', count: 4 }], [mkDef('s1', 'sam')], {}, { drone: { '*': ['s1'] } });
    expect(allEngagements(r)).toEqual([]);
  });

  it('skips an entry whose restrictToThreatTypes excludes the type', () => {
    const r = run([{ platformId: 'srbm_a', count: 4 }], [mkDef('s1', 'sam', 1, { restrictToThreatTypes: ['drone'] }), mkDef('s2', 'sam')]);
    expect(allEngagements(r).map(e => e.defId)).toEqual(['s2']);
  });
});

// ── Magazine state ────────────────────────────────────────────────────────────

describe('runSimulationCore — magazine', () => {

  it('starts from initialMagazineState when a key exists, else full', () => {
    const r = run([{ platformId: 'drone_a', count: 10 }], [mkDef('s1', 'sam'), mkDef('s2', 'sam')], { s1: 4 });
    const [e1, e2] = allEngagements(r);
    expect(e1).toMatchObject({ defId: 's1', magazineAtStart: 4, killed: 2, magazineRemaining: 0 });
    expect(e2).toMatchObject({ defId: 's2', magazineAtStart: 100, threatsIn: 8, killed: 8 });
  });

  it('treats an explicit 0 as empty (0-loadout entries)', () => {
    const r = run([{ platformId: 'drone_a', count: 3 }], [mkDef('s1', 'sam')], { s1: 0 });
    expect(allEngagements(r)[0].note).toBe('Magazine exhausted');
  });

  it('scales the full magazine by quantity', () => {
    const r = run([{ platformId: 'drone_a', count: 1 }], [mkDef('s1', 'sam', 3)]);
    expect(allEngagements(r)[0].magazineAtStart).toBe(300);
  });

  it('carries depletion across successive runs through extractMag()', () => {
    const def = [mkDef('s1', 'sam')];
    const r1 = run([{ platformId: 'drone_a', count: 30 }], def);           // uses 60
    const r2 = run([{ platformId: 'drone_a', count: 30 }], def, extractMag(r1));
    expect(allEngagements(r2)[0]).toMatchObject({ magazineAtStart: 40, killed: 20, magazineRemaining: 0 });
    expect(r2.totalOut).toBe(10);
  });

  it('does not change initialMagazineState', () => {
    const mag = { s1: 10 };
    run([{ platformId: 'drone_a', count: 10 }], [mkDef('s1', 'sam')], mag);
    expect(mag).toEqual({ s1: 10 });
  });
});

// ── Models inside the engine ──────────────────────────────────────────────────

describe('runSimulationCore — models', () => {

  it('directed energy caps kills per pass and spends nothing', () => {
    const r = run([{ platformId: 'drone_a', count: 100 }], [mkDef('l1', 'laser')], {}, {}, buildMockConfig({ doctrineRaw: { ...MOCK_DOCTRINE, engage: { ...MOCK_DOCTRINE.engage, drone: ['laser'] } } }));
    expect(allEngagements(r)[0]).toMatchObject({ killed: 10, interceptorsUsed: 0, shotsPerEngagement: 0, model: 'directed_energy' });
  });

  it('gun kills one per pass and spends one burst', () => {
    const r = run([{ platformId: 'drone_a', count: 40 }], [mkDef('g1', 'gun')], {}, {}, buildMockConfig({ doctrineRaw: { ...MOCK_DOCTRINE, engage: { ...MOCK_DOCTRINE.engage, drone: ['gun'] } } }));
    const e = allEngagements(r)[0];
    expect(e.killed).toBe(1);
    expect(e.interceptorsUsed).toBeCloseTo(150);
  });

  it('patrol applies the cap and pLow', () => {
    const r = run([{ platformId: 'drone_a', count: 50 }], [mkDef('shared_cap', 'cap')], {}, {}, buildMockConfig({ doctrineRaw: { ...MOCK_DOCTRINE, engage: { ...MOCK_DOCTRINE.engage, drone: ['cap'] } } }));
    expect(allEngagements(r)[0]).toMatchObject({ killed: 35, interceptorsUsed: 50, model: 'patrol' });
  });

  it('shares a directed-energy kill cap across the platforms of one type', () => {
    const doctrineRaw = { ...MOCK_DOCTRINE, engage: { ...MOCK_DOCTRINE.engage, drone: ['laser'] } };
    const r = run([{ platformId: 'drone_a', count: 30 }, { platformId: 'drone_b', count: 30 }], [mkDef('l1', 'laser')], {}, {}, buildMockConfig({ doctrineRaw }));
    const [a, b] = r.byThreatType[0].platforms;
    expect(a.engagements[0].killed).toBe(9);    // 30 × 0.3 = 9 (under the cap of 10)
    expect(b.engagements[0].killed).toBe(1);    // only 1 left under the cap
    expect(r.totalOut).toBe(50);
  });

  it('shares the gun bursts across the platforms of one type', () => {
    const doctrineRaw = { ...MOCK_DOCTRINE, engage: { ...MOCK_DOCTRINE.engage, drone: ['gun'] } };
    const r = run([{ platformId: 'drone_a', count: 20 }, { platformId: 'drone_b', count: 20 }], [mkDef('g1', 'gun')], {}, {}, buildMockConfig({ doctrineRaw }));
    const [a, b] = r.byThreatType[0].platforms;
    expect(a.engagements[0].killed).toBe(1);
    expect(a.engagements[0].interceptorsUsed).toBeCloseTo(150);
    expect(b.engagements[0].killed).toBe(0);
    expect(b.engagements[0].interceptorsUsed).toBeCloseTo(0);
  });

  it('shares the patrol cap across the platforms of one type', () => {
    const doctrineRaw = { ...MOCK_DOCTRINE, engage: { ...MOCK_DOCTRINE.engage, drone: ['cap'] } };
    // cap 20 at pk 1, pLow 0.5: 15 of drone_a at full, then 5 of drone_b at full and 15 at half.
    const r = run([{ platformId: 'drone_a', count: 15 }, { platformId: 'drone_b', count: 20 }], [mkDef('shared_cap', 'cap')], {}, {}, buildMockConfig({ doctrineRaw }));
    const [a, b] = r.byThreatType[0].platforms;
    expect(a.engagements[0].killed).toBe(15);
    expect(b.engagements[0].killed).toBe(13);   // 5 + 7.5 → 12.5 → 13 (round half up)
  });

  it('resets caps for each threat type', () => {
    const doctrineRaw = { ...MOCK_DOCTRINE, engage: { ...MOCK_DOCTRINE.engage, drone: ['cap'], cruise_missile: ['cap'] } };
    const r = run([{ platformId: 'cm_a', count: 20 }, { platformId: 'drone_a', count: 20 }], [mkDef('shared_cap', 'cap')], {}, {}, buildMockConfig({ doctrineRaw }));
    for (const t of r.byThreatType) expect(t.platforms[0].engagements[0].killed).toBe(20);
  });

  it('applies the THAAD-style shot roll per entry with independent draws', () => {
    // Two bmd entries; rng sequence: first entry rolls 0.05 (elevated), second 0.5 (standard).
    // b1 starts with 1.5 interceptors so at 1.5 shots it engages exactly 1 and b2 sees the other.
    const config = buildMockConfig({ rng: seq([0.05, 0.5]) });
    const r = run([{ platformId: 'mrbm_a', count: 2 }], [mkDef('b1', 'bmd'), mkDef('b2', 'bmd')], { b1: 1.5 }, {}, config);
    const [e1, e2] = allEngagements(r);
    expect(e1).toMatchObject({ shotsPerEngagement: 1.5, shotsPerEngagementTier: 'elevated', killed: 1, interceptorsUsed: 1.5 });
    expect(e2).toMatchObject({ shotsPerEngagement: 1,   shotsPerEngagementTier: 'standard', threatsIn: 1, killed: 1 });
  });
});

// ── Tier multipliers ──────────────────────────────────────────────────────────

describe('runSimulationCore — tiers', () => {

  it('scales pk by the rolled tier and records it', () => {
    const pkTableRaw = JSON.parse(JSON.stringify(MOCK_PK_TABLE));
    pkTableRaw.tiers = { low: 0.5, medium: 1, high: 1.5 };
    pkTableRaw.cells.sam.drone_a = { pk: 0.5, shots: 1 };
    const config = buildMockConfig({ pkTableRaw, rng: seq([0.1]) });   // low
    const r = run([{ platformId: 'drone_a', count: 10 }], [mkDef('s1', 'sam')], {}, {}, config);
    expect(allEngagements(r)[0]).toMatchObject({ pkTier: 'low', tierMultiplier: 0.5, pkShot: 0.25, pk: 0.25, killed: 3 });
  });

  it('caps the scaled pk at 1', () => {
    const pkTableRaw = JSON.parse(JSON.stringify(MOCK_PK_TABLE));
    pkTableRaw.tiers = { low: 0.5, medium: 1, high: 1.5 };
    pkTableRaw.cells.sam.drone_a = { pk: 0.9, shots: 1 };
    const config = buildMockConfig({ pkTableRaw, rng: seq([0.9]) });   // high
    expect(allEngagements(run([{ platformId: 'drone_a', count: 10 }], [mkDef('s1', 'sam')], {}, {}, config))[0].pkShot).toBe(1);
  });

  it('consumes no rng at all when tiers are 1 and no shot roll applies', () => {
    let calls = 0;
    const config = buildMockConfig({ rng: () => { calls++; return 0.5; } });
    run([{ platformId: 'drone_a', count: 10 }, { platformId: 'srbm_a', count: 3 }], [mkDef('s1', 'sam')], {}, {}, config);
    expect(calls).toBe(0);
  });
});

// ── Normalisers ───────────────────────────────────────────────────────────────

describe('normalizeDoctrine / normalizePkTable', () => {

  it('drops unknown systems and types with warnings and fills missing lists', () => {
    const { doctrine, warnings } = normalizeDoctrine({ typeOrder: ['drone', 'bogus', 'drone'], engage: { drone: ['sam', 'nope', 'sam'], fpv: ['sam'] } }, cfg.defenseCatalog);
    expect(doctrine.typeOrder).toEqual(['drone']);
    expect(doctrine.engage).toEqual({ drone: ['sam'] });
    expect(warnings.some(w => /bogus/.test(w))).toBe(true);
    expect(warnings.some(w => /nope/.test(w))).toBe(true);
    expect(warnings.some(w => /Duplicate/.test(w))).toBe(true);
    expect(warnings.some(w => /engage\.fpv/.test(w))).toBe(true);
  });

  it('makes the table dense, clamps values, defaults tiers, warns on unknown ids', () => {
    const { table, warnings } = normalizePkTable({ cells: { sam: { drone_a: { pk: 1.4, shots: -1 } }, bogus: {} } }, cfg.defenseCatalog, cfg.platformCatalog);
    expect(table.tiers).toEqual({ low: 1, medium: 1, high: 1 });
    expect(table.cells.sam.drone_a).toEqual({ pk: 1, shots: 0 });
    expect(table.cells.sam.drone_b).toEqual({ pk: 0, shots: 0 });
    expect(Object.keys(table.cells).sort()).toEqual(['bmd', 'cap', 'gun', 'laser', 'sam']);
    expect(warnings.some(w => /bogus/.test(w))).toBe(true);
    expect(warnings.some(w => /clamped/.test(w))).toBe(true);
  });
});
