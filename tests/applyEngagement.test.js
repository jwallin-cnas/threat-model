/**
 * applyEngagement.test.js — the core kill and magazine arithmetic.
 * Pure and deterministic: no catalogs, no rng.
 */

import { describe, it, expect } from 'vitest';
import { applyEngagement }      from './setup.js';

describe('applyEngagement — kinetic', () => {

  it('kills everything when P = 1 and the magazine suffices', () => {
    const r = applyEngagement(10, 1.0, 30, 2);
    expect(r).toEqual({ killed: 10, survived: 0, engaged: 10, interceptorsUsed: 20, magazineRemaining: 10, note: null });
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
    expect(r).toEqual({ killed: 0, survived: 10, engaged: 0, interceptorsUsed: 0, magazineRemaining: 0, note: 'Magazine exhausted' });
  });

  it('allows fractional shots and leaves a fractional magazine', () => {
    const r = applyEngagement(3, 1.0, 10, 1.5);   // floor(10/1.5) = 6 ≥ 3 → all engaged
    expect(r.killed).toBe(3);
    expect(r.magazineRemaining).toBeCloseTo(5.5);
  });

  it('does nothing for zero threats', () => {
    const r = applyEngagement(0, 1.0, 10, 2);
    expect(r).toEqual({ killed: 0, survived: 0, engaged: 0, interceptorsUsed: 0, magazineRemaining: 10, note: null });
  });

  it('kills nothing at P = 0 but still spends interceptors', () => {
    const r = applyEngagement(4, 0, 10, 2);
    expect(r.killed).toBe(0);
    expect(r.magazineRemaining).toBe(2);
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
