/**
 * applyEngagement.test.js
 *
 * Unit tests for the applyEngagement() core math function.
 * These tests are purely deterministic — no catalog data or Math.random needed.
 */

import { describe, it, expect } from 'vitest';
import { applyEngagement }      from './setup.js';

describe('applyEngagement', () => {

  // ── Standard kinetic engagement ───────────────────────────────────────────

  it('kills all threats when pk=1 and magazine is sufficient', () => {
    const r = applyEngagement(10, 1.0, 30, 2);
    expect(r.killed).toBe(10);
    expect(r.survived).toBe(0);
    expect(r.magazineRemaining).toBe(10); // 30 - (10 × 2)
    expect(r.isPlaceholder).toBe(false);
    expect(r.note).toBeNull();
  });

  it('kills nobody when magazine is exhausted', () => {
    const r = applyEngagement(10, 1.0, 0, 2);
    expect(r.killed).toBe(0);
    expect(r.survived).toBe(10);
    expect(r.magazineRemaining).toBe(0);
    expect(r.note).toBe('Magazine exhausted');
  });

  it('is a placeholder when pk=0, preserving magazine', () => {
    const r = applyEngagement(10, 0, 100, 2);
    expect(r.isPlaceholder).toBe(true);
    expect(r.killed).toBe(0);
    expect(r.magazineRemaining).toBe(100); // must not be consumed
    expect(r.note).toBe('PLACEHOLDER — Pk not set');
  });

  it('caps kills at floor(magazine / shots) when magazine is low', () => {
    // 5 interceptors, 2 shots each → can engage at most 2
    const r = applyEngagement(10, 1.0, 5, 2);
    expect(r.killed).toBe(2);
    expect(r.survived).toBe(8);
    expect(r.magazineRemaining).toBe(1); // 5 - (2 × 2)
  });

  it('handles exactly enough magazine for all threats', () => {
    const r = applyEngagement(5, 1.0, 10, 2);
    expect(r.killed).toBe(5);
    expect(r.survived).toBe(0);
    expect(r.magazineRemaining).toBe(0);
  });

  it('uses single-shot engagement correctly', () => {
    const r = applyEngagement(5, 1.0, 5, 1);
    expect(r.killed).toBe(5);
    expect(r.magazineRemaining).toBe(0);
  });

  it('rounds fractional kills to nearest integer', () => {
    // pk=0.3, 10 threats → 10 × 0.3 = 3.0 → 3 killed
    const r = applyEngagement(10, 0.3, 100, 2);
    expect(r.killed).toBe(3);
    expect(r.survived).toBe(7);
  });

  it('killed + survived always equals threatsIn', () => {
    for (const [count, pk, mag, shots] of [
      [10, 0.75, 30, 2],
      [1, 1.0, 100, 1],
      [100, 0.5, 50, 1],
      [7, 0.85, 20, 3]
    ]) {
      const r = applyEngagement(count, pk, mag, shots);
      expect(r.killed + r.survived).toBe(count);
    }
  });

  // ── Directed-energy / EW (shots = 0) ─────────────────────────────────────

  it('does not consume magazine for directed energy (shots=0)', () => {
    const r = applyEngagement(10, 0.5, 999, 0);
    expect(r.magazineRemaining).toBe(999);
    expect(r.isPlaceholder).toBe(false);
  });

  it('directed energy with pk=0 is a placeholder, magazine preserved', () => {
    const r = applyEngagement(10, 0, 999, 0);
    expect(r.isPlaceholder).toBe(true);
    expect(r.magazineRemaining).toBe(999);
  });

  it('directed energy kills correctly at pk=0.4', () => {
    // Math.round(10 × 0.4) = 4
    const r = applyEngagement(10, 0.4, 999, 0);
    expect(r.killed).toBe(4);
    expect(r.survived).toBe(6);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('handles zero incoming threats gracefully', () => {
    const r = applyEngagement(0, 1.0, 100, 2);
    expect(r.killed).toBe(0);
    expect(r.survived).toBe(0);
    expect(r.magazineRemaining).toBe(100);
  });

  it('magazine is unchanged when magazine=1 and shots=2 (cannot engage)', () => {
    // floor(1/2) = 0 engageable → no shots fired
    const r = applyEngagement(5, 1.0, 1, 2);
    expect(r.killed).toBe(0);
    expect(r.survived).toBe(5);
    expect(r.magazineRemaining).toBe(1);
  });

});
