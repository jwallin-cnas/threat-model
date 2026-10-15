/**
 * realData.test.js — integration tests on the shipped data files:
 * data/defenses.json, data/attacks.json, data/pk-table.json, data/doctrine.json.
 *
 * These pin the generated defaults to the legacy behaviour they were derived
 * from, so a regenerated or hand-tuned table that changes outcomes is caught.
 */

import { describe, it, expect } from 'vitest';
import { runSimulationCore, allEngagements, buildRealConfig, systemThreatTypes, mkDef, extractMag } from './setup.js';

const cfg = buildRealConfig();

describe('shipped data files', () => {

  it('load with no warnings', () => {
    expect(cfg._warnings.pk).toEqual([]);
    expect(cfg._warnings.doctrine).toEqual([]);
  });

  it('cover every system × platform pair', () => {
    const systems   = Object.keys(cfg.defenseCatalog);
    const platforms = Object.keys(cfg.platformCatalog);
    for (const s of systems) for (const p of platforms) expect(cfg.pkTable.cells[s][p]).toBeDefined();
    expect(systems.length).toBe(24);
    expect(platforms.length).toBe(22);
  });

  it('give VAMPIRE the same Pk row and doctrine slots as IFPC-2, right after it', () => {
    expect(cfg.pkTable.cells.vampire).toEqual(cfg.pkTable.cells.ifpc2);
    for (const type of cfg.doctrine.typeOrder) {
      const list = cfg.doctrine.engage[type];
      const i = list.indexOf('ifpc2');
      if (i >= 0) expect(list[i + 1]).toBe('vampire');
      else        expect(list).not.toContain('vampire');
    }
    expect(cfg.defenseCatalog.vampire).toMatchObject({ range_km: 15, magazinePerBattery: 20, tier: 5 });
  });

  it('place the F-15 patrols in the upper endo-atmospheric tier by explicit override', () => {
    expect(cfg.defenseCatalog.f15e_patrol.tier).toBe(2);
    expect(cfg.defenseCatalog.f15i_patrol.tier).toBe(2);
    expect(cfg.defenseCatalog.fa18_patrol.tier).toBe(2);     // 100 km → tier 2 by range
    expect(cfg.defenseCatalog.thaad.tier).toBe(1);           // 200 km → tier 1 by range
  });

  it('give MEROPS a 10-interceptor loadout', () => {
    expect(cfg.defenseCatalog.merops.magazinePerBattery).toBe(10);
  });

  it('carry the legacy per-engagement values converted to per-shot', () => {
    const c = cfg.pkTable.cells;
    expect(c.patriot.geran_2).toEqual({ pk: 0.4687, shots: 3 });      // 1 − (1 − 0.85)^(1/3)
    expect(c.patriot.fateh_110).toEqual({ pk: 0.6127, shots: 2 });    // 1 − (1 − 0.85)^(1/2)
    expect(c.thaad.fateh_110).toEqual({ pk: 1, shots: 2 });
    expect(c.thaad.ghadr).toEqual({ pk: 1, shots: 1 });
    expect(c.thaad.geran_2).toEqual({ pk: 0, shots: 0 });             // cannot engage
    expect(c.iron_beam.geran_2).toEqual({ pk: 0.3, shots: 0 });
    expect(c.phalanx_cram.geran_2).toEqual({ pk: 1, shots: 150 });
    expect(c.f15e_patrol.geran_2).toEqual({ pk: 1, shots: 1 });
  });

  it('keep the legacy engagement order and capability in the doctrine', () => {
    expect(cfg.doctrine.typeOrder).toEqual(['mrbm', 'srbm', 'cruise_missile', 'drone_jet', 'drone', 'fpv']);
    expect(cfg.doctrine.engage.mrbm).toEqual(['aegis_sm3', 'thaad', 'arrow', 'patriot', 'davids_sling', 'cheongung2', 'aegis_sm6']);
    expect(cfg.doctrine.engage.drone[0]).toBe('f15e_patrol');
    expect(cfg.doctrine.engage.drone).not.toContain('thaad');
    expect(cfg.doctrine.engage.drone).not.toContain('f15i_patrol');   // absent from legacy ENGAGEMENT_PRIORITY
    expect(systemThreatTypes(cfg.doctrine, 'thaad')).toEqual(['mrbm', 'srbm']);
  });

  it('name a model for every system', () => {
    for (const s of Object.values(cfg.defenseCatalog)) expect(['kinetic', 'directed_energy', 'gun', 'patrol']).toContain(s.engagement.model);
    expect(cfg.defenseCatalog.thaad.engagement.shotRoll.mrbm).toEqual({ chance: 0.1, shots: 1.5 });
    expect(cfg.defenseCatalog.iron_beam.engagement.killCapPerPass).toBe(10);
    expect(cfg.defenseCatalog.tactical_jammer.engagement.killCapPerPass).toBe(5);
  });
});

describe('Dubai worked example on shipped data (deterministic tiers)', () => {
  // Same laydown as the control-flow document's example: own Patriot (6 units)
  // plus Jebel Ali Patriot and Cheongung II, Fujairah Patriot, Abu Dhabi THAAD.
  const defenses = [
    mkDef('dubai_d1',          'patriot',    6, { locationName: 'Dubai' }),
    mkDef('jebel_ali_port_d1', 'patriot',    6, { restrictToThreatTypes: ['cruise_missile', 'drone', 'drone_jet', 'fpv'] }),
    mkDef('jebel_ali_port_d2', 'cheongung2', 1),
    mkDef('fujairah_port_d1',  'patriot',    6, { restrictToThreatTypes: ['cruise_missile', 'drone', 'drone_jet', 'fpv'] }),
    mkDef('abu_dhabi_d1',      'thaad',      1)
  ];
  const manifest = [{ platformId: 'fateh_110', count: 10 }, { platformId: 'shahed_136', count: 50 }];

  it('kills all 10 SRBMs with THAAD at 2 shots each', () => {
    const r = runSimulationCore(manifest, defenses, {}, {}, cfg);
    const srbm = r.byThreatType.find(t => t.threatType === 'srbm');
    expect(srbm.finalCount).toBe(0);
    expect(srbm.platforms[0].engagements[0]).toMatchObject({ systemId: 'thaad', killed: 10, interceptorsUsed: 20, magazineRemaining: 28 });
  });

  it('runs the drone pass at the deterministic 0.85 engagement Pk', () => {
    const r = runSimulationCore(manifest, defenses, {}, {}, cfg);
    const drone = r.byThreatType.find(t => t.threatType === 'drone');
    const rows  = drone.platforms[0].engagements.map(e => [e.defId, e.killed, e.magazineRemaining, e.note]);
    expect(rows).toEqual([
      ['dubai_d1',          20, 0,  null],     // 24 engaged × 0.85 = 20.4 → 20
      ['jebel_ali_port_d1', 20, 0,  null],     // 30 in, 24 engaged → 20
      ['fujairah_port_d1',   9, 42, null],     // 10 in, all engaged → 8.5 → 9
      ['jebel_ali_port_d2',  1, 29, null]      // 1 in → 0.85 → 1
    ]);
    expect(drone.finalCount).toBe(0);
    expect(r.totalIn).toBe(60);
    expect(r.totalOut).toBe(0);
  });

  it('THAAD gets a "Cannot engage" row against drones (listed for mrbm/srbm only)', () => {
    const r = runSimulationCore(manifest, defenses, {}, {}, cfg);
    const drone = r.byThreatType.find(t => t.threatType === 'drone');
    expect(drone.platforms[0].engagements.some(e => e.systemId === 'thaad')).toBe(false);
  });

  it('carries magazine into a second run', () => {
    const r1 = runSimulationCore(manifest, defenses, {}, {}, cfg);
    const r2 = runSimulationCore(manifest, defenses, extractMag(r1), {}, cfg);
    const drone = r2.byThreatType.find(t => t.threatType === 'drone');
    expect(drone.platforms[0].engagements[0]).toMatchObject({ defId: 'dubai_d1', note: 'Magazine exhausted' });
    expect(drone.finalCount).toBeGreaterThan(0);
  });
});

describe('shared patrol asset on shipped data', () => {
  it('F-15E kills the first 20 at pk 1 and half of the rest', () => {
    const r = runSimulationCore([{ platformId: 'shahed_136', count: 50 }], [mkDef('shared_f15e_patrol', 'f15e_patrol', 1)], {}, {}, cfg);
    expect(allEngagements(r)[0]).toMatchObject({ systemId: 'f15e_patrol', killed: 35, interceptorsUsed: 50, model: 'patrol' });
  });
});
