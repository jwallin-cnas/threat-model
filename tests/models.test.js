/**
 * models.test.js — the four engagement models and the tier roll.
 */

import { describe, it, expect } from 'vitest';
import { ENGAGEMENT_MODELS, rollTier, seq } from './setup.js';

const M = ENGAGEMENT_MODELS;

describe('kinetic', () => {

  it('combines independent per-shot kills: 1 − (1 − p)^s', () => {
    expect(M.kinetic.probability({ pkShot: 0.5, shots: 2 })).toBeCloseTo(0.75);
    expect(M.kinetic.probability({ pkShot: 0.4687, shots: 3 })).toBeCloseTo(0.85, 3);
  });

  it('is exact at the ends', () => {
    expect(M.kinetic.probability({ pkShot: 1, shots: 1 })).toBe(1);
    expect(M.kinetic.probability({ pkShot: 0.5, shots: 0 })).toBe(0);
  });

  it('charges the cell shots per threat', () => {
    expect(M.kinetic.shotsPerThreat({ shots: 3 })).toBe(3);
  });

  it('applies a shot roll only for the configured threat type', () => {
    const params = { shotRoll: { mrbm: { chance: 0.1, shots: 1.5 } } };
    const low  = M.kinetic.resolve({ pkShot: 1, shots: 1, params, threatType: 'mrbm', remaining: 5, rng: () => 0.05 });
    const high = M.kinetic.resolve({ pkShot: 1, shots: 1, params, threatType: 'mrbm', remaining: 5, rng: () => 0.5 });
    const srbm = M.kinetic.resolve({ pkShot: 1, shots: 2, params, threatType: 'srbm', remaining: 5, rng: () => 0.05 });
    expect(low).toEqual({ P: 1, shotsPerThreat: 1.5, shotsTier: 'elevated' });
    expect(high).toEqual({ P: 1, shotsPerThreat: 1, shotsTier: 'standard' });
    expect(srbm).toEqual({ P: 1, shotsPerThreat: 2, shotsTier: null });
  });

  it('does not consume rng when there is no shot roll', () => {
    let calls = 0;
    M.kinetic.resolve({ pkShot: 0.5, shots: 2, params: {}, threatType: 'drone', remaining: 5, rng: () => { calls++; return 0.5; } });
    expect(calls).toBe(0);
  });
});

describe('directed_energy', () => {

  it('uses pk directly when under the cap', () => {
    expect(M.directed_energy.probability({ pkShot: 0.3, params: { killCapPerPass: 10 }, remaining: 20 })).toBeCloseTo(0.3);
  });

  it('scales P down so expected kills never exceed the cap', () => {
    const P = M.directed_energy.probability({ pkShot: 0.3, params: { killCapPerPass: 10 }, remaining: 100 });
    expect(P * 100).toBeCloseTo(10);
  });

  it('has no cap when none is configured', () => {
    expect(M.directed_energy.probability({ pkShot: 0.5, params: {}, remaining: 1000 })).toBe(0.5);
  });

  it('never charges the magazine', () => {
    expect(M.directed_energy.shotsPerThreat({ shots: 0 })).toBe(0);
    expect(M.directed_energy.resolve({ pkShot: 0.5, params: {}, remaining: 3, rng: () => 0 }).shotsPerThreat).toBe(0);
  });
});

describe('gun', () => {

  it('kills one threat per pass with one burst at pk 1 and spends the burst rounds', () => {
    const ctx = { pkShot: 1, shots: 150, params: { burstsPerPass: 1 }, remaining: 40 };
    expect(M.gun.probability(ctx) * 40).toBeCloseTo(1);
    expect(M.gun.shotsPerThreat(ctx) * 40).toBeCloseTo(150);
  });

  it('cannot fire more bursts than there are threats', () => {
    const ctx = { pkShot: 1, shots: 150, params: { burstsPerPass: 3 }, remaining: 2 };
    expect(M.gun.probability(ctx) * 2).toBeCloseTo(2);
    expect(M.gun.shotsPerThreat(ctx) * 2).toBeCloseTo(300);
  });
});

describe('patrol', () => {

  it('uses the cell pk up to the cap', () => {
    const ctx = { pkShot: 1, shots: 1, params: { cap: 20, pLow: 0.5 }, remaining: 20 };
    expect(M.patrol.probability(ctx)).toBe(1);
  });

  it('blends in pLow beyond the cap', () => {
    const ctx = { pkShot: 1, shots: 1, params: { cap: 20, pLow: 0.5 }, remaining: 50 };
    expect(M.patrol.probability(ctx) * 50).toBeCloseTo(20 + 30 * 0.5);
  });

  it('with pLow 0 kills exactly the cap', () => {
    const ctx = { pkShot: 1, shots: 1, params: { cap: 25, pLow: 0 }, remaining: 100 };
    expect(M.patrol.probability(ctx) * 100).toBeCloseTo(25);
  });

  it('applies per-shot combination to both bands', () => {
    const ctx = { pkShot: 0.5, shots: 2, params: { cap: 10, pLow: 0.5 }, remaining: 20 };
    expect(M.patrol.probability(ctx)).toBeCloseTo(0.75);   // both bands 1 − 0.5² = 0.75
  });
});

describe('rollTier', () => {

  it('skips the roll and returns multiplier 1 when all tiers are 1', () => {
    let calls = 0;
    const r = rollTier({ low: 1, medium: 1, high: 1 }, () => { calls++; return 0; });
    expect(r).toEqual({ tier: null, mult: 1 });
    expect(calls).toBe(0);
  });

  it('maps the roll to low / medium / high at 0.33 and 0.67', () => {
    const tiers = { low: 0.8, medium: 1, high: 1.2 };
    expect(rollTier(tiers, () => 0.10)).toEqual({ tier: 'low',    mult: 0.8 });
    expect(rollTier(tiers, () => 0.33)).toEqual({ tier: 'medium', mult: 1   });
    expect(rollTier(tiers, () => 0.67)).toEqual({ tier: 'high',   mult: 1.2 });
    expect(rollTier(tiers, seq([0.99]))).toEqual({ tier: 'high', mult: 1.2 });
  });
});
