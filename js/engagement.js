/**
 * engagement.js — Per-system engagement functions
 *
 * ── How to complete a function ────────────────────────────────────────────────
 *
 * Each function receives one argument:
 *
 *   threatType    'ballistic_missile' | 'cruise_missile' | 'drone' | 'hypersonic'
 *
 * It must return ONE of:
 *
 *   null                    → this system cannot engage this threat type;
 *                             the threat passes through untouched.
 *
 *   { pk, shotsPerEngagement }
 *                           → engage with this probability-of-kill and this
 *                             number of interceptors fired per target attempt.
 *
 * Magazine accounting and kill calculation are handled entirely by the
 * simulator (simulate.js). Engagement functions only need to encode
 * tactical decisions: can this system engage, at what Pk, and how many
 * shots does it fire per attempt?
 *
 * ── Random elements ───────────────────────────────────────────────────────────
 *
 * Math.random() may be called freely. The function is called fresh for every
 * (system × threat-type) engagement, so each salvo gets an independent draw.
 * Use it to model variable Pk or variable shot count, for example:
 *
 *   const roll = Math.random();
 *   const pk   = roll < 0.33 ? 0.70 : roll < 0.67 ? 0.85 : 1.0;
 *
 *   const shots = Math.random() < 0.10 ? 2 : 1;  // 10% chance of second shot
 *
 * ── Placeholder state ─────────────────────────────────────────────────────────
 *
 * Returning pk: 0.0 triggers the PLACEHOLDER display in the results and does
 * NOT consume magazine. Replace 0.0 with your assessed value (or a random
 * draw) to activate that system in the simulation.
 */

const ENGAGEMENT_FUNCTIONS = {

  // ── Aegis BMD — SM-3 (aegis_sm3) ─────────────────────────────────────────
  aegis_sm3: function(threatType) {
    if (threatType !== 'ballistic_missile') return null;
    const pk = 1.0;
    const shots = 1.0
    return {
      pk:                 pk,
      shotsPerEngagement: shots
    };
  },

  // ── Aegis BMD — SM-6 (aegis_sm6) ─────────────────────────────────────────
  aegis_sm6: function(threatType) {
    if (!['ballistic_missile', 'cruise_missile', 'drone'].includes(threatType)) return null;
    const pk = 1.0;
    const shots = 1.0
    return {
      pk:                 pk,
      shotsPerEngagement: shots
    };
  },

  // ── THAAD ─────────────────────────────────────────────────────────────────
  thaad: function(threatType) {
    if (threatType !== 'ballistic_missile') return null;
    const pk = 1.0;
    const roll = Math.random();
    const shots = roll <= 0.1 ? 1.5 : 1.0;
    return {
      pk:                 pk,
      shotsPerEngagement: shots
    };
  },

  // ── Arrow 2/3 (arrow) ─────────────────────────────────────────────────────
  arrow: function(threatType) {
    if (threatType !== 'ballistic_missile') return null;
    const pk = 1.0;
    const shots = 1.0;
    return {
      pk:                 pk,
      shotsPerEngagement: shots
    };
  },

  // ── Aegis BMD — SM-2 (aegis_sm2) ─────────────────────────────────────────
  aegis_sm2: function(threatType) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    const pk = 1.0;
    const shots = 1.0
    return {
      pk:                 pk,
      shotsPerEngagement: shots
    };
  },

  // ── David's Sling (davids_sling) ──────────────────────────────────────────
  davids_sling: function(threatType) {
    if (!['ballistic_missile', 'cruise_missile', 'drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = threatType === 'drone' ? 3 : 2;
    return { 
      pk: pk, 
      shotsPerEngagement: shots };
  },

  // ── Patriot (patriot) ─────────────────────────────────────────────────────
  patriot: function(threatType) {
    if (!['ballistic_missile', 'cruise_missile', 'drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = threatType === 'drone' ? 3 : 2;
    return { 
      pk: pk, 
      shotsPerEngagement: shots };
  },

  // ── Iron Dome (iron_dome) ─────────────────────────────────────────────────
  iron_dome: function(threatType) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 3;
    return { 
      pk: pk, 
      shotsPerEngagement: shots };
  },

  // ── Cheongung II (cheongung2) ─────────────────────────────────────────────
  cheongung2: function(threatType) {
    if (!['ballistic_missile', 'cruise_missile', 'drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = threatType === 'drone' ? 3 : 2;
    return { 
      pk: pk, 
      shotsPerEngagement: shots };
  },

  // ── NASAMS (nasams) ───────────────────────────────────────────────────────
  nasams: function(threatType) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 2;
    return { 
      pk: pk, 
      shotsPerEngagement: shots };
  },

  // ── Pantsir-S1E (pantsirs1e) ──────────────────────────────────────────────
  pantsirs1e: function(threatType) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 2;
    return { 
      pk: pk, 
      shotsPerEngagement: shots };
  },

  // ── IFPC-2 (ifpc2) ────────────────────────────────────────────────────────
  ifpc2: function(threatType) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 2;
    return { 
      pk: pk, 
      shotsPerEngagement: shots };
  },

  // ── FS-LIDS (fslids) ──────────────────────────────────────────────────────
  fslids: function(threatType) {
    if (!['drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 2;
    return {
      pk: pk,
      shotsPerEngagement: shots };
  },

  // ── M-SHORAD (m_shorad) ───────────────────────────────────────────────────
  m_shorad: function(threatType) {
    if (!['drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 2;
    return {
      pk: pk,
      shotsPerEngagement: shots };
  },

  // ── Phalanx C-RAM (phalanx_cram) ──────────────────────────────────────────
  phalanx_cram: function(threatType) {
    if (!['drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 150;
    return {
      pk: pk,
      shotsPerEngagement: shots };
  },

  // ── Tactical Jammer (tactical_jammer) ─────────────────────────────────────
  tactical_jammer: function(threatType) {
    if (!['drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 0;
    return {
      pk: pk,
      shotsPerEngagement: shots };
  },

  // ── Merops (merops) ───────────────────────────────────────────────────────
  merops: function(threatType) {
    if (!['drone'].includes(threatType)) return null;
    const pks  = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 2;
    return {
      pk: pk,
      shotsPerEngagement: shots };
  },

  // ── High-Powered Microwave (high_powered_microwave) ───────────────────────
  high_powered_microwave: function(threatType) {
    if (!['drone'].includes(threatType)) return null;
    const pks  = { low: 0.3, medium: 0.4, high: 0.5 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 0;
    return {
      pk: pk,
      shotsPerEngagement: shots };
  },

  // ── Containerized Laser (containerized_laser) ─────────────────────────────
  containerized_laser: function(threatType) {
    if (!['drone'].includes(threatType)) return null;
    const pks  = { low: 0.3, medium: 0.4, high: 0.5 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 0;
    return {
      pk: pk,
      shotsPerEngagement: shots };
  },

  // ── Iron Beam (iron_beam) ─────────────────────────────────────────────────
  iron_beam: function(threatType) {
    if (!['drone'].includes(threatType)) return null;
    const pks  = { low: 0.3, medium: 0.4, high: 0.5 };
    const roll = Math.random();
    const pk   = roll >= 0.67 ? pks.high : roll >= 0.33 ? pks.medium : pks.low;
    const shots = 0;
    return {
      pk: pk,
      shotsPerEngagement: shots };
  },

};
