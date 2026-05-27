/**
 * catalog.js
 * Runtime containers for defense systems and attack platforms.
 * All entries are populated at startup from data/defenses.json and
 * data/attacks.json by mergeLoadedData() in app.js — do not add
 * hardcoded entries here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Defense System Catalog  (populated from data/defenses.json at runtime)
// ─────────────────────────────────────────────────────────────────────────────
const DEFENSE_CATALOG = {};

// ─────────────────────────────────────────────────────────────────────────────
// Attack Platform Catalog  (populated from data/attacks.json at runtime)
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_CATALOG = {};

// ─────────────────────────────────────────────────────────────────────────────
// UI helper constants
// ─────────────────────────────────────────────────────────────────────────────

const TIER_COLORS = {
  1: '#5b8dd9',
  2: '#4fc3d4',
  3: '#4caf78',
  4: '#d4b84f',
  5: '#e07b39',
  6: '#d44f4f'
};

const TIER_LABELS = {
  1: 'Exo-Atmospheric',
  2: 'Upper Endo-Atmospheric',
  3: 'Mid-Range SAM',
  4: 'Short-Range SAM',
  5: 'SHORAD',
  6: 'Close-In Defense'
};

const THREAT_TYPE_LABELS = {
  fpv:              'FPV Drone',
  drone:            'Drone / Loitering Munition',
  cruise_missile:   'Cruise Missile',
  srbm:             'Short-Range Ballistic Missile (SRBM)',
  mrbm:             'Medium-Range Ballistic Missile (MRBM)',
  hypersonic:       'Hypersonic Glide Vehicle'
};

const THREAT_TYPE_ICONS = {
  fpv:              '●',
  drone:            '●',
  cruise_missile:   '●',
  srbm:             '●',
  mrbm:             '●',
  hypersonic:       '●'
};
