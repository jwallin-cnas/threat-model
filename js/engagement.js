/**
 * engagement.js — Per-system engagement functions
 *
 * ── How to complete a function ────────────────────────────────────────────────
 *
 * Each function receives four arguments:
 *
 *   threatType    'ballistic_missile' | 'cruise_missile' | 'drone' | 'hypersonic'
 *   quantity      number of batteries deployed at this location
 *   magazine      interceptors currently available in this battery's magazine
 *   platformId    ID of the specific platform being engaged (e.g. 'shahab3',
 *                 'shahed136'). Use PLATFORM_CATALOG[platformId] to look up
 *                 platform properties (speed, RCS, etc.) for per-platform Pk.
 *
 * It must return ONE of:
 *
 *   null                    → this system cannot engage this threat type;
 *                             the threat passes through untouched.
 *
 *   { pk, pkTier, pkIsFixed, shotsPerEngagement, shotsPerEngagementTier }
 *
 *     pk                    → numeric probability-of-kill (0–1)
 *     pkTier                → 'low' | 'medium' | 'high'
 *                             For systems with a fixed Pk, always return 'high'.
 *     pkIsFixed             → true if the Pk is deterministic (no roll);
 *                             false if it was drawn from a random distribution.
 *     shotsPerEngagement    → interceptors expended per target attempt
 *     shotsPerEngagementTier→ 'standard' | 'elevated' | null
 *                             Set only for systems that roll for their shot count.
 *                             null means the shot count is deterministic.
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
 *
 * ── Placeholder state ─────────────────────────────────────────────────────────
 *
 * Returning pk: 0.0 triggers the PLACEHOLDER display in the results and does
 * NOT consume magazine. Replace 0.0 with your assessed value (or a random
 * draw) to activate that system in the simulation.
 */

const ENGAGEMENT_FUNCTIONS = {

  // ── Aegis BMD — SM-3 (aegis_sm3) ─────────────────────────────────────────
  aegis_sm3: function(threatType, quantity, magazine, platformId) {
    if (threatType !== 'ballistic_missile') return null;
    return {
      pk:                     1.0,
      pkTier:                 'high',
      pkIsFixed:              true,
      shotsPerEngagement:     1,
      shotsPerEngagementTier: null
    };
  },

  // ── Aegis BMD — SM-6 (aegis_sm6) ─────────────────────────────────────────
  aegis_sm6: function(threatType, quantity, magazine, platformId) {
    if (!['ballistic_missile', 'cruise_missile', 'drone'].includes(threatType)) return null;
    return {
      pk:                     1.0,
      pkTier:                 'high',
      pkIsFixed:              true,
      shotsPerEngagement:     1,
      shotsPerEngagementTier: null
    };
  },

  // ── THAAD ─────────────────────────────────────────────────────────────────
  thaad: function(threatType, quantity, magazine, platformId) {
    if (threatType !== 'ballistic_missile') return null;
    const roll  = Math.random();
    const shots = roll <= 0.1 ? 1.5 : 1.0;
    return {
      pk:                     1.0,
      pkTier:                 'high',
      pkIsFixed:              true,
      shotsPerEngagement:     shots,
      shotsPerEngagementTier: shots === 1.5 ? 'elevated' : 'standard'
    };
  },

  // ── Arrow 2/3 (arrow) ─────────────────────────────────────────────────────
  arrow: function(threatType, quantity, magazine, platformId) {
    if (threatType !== 'ballistic_missile') return null;
    return {
      pk:                     1.0,
      pkTier:                 'high',
      pkIsFixed:              true,
      shotsPerEngagement:     1,
      shotsPerEngagementTier: null
    };
  },

  // ── Aegis BMD — SM-2 (aegis_sm2) ─────────────────────────────────────────
  aegis_sm2: function(threatType, quantity, magazine, platformId) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    return {
      pk:                     1.0,
      pkTier:                 'high',
      pkIsFixed:              true,
      shotsPerEngagement:     1,
      shotsPerEngagementTier: null
    };
  },

  // ── David's Sling (davids_sling) ──────────────────────────────────────────
  davids_sling: function(threatType, quantity, magazine, platformId) {
    if (!['ballistic_missile', 'cruise_missile', 'drone'].includes(threatType)) return null;
    const pks    = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    const shots  = threatType === 'drone' ? 3 : 2;
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     shots,
      shotsPerEngagementTier: null
    };
  },

  // ── Patriot (patriot) ─────────────────────────────────────────────────────
  patriot: function(threatType, quantity, magazine, platformId) {
    if (!['ballistic_missile', 'cruise_missile', 'drone'].includes(threatType)) return null;
    const pks    = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    const shots  = threatType === 'drone' ? 3 : 2;
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     shots,
      shotsPerEngagementTier: null
    };
  },

  // ── Iron Dome (iron_dome) ─────────────────────────────────────────────────
  iron_dome: function(threatType, quantity, magazine, platformId) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    const pks    = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     3,
      shotsPerEngagementTier: null
    };
  },

  // ── Cheongung II (cheongung2) ─────────────────────────────────────────────
  cheongung2: function(threatType, quantity, magazine, platformId) {
    if (!['ballistic_missile', 'cruise_missile', 'drone'].includes(threatType)) return null;
    const pks    = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    const shots  = threatType === 'drone' ? 3 : 2;
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     shots,
      shotsPerEngagementTier: null
    };
  },

  // ── NASAMS (nasams) ───────────────────────────────────────────────────────
  nasams: function(threatType, quantity, magazine, platformId) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    const pks    = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     2,
      shotsPerEngagementTier: null
    };
  },

  // ── Pantsir-S1E (pantsirs1e) ──────────────────────────────────────────────
  pantsirs1e: function(threatType, quantity, magazine, platformId) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    const pks    = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     2,
      shotsPerEngagementTier: null
    };
  },

  // ── IFPC-2 (ifpc2) ────────────────────────────────────────────────────────
  ifpc2: function(threatType, quantity, magazine, platformId) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    const pks    = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     2,
      shotsPerEngagementTier: null
    };
  },

  // ── FS-LIDS (fslids) ──────────────────────────────────────────────────────
  fslids: function(threatType, quantity, magazine, platformId) {
    if (!['drone'].includes(threatType)) return null;
    const pks    = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     2,
      shotsPerEngagementTier: null
    };
  },

  // ── M-SHORAD (m_shorad) ───────────────────────────────────────────────────
  m_shorad: function(threatType, quantity, magazine, platformId) {
    if (!['drone'].includes(threatType)) return null;
    const pks    = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     2,
      shotsPerEngagementTier: null
    };
  },

  // ── Phalanx C-RAM (phalanx_cram) ──────────────────────────────────────────
  phalanx_cram: function(threatType, quantity, magazine, platformId) {
    if (!['drone'].includes(threatType)) return null;
    const pks    = { low: 0.70, medium: 0.85, high: 1.0 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     150,
      shotsPerEngagementTier: null
    };
  },

  // ── Tactical Jammer (tactical_jammer) ─────────────────────────────────────
  tactical_jammer: function(threatType, quantity, magazine, platformId) {
    if (!['drone'].includes(threatType)) return null;
    const pks    = { low: 0.3, medium: 0.4, high: 0.5 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     0,
      shotsPerEngagementTier: null
    };
  },

  // ── Merops (merops) ───────────────────────────────────────────────────────
  merops: function(threatType, quantity, magazine, platformId) {
    if (!['drone'].includes(threatType)) return null;
    const pks    = { low: 0.40, medium: 0.50, high: 0.60 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     2,
      shotsPerEngagementTier: null
    };
  },

  // ── High-Powered Microwave (high_powered_microwave) ───────────────────────
  high_powered_microwave: function(threatType, quantity, magazine, platformId) {
    if (!['drone'].includes(threatType)) return null;
    const pks    = { low: 0.4, medium: 0.5, high: 0.6 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     0,
      shotsPerEngagementTier: null
    };
  },

  // ── Containerized Laser (containerized_laser) ─────────────────────────────
  containerized_laser: function(threatType, quantity, magazine, platformId) {
    if (!['drone'].includes(threatType)) return null;
    const pks    = { low: 0.2, medium: 0.3, high: 0.4 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     0,
      shotsPerEngagementTier: null
    };
  },

  // ── Iron Beam (iron_beam) ─────────────────────────────────────────────────
  iron_beam: function(threatType, quantity, magazine, platformId) {
    if (!['drone'].includes(threatType)) return null;
    const pks    = { low: 0.2, medium: 0.3, high: 0.4 };
    const roll   = Math.random();
    const pkTier = roll >= 0.67 ? 'high' : roll >= 0.33 ? 'medium' : 'low';
    return {
      pk:                     pks[pkTier],
      pkTier,
      pkIsFixed:              false,
      shotsPerEngagement:     0,
      shotsPerEngagementTier: null
    };
  },

  // ── F-15E Patrol ×2 (f15e_patrol) ────────────────────────────────────────
  f15e_patrol: function(threatType, quantity, magazine, platformId) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    return {
      pk:                     1.0,
      pkTier:                 'high',
      pkIsFixed:              true,
      shotsPerEngagement:     1,
      shotsPerEngagementTier: null
    };
  },

  // ── F/A-18 Patrol ×2 (fa18_patrol) ───────────────────────────────────────
  fa18_patrol: function(threatType, quantity, magazine, platformId) {
    if (!['cruise_missile', 'drone'].includes(threatType)) return null;
    return {
      pk:                     1.0,
      pkTier:                 'high',
      pkIsFixed:              true,
      shotsPerEngagement:     1,
      shotsPerEngagementTier: null
    };
  },

};
