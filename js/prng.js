/**
 * prng.js — Seeded pseudo-random number generator (mulberry32)
 *
 * Replaces Math.random with a deterministic, seedable implementation so that
 * simulation results are reproducible across batch runs and browser sessions.
 * Must be loaded before any script that calls Math.random().
 *
 * window._setSeed(n) resets the generator to a known state — called by the
 * batch runner at the start of each batch to ensure consistent output.
 */

const FIXED_SEED = 0xDEAD1234;

(function (seed) {
  let s = seed >>> 0;

  Math.random = function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };

  window._setSeed = function (n) {
    s = (n >>> 0);
  };

}(FIXED_SEED));
