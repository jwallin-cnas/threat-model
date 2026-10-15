/**
 * applyEngagement.test.js — the core kill and magazine arithmetic.
 * Pure and deterministic: no catalogs, no rng.
 */

import { describe, it, expect } from 'vitest';
import { applyEngagement }      from './setup.js';

describe('applyEngagement — kinetic', () => {

  it('kills everything when P = 1 and the magazine suffices', () => {
    const r = applyEngagement(10, 1.0, 30, 2);
    expect(r).toEqual({ killed: 10, survived: 0, engaged: 10, interceptorsUsed: 20, magazineRemaining: 10, note: null, partial: null });
  });

  it('rounds the expected kill count', () => {
    expect(applyEngagement(10, 0.85, 100, 2).killed).toBe(9);   // 8.5 → 9
    expect(applyEngagement(10, 0.84, 100, 2).killed).toBe(8);   // 8.4 → 8
  });

  it('caps engagements at floor(magazine / shots)', () => {
    const r = applyEngagement(10, 1.0, 5, 2);   // 5 interceptors, 2 each → 2 engaged
    expect(r.killed).toBe(2);
    expect(r.survived).toBe(8);
    expect(r.magazineRemaining).toBe(1);
  });

  it('reports an exhausted magazine without firing', () => {
    const r = applyEngagement(10, 1.0, 0, 2);
    expect(r).toEqual({ killed: 0, survived: 10, engaged: 0, interceptorsUsed: 0, magazineRemaining: 0, note: 'Magazine exhausted', partial: null });
  });

  it('allows fractional shots and leaves a fractional magazine', () => {
    const r = applyEngagement(3, 1.0, 10, 1.5);   // floor(10/1.5) = 6 ≥ 3 → all engaged
    expect(r.killed).toBe(3);
    expect(r.magazineRemaining).toBeCloseTo(5.5);
  });

  it('does nothing for zero threats', () => {
    const r = applyEngagement(0, 1.0, 10, 2);
    expect(r).toEqual({ killed: 0, survived: 0, engaged: 0, interceptorsUsed: 0, magazineRemaining: 10, note: null, partial: null });
  });

  it('kills nothing at P = 0 but still spends interceptors', () => {
    const r = applyEngagement(4, 0, 10, 2);
    expect(r.killed).toBe(0);
    expect(r.magazineRemaining).toBe(2);
  });
});

describe('applyEngagement — partial final engagement', () => {
  const half = shotsLeft => 1 - Math.pow(0.5, shotsLeft);   // per-shot 0.5

  it('spends leftover rounds on one more threat at the reduced probability', () => {
    // 7 interceptors, 3 per threat, P = 0.875 (0.5 per shot × 3): 2 full + 1 shot left
    const r = applyEngagement(10, 0.875, 7, 3, half);
    expect(r.engaged).toBe(3);
    expect(r.interceptorsUsed).toBe(7);
    expect(r.magazineRemaining).toBe(0);
    expect(r.partial).toEqual({ shots: 1, P: 0.5 });
    expect(r.killed).toBe(Math.round(2 * 0.875 + 0.5));   // 2.25 → 2
  });

  it('does nothing extra when the magazine divides evenly', () => {
    const r = applyEngagement(10, 0.875, 6, 3, half);
    expect(r.engaged).toBe(2);
    expect(r.partial).toBeNull();
    expect(r.magazineRemaining).toBe(0);
  });

  it('does nothing extra when every threat already had a full engagement', () => {
    const r = applyEngagement(2, 0.875, 7, 3, half);
    expect(r.engaged).toBe(2);
    expect(r.partial).toBeNull();
    expect(r.magazineRemaining).toBe(1);
  });

  it('turns a too-low magazine into one reduced engagement instead of nothing', () => {
    const r = applyEngagement(5, 0.875, 1, 3, half);
    expect(r.engaged).toBe(1);
    expect(r.partial).toEqual({ shots: 1, P: 0.5 });
    expect(r.killed).toBe(1);   // round(0.5) = 1
    expect(r.note).toBeNull();
  });

  it('notes a too-low magazine when no partial function is given', () => {
    const r = applyEngagement(5, 0.875, 1, 3);
    expect(r.engaged).toBe(0);
    expect(r.killed).toBe(0);
    expect(r.magazineRemaining).toBe(1);
    expect(r.note).toBe('Magazine too low');
  });
});

describe('applyEngagement — directed energy (shots 0)', () => {

  it('never touches the magazine', () => {
    const r = applyEngagement(10, 0.3, 999, 0);
    expect(r.killed).toBe(3);
    expect(r.survived).toBe(7);
    expect(r.magazineRemaining).toBe(999);
    expect(r.note).toBeNull();
  });

  it('works with a zero magazine too', () => {
    expect(applyEngagement(10, 0.5, 0, 0).killed).toBe(5);
  });
});
