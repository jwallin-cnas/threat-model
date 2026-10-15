#!/usr/bin/env node
/**
 * generate-engagement-defaults.js — Derive the data-driven engagement files
 * from the legacy code-driven engagement functions.
 *
 * Reads the legacy `js/engagement.js` (ENGAGEMENT_FUNCTIONS) and `js/engine.js`
 * (ENGAGEMENT_PRIORITY, THREAT_PRIORITY), probes every system against every
 * threat type, and writes:
 *
 *   data/pk-table.json   — dense system × platform matrix of { pk, shots }
 *   data/doctrine.json   — typeOrder + ordered engage lists per threat type
 *   data/defenses.json   — each system gains an `engagement` block (model +
 *                          parameters); all other fields are left as they are
 *
 * Pk conversion. The legacy functions give a probability for the WHOLE
 * engagement (all shots). The new table is per shot, independent:
 *   P_engagement = 1 − (1 − p_shot)^shots   ⇒   p_shot = 1 − (1 − P)^(1/shots)
 * For systems that rolled a low/medium/high tier, P is the mean of the three
 * tier values (each tier is equally likely). Pairings a system cannot engage
 * (its function returns null) get pk 0 and shots 0.
 *
 * Special systems. Lasers, the jammer, Phalanx and the patrols scale their
 * legacy Pk by salvo size. They are probed with a salvo of 1 so the base
 * value comes through; the salvo-dependent behaviour moves to the model
 * parameters in MODEL_MAP below.
 *
 * Usage:
 *   node scripts/generate-engagement-defaults.js            # read js/*.js from disk
 *   node scripts/generate-engagement-defaults.js --ref 6f5409c   # read legacy files from a git ref
 *   node scripts/generate-engagement-defaults.js --dry-run  # print, write nothing
 */

import * as fs           from 'fs';
import * as path         from 'path';
import { execSync }      from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const refIdx = args.indexOf('--ref');
const REF    = refIdx >= 0 ? args[refIdx + 1] : null;
const DRY    = args.includes('--dry-run');

// ── Engagement model classification ──────────────────────────────────────────
// This mapping is a design decision, not something the legacy code states.
// Every system not listed here is `kinetic` with no parameters.

const MODEL_MAP = {
  thaad:                  { model: 'kinetic', shotRoll: { mrbm: { chance: 0.1, shots: 1.5 } } },
  containerized_laser:    { model: 'directed_energy', killCapPerPass: 10 },
  iron_beam:              { model: 'directed_energy', killCapPerPass: 10 },
  tactical_jammer:        { model: 'directed_energy', killCapPerPass: 5 },
  high_powered_microwave: { model: 'directed_energy' },
  phalanx_cram:           { model: 'gun', burstsPerPass: 1 },
  f15e_patrol:            { model: 'patrol', cap: 20, pLow: 0.5 },
  fa18_patrol:            { model: 'patrol', cap: 20, pLow: 0.5 },
  f15i_patrol:            { model: 'patrol', cap: 25, pLow: 0 }
};

// ── Load legacy sources ───────────────────────────────────────────────────────

function readSource(rel) {
  if (REF) return execSync(`git show ${REF}:${rel}`, { cwd: ROOT, encoding: 'utf8' });
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function loadBrowserScript(rel) {
  const code = readSource(rel);
  const mod  = { exports: {} };
  new Function('module', 'exports', code)(mod, mod.exports);
  return mod.exports;
}

const { ENGAGEMENT_FUNCTIONS }                  = loadBrowserScript('js/engagement.js');
const { ENGAGEMENT_PRIORITY, THREAT_PRIORITY }  = loadBrowserScript('js/engine.js');

const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const defensesFile = readJson('data/defenses.json');
const attacksFile  = readJson('data/attacks.json');

// ── Probe helpers ─────────────────────────────────────────────────────────────

/** Call fn with Math.random pinned to `roll`, salvo of 1, generous magazine. */
function probe(fn, threatType, roll) {
  const saved = Math.random;
  Math.random = () => roll;
  try { return fn(threatType, 1, 10_000, 1); }
  finally { Math.random = saved; }
}

/** Expected per-engagement Pk and base shots for one system × threat type, or null. */
function legacyParams(systemId, threatType) {
  const fn = ENGAGEMENT_FUNCTIONS[systemId];
  if (!fn) return null;
  const low  = probe(fn, threatType, 0.10);   // tier low   (and THAAD 1.5-shot branch)
  const med  = probe(fn, threatType, 0.50);   // tier medium
  const high = probe(fn, threatType, 0.90);   // tier high
  if (!med) return null;
  const P     = (low.pk + med.pk + high.pk) / 3;
  const shots = med.shotsPerEngagement;        // base shot count (THAAD: the 1.0 branch)
  return { P, shots };
}

function toPerShot(P, shots) {
  if (shots <= 0) return P;                     // directed energy: one "attempt"
  if (P >= 1)     return 1;
  return 1 - Math.pow(1 - P, 1 / shots);
}

const round4 = x => Math.round(x * 10_000) / 10_000;

// ── Build the Pk table ────────────────────────────────────────────────────────

const systems   = defensesFile.systems.map(s => s.id);
const platforms = attacksFile.systems.map(p => ({ id: p.id, type: p.type }));

const cells = {};
for (const sys of systems) {
  cells[sys] = {};
  for (const p of platforms) {
    const lp = legacyParams(sys, p.type);
    cells[sys][p.id] = lp
      ? { pk: round4(toPerShot(lp.P, lp.shots)), shots: lp.shots }
      : { pk: 0, shots: 0 };
  }
}

const pkTable = {
  version: '1.0',
  name:    'Baseline (generated from legacy engagement.js)',
  tiers:   { low: 1.0, medium: 1.0, high: 1.0 },
  cells
};

// ── Build the doctrine ────────────────────────────────────────────────────────

const engage = {};
for (const type of THREAT_PRIORITY) {
  engage[type] = ENGAGEMENT_PRIORITY.filter(sys => legacyParams(sys, type) !== null);
}

const doctrine = {
  version:   '1.0',
  name:      'Baseline (generated from legacy ENGAGEMENT_PRIORITY)',
  typeOrder: [...THREAT_PRIORITY],
  engage
};

// ── Add engagement blocks to defenses.json ────────────────────────────────────

const defensesOut = {
  ...defensesFile,
  systems: defensesFile.systems.map(s => {
    const block = MODEL_MAP[s.id] ? { ...MODEL_MAP[s.id] } : { model: 'kinetic' };
    // Insert `engagement` right after `armament` so the file reads naturally.
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'engagement') continue;
      out[k] = v;
      if (k === 'armament') out.engagement = block;
    }
    if (!out.engagement) out.engagement = block;
    return out;
  })
};

// ── Report ────────────────────────────────────────────────────────────────────

const engageable = Object.values(cells).reduce((n, row) => n + Object.values(row).filter(c => c.pk > 0).length, 0);
console.log(`[generate] ${systems.length} systems × ${platforms.length} platforms = ${systems.length * platforms.length} cells, ${engageable} engageable`);
for (const type of doctrine.typeOrder) console.log(`[generate] ${type.padEnd(15)} ${engage[type].length} systems: ${engage[type].join(', ')}`);
const missing = systems.filter(s => !ENGAGEMENT_FUNCTIONS[s]);
if (missing.length) console.warn(`[generate] systems with no legacy function (all cells 0): ${missing.join(', ')}`);
const unlisted = systems.filter(s => ENGAGEMENT_FUNCTIONS[s] && !ENGAGEMENT_PRIORITY.includes(s));
if (unlisted.length) console.warn(`[generate] systems with a function but absent from ENGAGEMENT_PRIORITY (not in doctrine): ${unlisted.join(', ')}`);

if (DRY) {
  console.log(JSON.stringify({ pkTable, doctrine }, null, 2));
  process.exit(0);
}

/**
 * JSON.stringify with 2-space indent, but arrays of primitives that fit on
 * one line stay on one line — the style the hand-edited data files use.
 */
function formatJson(value) {
  const text = JSON.stringify(value, null, 2);
  const collapse = (open, close, limit) => (m, body) => {
    const items = body.split('\n').map(l => l.trim()).filter(Boolean);
    const line  = open + items.join(' ') + close;
    return line.length <= limit ? line : m;
  };
  return text
    .replace(/\[\n([^\[\]{}]*?)\n\s*\]/g, collapse('[', ']', 100))      // short arrays of primitives
    .replace(/\{\n([^\[\]{}]*?)\n\s*\}/g, collapse('{ ', ' }', 60));    // short objects of primitives
}

fs.writeFileSync(path.join(ROOT, 'data/pk-table.json'), formatJson(pkTable) + '\n');
fs.writeFileSync(path.join(ROOT, 'data/doctrine.json'), formatJson(doctrine) + '\n');
fs.writeFileSync(path.join(ROOT, 'data/defenses.json'), formatJson(defensesOut) + '\n');
console.log('[generate] wrote data/pk-table.json, data/doctrine.json, data/defenses.json');
