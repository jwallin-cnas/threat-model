/**
 * engagement-models.js — How a Pk-table cell becomes an engagement
 *
 * The Pk table gives, for one defense system against one attack platform,
 * a per-shot kill probability `pk` and a shot count `shots`. A system's
 * `engagement.model` in defenses.json names one of the four models below,
 * which turns those two numbers (plus the model's parameters and the number
 * of threats in the group) into what the engine's applyEngagement() needs:
 *
 *   P               probability that one engaged threat is killed
 *   shotsPerThreat  interceptors (or rounds) the magazine loses per threat
 *
 * Pass state. Caps (a laser's kills per pass, a gun's bursts per pass, a
 * patrol's threats at full Pk) apply to one THREAT TYPE in one simulation
 * run, not to each platform group. The engine gives every deployed battery a
 * fresh `pass` object at the start of each threat type and passes it to the
 * model for every platform of that type; the model reads it in
 * probability()/shotsPerThreat() and updates it in afterEngagement().
 *
 * Every model exposes:
 *   probability(ctx)        → P, deterministic (also used by the override re-walk)
 *   shotsPerThreat(ctx)     → magazine cost per threat, deterministic
 *   resolve(ctx)            → { P, shotsPerThreat, shotsTier }; may consume ctx.rng
 *   afterEngagement(ctx, r) → updates ctx.pass from an applyEngagement() result
 *   partialProbability(ctx, shotsLeft, engagedFull)
 *                           → P for ONE more threat engaged with only `shotsLeft` rounds
 *                             (the leftover that cannot afford a full engagement)
 *
 * ctx = { pkShot, shots, params, threatType, remaining, pass, rng }
 *   pkShot     cell pk after the tier multiplier (0..1)
 *   shots      cell shots
 *   params     the system's `engagement` block (model parameters)
 *   remaining  threats of this platform still inbound at this layer
 *   pass       per-battery, per-threat-type state object (may be empty)
 *   rng        () => number in [0,1)
 *
 * Runs in the browser (global ENGAGEMENT_MODELS) and in Node via the shim
 * at the bottom. Nothing here touches shared state outside ctx.pass.
 */

const ENGAGEMENT_MODELS = {

  // ── kinetic ───────────────────────────────────────────────────────────────
  // Interceptors fired at each threat, independent per-shot kills.
  // Optional params.shotRoll[threatType] = { chance, shots } replaces the
  // shot count with `shots` when a roll lands at or below `chance`
  // (THAAD: 10 percent chance of 1.5 shots against MRBM).
  kinetic: {
    usesMagazine: true,
    probability({ pkShot, shots }) {
      if (pkShot >= 1) return 1;
      if (shots <= 0)  return 0;
      return 1 - Math.pow(1 - pkShot, shots);
    },
    shotsPerThreat({ shots }) { return shots; },
    resolve(ctx) {
      const roll = ctx.params?.shotRoll?.[ctx.threatType];
      let shots = ctx.shots, shotsTier = null;
      if (roll) {
        const elevated = ctx.rng() <= roll.chance;
        shots     = elevated ? roll.shots : ctx.shots;
        shotsTier = elevated ? 'elevated' : 'standard';
      }
      const c = { ...ctx, shots };
      return { P: this.probability(c), shotsPerThreat: this.shotsPerThreat(c), shotsTier };
    },
    afterEngagement() {},
    partialProbability(ctx, shotsLeft) { return this.probability({ ...ctx, shots: shotsLeft }); }
  },

  // ── directed_energy ───────────────────────────────────────────────────────
  // Lasers, microwave, jamming. No magazine. Optional params.killCapPerPass
  // limits the expected kills against one threat type in one run; kills
  // already made in this type pass (pass.kills) reduce what is left.
  directed_energy: {
    usesMagazine: false,
    probability({ pkShot, params, remaining, pass }) {
      const cap = params?.killCapPerPass;
      if (cap == null || remaining <= 0) return pkShot;
      const capLeft = Math.max(0, cap - (pass?.kills || 0));
      return Math.min(pkShot * remaining, capLeft) / remaining;
    },
    shotsPerThreat() { return 0; },
    resolve(ctx) {
      return { P: this.probability(ctx), shotsPerThreat: 0, shotsTier: null };
    },
    afterEngagement(ctx, result) {
      if (ctx.pass) ctx.pass.kills = (ctx.pass.kills || 0) + result.killed;
    },
    partialProbability() { return 0; }   // no magazine, never called
  },

  // ── gun ───────────────────────────────────────────────────────────────────
  // Close-in gun (Phalanx). Fires up to params.burstsPerPass bursts against
  // one threat type in one run; each burst spends `shots` rounds and kills
  // its target with probability pk. Expressed per threat so that
  // applyEngagement() charges bursts × shots rounds for a full pass.
  gun: {
    usesMagazine: true,
    _burstsLeft({ params, pass }) {
      return Math.max(0, (params?.burstsPerPass ?? 1) - (pass?.bursts || 0));
    },
    probability(ctx) {
      if (ctx.remaining <= 0) return 0;
      return Math.min(this._burstsLeft(ctx), ctx.remaining) * ctx.pkShot / ctx.remaining;
    },
    shotsPerThreat(ctx) {
      if (ctx.remaining <= 0) return 0;
      return Math.min(this._burstsLeft(ctx), ctx.remaining) * ctx.shots / ctx.remaining;
    },
    resolve(ctx) {
      return { P: this.probability(ctx), shotsPerThreat: this.shotsPerThreat(ctx), shotsTier: null };
    },
    afterEngagement(ctx, result) {
      if (!ctx.pass || !(ctx.shots > 0)) return;
      ctx.pass.bursts = (ctx.pass.bursts || 0) + result.interceptorsUsed / ctx.shots;
    },
    // A short burst: kill probability scales with the fraction of a full burst.
    partialProbability(ctx, shotsLeft) {
      return ctx.shots > 0 ? ctx.pkShot * Math.min(1, shotsLeft / ctx.shots) : 0;
    }
  },

  // ── patrol ────────────────────────────────────────────────────────────────
  // Combat air patrol. The first params.cap threats of a type in one run are
  // engaged at the cell pk; threats beyond the cap at params.pLow. Both are
  // per shot. Threats already engaged in this type pass (pass.engaged) count
  // toward the cap. The two bands are folded into one effective P.
  patrol: {
    usesMagazine: true,
    probability({ pkShot, shots, params, remaining, pass }) {
      if (remaining <= 0 || shots <= 0) return 0;
      const cap     = params?.cap  ?? Infinity;
      const pLow    = params?.pLow ?? 0;
      const capLeft = Math.max(0, cap - (pass?.engaged || 0));
      const pHigh   = pkShot >= 1 ? 1 : 1 - Math.pow(1 - pkShot, shots);
      const pTail   = pLow   >= 1 ? 1 : 1 - Math.pow(1 - pLow,   shots);
      const nHigh   = Math.min(remaining, capLeft);
      const nTail   = remaining - nHigh;
      return (nHigh * pHigh + nTail * pTail) / remaining;
    },
    shotsPerThreat({ shots }) { return shots; },
    resolve(ctx) {
      return { P: this.probability(ctx), shotsPerThreat: this.shotsPerThreat(ctx), shotsTier: null };
    },
    afterEngagement(ctx, result) {
      if (ctx.pass) ctx.pass.engaged = (ctx.pass.engaged || 0) + result.engaged;
    },
    // The extra threat falls in the full-Pk band or the pLow band depending on
    // how many threats this pass has engaged so far.
    partialProbability(ctx, shotsLeft, engagedFull) {
      const cap  = ctx.params?.cap ?? Infinity;
      const done = (ctx.pass?.engaged || 0) + engagedFull;
      const p    = done < cap ? ctx.pkShot : (ctx.params?.pLow ?? 0);
      return p >= 1 ? 1 : 1 - Math.pow(1 - p, shotsLeft);
    }
  }
};

// Node.js export shim — a no-op in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ENGAGEMENT_MODELS };
}
