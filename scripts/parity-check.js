#!/usr/bin/env node
/**
 * parity-check.js — Compare the data-driven engine against the legacy
 * code-driven engine on every batch combination.
 *
 * The legacy engine (engine.js + engagement.js at a git ref) rolled a Pk tier
 * at random, so it is run over many seeds and averaged. The new engine with
 * the shipped pk-table.json / doctrine.json is deterministic and is run once.
 *
 * Two stages, both per combination, per attack, per threat type and system:
 *   1. Pinned: both engines deterministic at the medium tier (Math.random
 *      and rng fixed at 0.5). Leakers and interceptors must agree within
 *      --tol-pinned (default 2; the residual is per-platform rounding).
 *      Systems whose legacy Pk and shot count never rolled must match
 *      exactly.
 *   2. Mean: the new engine once vs the legacy mean over --seeds random
 *      seeds, within --tol-mean (default 5). Guards against gross drift.
 *
 * Laydown assembly (own defenses + enabled cross-target coverage, quantity ×
 * batteries, operator rule, per-type range restriction) is re-implemented
 * here from app.js so the check runs in Node without a browser. Both engines
 * receive the identical defense list, so a difference in assembly cannot
 * create a false pass.
 *
 * Usage:
 *   node scripts/parity-check.js --old-ref 9bded9b [--seeds 50] [--tol-pinned 2] [--tol-mean 5]
 *   node scripts/parity-check.js --old-ref 9bded9b --dump <laydownStem> <attackStem> <attackNumber>
 */

import * as fs           from 'fs';
import * as path         from 'path';
import { execSync }      from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const opt   = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const OLD_REF    = opt('--old-ref', null);
const SEEDS      = parseInt(opt('--seeds', '50'), 10);
const TOL_PINNED = parseFloat(opt('--tol-pinned', '2'));   // both engines at the medium tier
const TOL_MEAN   = parseFloat(opt('--tol-mean', '5'));     // new (deterministic) vs legacy mean over seeds
if (!OLD_REF) { console.error('usage: node scripts/parity-check.js --old-ref <git-ref> [--seeds N] [--tol-pinned X] [--tol-mean Y] [--dump laydown attack n]'); process.exit(2); }
const OLD_RNG = '0.5';   // pinned value for the dump and the pinned stage
// ── Loaders ───────────────────────────────────────────────────────────────────
function loadScript(code, globals = {}) {
  const mod = { exports: {} };
  const names = Object.keys(globals);
  new Function('module', 'exports', ...names, code)(mod, mod.exports, ...names.map(n => globals[n]));
  return mod.exports;
}
const gitShow  = rel => execSync(`git show ${OLD_REF}:${rel}`, { cwd: ROOT, encoding: 'utf8' });
const readFile = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = rel => JSON.parse(readFile(rel));

const oldEngine = loadScript(gitShow('js/engine.js'));
const oldEngFns = loadScript(gitShow('js/engagement.js')).ENGAGEMENT_FUNCTIONS;
const { ENGAGEMENT_MODELS } = loadScript(readFile('js/engagement-models.js'));
const newEngine = loadScript(readFile('js/engine.js'), { ENGAGEMENT_MODELS });

// ── Data ──────────────────────────────────────────────────────────────────────
const defensesRaw = readJson('data/defenses.json').systems;
const attacksRaw  = readJson('data/attacks.json').systems;
const targets     = readJson('data/targets.json').targets;
const T           = Object.fromEntries(targets.map(t => [t.id, t]));
const DS          = Object.fromEntries(defensesRaw.map(s => [s.id, s]));

const oldDC = oldEngine.buildDefenseCatalog(defensesRaw);
const oldPC = oldEngine.buildPlatformCatalog(attacksRaw);
const newDC = newEngine.buildDefenseCatalog(defensesRaw);
const newPC = newEngine.buildPlatformCatalog(attacksRaw);
const { table: pkTable, warnings: pkW }   = newEngine.normalizePkTable(readJson('data/pk-table.json'), newDC, newPC);
const { doctrine, warnings: docW }        = newEngine.normalizeDoctrine(readJson('data/doctrine.json'), newDC);
if (pkW.length || docW.length) { console.warn('[parity] data warnings:', [...pkW, ...docW].slice(0, 10)); }
// Capability (which threat types a system can engage) comes from the doctrine
// for BOTH engines, so the cross-target range filter is identical.
const CAPABILITY = Object.fromEntries(Object.keys(newDC).map(id => [id, newEngine.systemThreatTypes(doctrine, id)]));

// Systems whose legacy Pk never rolled (pkIsFixed true for every type they engage).
const FIXED = new Set(Object.keys(oldEngFns).filter(id => {
  const saved = Math.random; Math.random = () => 0.5;
  try {
    return oldEngine.THREAT_PRIORITY.every(t => {
      const p = oldEngFns[id](t, 1, 1000, 1); if (!p) return true;
      Math.random = () => 0.05; const q = oldEngFns[id](t, 1, 1000, 1); Math.random = () => 0.5;
      return p.pkIsFixed && q.shotsPerEngagement === p.shotsPerEngagement;
    });
  }
  finally { Math.random = saved; }
}));

// ── Laydown assembly (mirrors app.js) ─────────────────────────────────────────
const hav = (a, b, c, d) => { const R = 6371, r = x => x * Math.PI / 180, dLat = r(c - a), dLon = r(d - b);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLon / 2) ** 2; return R * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q)); };

/** laydown file → { targetId: [entry] } with app.js ingest semantics. */
function ingestLaydown(file) {
  const out = {};
  for (const [tid, entries] of Object.entries(file.defaults)) {
    const t = T[tid]; if (!t) continue;
    out[tid] = entries.filter(d => DS[d.system]).map(d => ({
      ...d,
      quantity: (parseInt(d.quantity, 10) || 1) * (DS[d.system]?.batteries ?? 1),
      operator: d.operator || t.country || ''
    }));
  }
  return out;
}

/** Deployed defense list for one target: own + enabled cross-target, as simulate() builds it. */
function defensesFor(laydown, tid, dc) {
  const t = T[tid];
  const own = (laydown[tid] || []).filter(d => !d.disabled).map(d => ({ ...d, locationName: t.name, locationCountry: t.country || '' }));
  const cross = [];
  for (const [oid, o] of Object.entries(T)) {
    if (oid === tid || !laydown[oid]) continue;
    const dist = hav(...t.location, ...o.location);
    for (const d of laydown[oid]) {
      const c = dc[d.system]; if (!c || c.range_km <= 0) continue;
      const ov = c.threatRangeOverrides || {};
      const types = (CAPABILITY[d.system] || []).filter(tt => dist <= (ov[tt] ?? c.range_km));
      if (!types.length) continue;
      const op = d.operator || '';
      if (op !== 'United States' && op !== (t.country || '')) continue;   // default-disabled coverage
      cross.push({ id: d.id, system: d.system, quantity: d.quantity, notes: d.notes || '', operator: op,
        locationName: o.name, locationCountry: o.country || '',
        restrictToThreatTypes: types.length < (CAPABILITY[d.system] || []).length ? types : null, _dist: dist });
    }
  }
  cross.sort((a, b) => a._dist - b._dist);
  return [...own, ...cross];
}

function extractMag(engine, results) {
  const state = {};
  const walk = engine === 'old'
    ? results.byThreatType.flatMap(g => g.engagements)
    : newEngine.allEngagements(results);
  for (const e of walk) state[e.defId] = e.magazineRemaining;
  return state;
}

// ── Seeded rng (same mulberry32 as js/prng.js) ────────────────────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 0x100000000; };
}

// ── One combination on one engine ─────────────────────────────────────────────
/** Returns per attack: { targetId, leakers: {type: n}, used: {systemId: n} }. */
function runCombo(engine, laydown, attackFile, rng) {
  let mag = {};
  const out = [];
  for (const atk of attackFile.attacks) {
    const manifest = atk.platforms.map(p => ({ platformId: p.platformId, count: parseInt(p.quantity, 10) }));
    const dc = engine === 'old' ? oldDC : newDC;
    const defs = defensesFor(laydown, atk.targetId, dc);
    let results;
    if (engine === 'old') {
      const saved = Math.random; Math.random = rng;
      try { results = oldEngine.runSimulationCore(manifest, defs, mag, {}, oldEngFns, oldPC, oldDC); }
      finally { Math.random = saved; }
    } else {
      results = newEngine.runSimulationCore(manifest, defs, mag, {}, { pkTable, doctrine, defenseCatalog: newDC, platformCatalog: newPC, models: ENGAGEMENT_MODELS, rng });
    }
    mag = { ...mag, ...extractMag(engine, results) };
    const leakers = {}; for (const g of results.byThreatType) leakers[g.threatType] = g.finalCount;
    const used = {};
    const recs = engine === 'old' ? results.byThreatType.flatMap(g => g.engagements) : newEngine.allEngagements(results);
    for (const e of recs) used[e.systemId] = (used[e.systemId] || 0) + (e.interceptorsUsed || 0);
    out.push({ targetId: atk.targetId, leakers, used });
  }
  return out;
}

// ── Optional dump of one attack on both engines ───────────────────────────────
// --dump <laydownStem> <attackStem> <attackNumber>   prints every engagement row
const dumpIdx = args.indexOf('--dump');
if (dumpIdx >= 0) {
  const [ls, as_, num] = args.slice(dumpIdx + 1, dumpIdx + 4);
  const laydown    = ingestLaydown(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/batch/laydowns', ls + '.json'), 'utf8')));
  const attackFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/batch/attacks', as_ + '.json'), 'utf8'));
  const n = parseInt(num, 10) - 1;
  for (const engine of ['old', 'new']) {
    let mag = {};
    for (let i = 0; i <= n; i++) {
      const atk = attackFile.attacks[i];
      const manifest = atk.platforms.map(p => ({ platformId: p.platformId, count: parseInt(p.quantity, 10) }));
      const dc = engine === 'old' ? oldDC : newDC;
      const defs = defensesFor(laydown, atk.targetId, dc);
      let results;
      if (engine === 'old') { const saved = Math.random; Math.random = () => parseFloat(OLD_RNG ?? '0.5');
        try { results = oldEngine.runSimulationCore(manifest, defs, mag, {}, oldEngFns, oldPC, oldDC); } finally { Math.random = saved; } }
      else results = newEngine.runSimulationCore(manifest, defs, mag, {}, { pkTable, doctrine, defenseCatalog: newDC, platformCatalog: newPC, models: ENGAGEMENT_MODELS, rng: OLD_RNG != null ? () => parseFloat(OLD_RNG) : mulberry32(0) });
      mag = { ...mag, ...extractMag(engine, results) };
      if (i !== n) continue;
      console.log(`\n=== ${engine.toUpperCase()} engine — attack ${num} on ${atk.targetId}: ${manifest.map(m => m.count + '× ' + m.platformId).join(', ')}`);
      console.log('    defenses: ' + defs.map(d => `${d.id}(${d.system} q${d.quantity}${d.restrictToThreatTypes ? ' only ' + d.restrictToThreatTypes.join('/') : ''})`).join(', '));
      const recs = engine === 'old' ? results.byThreatType.flatMap(g => g.engagements.map(e => ({ ...e, platformId: '(type)' }))) : newEngine.allEngagements(results);
      for (const e of recs) console.log(`    ${e.threatType.padEnd(14)} ${String(e.platformId).padEnd(12)} ${e.systemId.padEnd(12)} ${e.defId.padEnd(22)} in=${String(e.threatsIn).padStart(3)} P=${(e.pk ?? 0).toFixed(3)} s=${e.shotsPerEngagement} mag ${e.magazineAtStart}->${e.magazineRemaining} killed=${e.killed} ${e.note || ''}`);
      for (const g of results.byThreatType) console.log(`    >> ${g.threatType}: ${g.initialCount} in, ${g.finalCount} leak`);
    }
  }
  process.exit(0);
}

// ── Main: two stages ─────────────────────────────────────────────────────────
// Stage 1 (pinned): both engines deterministic at the medium tier — catches
//   logic errors; small differences come from per-platform rounding.
// Stage 2 (mean):   new engine once vs legacy mean over SEEDS random seeds —
//   catches gross drift from the legacy expectation.
const laydownDir = path.join(ROOT, 'data/batch/laydowns');
const attackDir  = path.join(ROOT, 'data/batch/attacks');
const laydownFiles = fs.readdirSync(laydownDir).filter(f => f.toLowerCase().endsWith('.json')).sort();
const attackFiles  = fs.readdirSync(attackDir).filter(f => f.toLowerCase().endsWith('.json')).sort();

const maxShots = {};
for (const [sys, row] of Object.entries(pkTable.cells)) maxShots[sys] = Math.max(0, ...Object.values(row).map(c => c.shots || 0));

function runStage(pinned, tol) {
  let checks = 0, failures = 0, fixedChecks = 0, fixedFailures = 0;
  const pinnedRng = () => parseFloat(OLD_RNG);
  for (const lf of laydownFiles) {
    const laydown = ingestLaydown(JSON.parse(fs.readFileSync(path.join(laydownDir, lf), 'utf8')));
    for (const af of attackFiles) {
      const attackFile = JSON.parse(fs.readFileSync(path.join(attackDir, af), 'utf8'));
      const label = `${lf.replace(/\.json$/, '')} × ${af.replace(/\.json$/, '')}`;

      const nSeeds = pinned ? 1 : SEEDS;
      const sums = [];
      for (let s = 0; s < nSeeds; s++) {
        const r = runCombo('old', laydown, attackFile, pinned ? pinnedRng : mulberry32(s));
        r.forEach((a, i) => {
          sums[i] = sums[i] || { targetId: a.targetId, leakers: {}, used: {} };
          for (const [k, v] of Object.entries(a.leakers)) sums[i].leakers[k] = (sums[i].leakers[k] || 0) + v;
          for (const [k, v] of Object.entries(a.used))    sums[i].used[k]    = (sums[i].used[k]    || 0) + v;
        });
      }
      const oldMean = sums.map(a => ({ targetId: a.targetId,
        leakers: Object.fromEntries(Object.entries(a.leakers).map(([k, v]) => [k, v / nSeeds])),
        used:    Object.fromEntries(Object.entries(a.used).map(([k, v]) => [k, v / nSeeds])) }));

      // New engine: pinned once, or averaged over the same seeds (its only
      // random element is a shot roll such as THAAD's).
      const nSums = [];
      for (let s = 0; s < nSeeds; s++) {
        const r = runCombo('new', laydown, attackFile, pinned ? pinnedRng : mulberry32(s));
        r.forEach((a, i) => {
          nSums[i] = nSums[i] || { targetId: a.targetId, leakers: {}, used: {} };
          for (const [k, v] of Object.entries(a.leakers)) nSums[i].leakers[k] = (nSums[i].leakers[k] || 0) + v;
          for (const [k, v] of Object.entries(a.used))    nSums[i].used[k]    = (nSums[i].used[k]    || 0) + v;
        });
      }
      const neu = nSums.map(a => ({ targetId: a.targetId,
        leakers: Object.fromEntries(Object.entries(a.leakers).map(([k, v]) => [k, v / nSeeds])),
        used:    Object.fromEntries(Object.entries(a.used).map(([k, v]) => [k, v / nSeeds])) }));

      const problems = [];
      neu.forEach((a, i) => {
        const o = oldMean[i];
        for (const t of new Set([...Object.keys(a.leakers), ...Object.keys(o.leakers)])) {
          checks++;
          const d = (a.leakers[t] || 0) - (o.leakers[t] || 0);
          if (Math.abs(d) > tol) { failures++; problems.push(`attack ${i + 1} ${a.targetId} ${t}: leakers new ${(a.leakers[t] || 0).toFixed(2)} vs old ${(o.leakers[t] || 0).toFixed(2)}`); }
        }
        for (const sys of new Set([...Object.keys(a.used), ...Object.keys(o.used)])) {
          checks++;
          const d = (a.used[sys] || 0) - (o.used[sys] || 0);
          // Interceptor tolerance is at least one engagement's worth of rounds
          // for the system (a Phalanx burst is 150 rounds), so a late layer
          // that fires in some seeds and not others is judged in engagements.
          const sysTol = Math.max(tol, maxShots[sys] || 0);
          if (Math.abs(d) > sysTol) { failures++; problems.push(`attack ${i + 1} ${a.targetId} ${sys}: interceptors new ${(a.used[sys] || 0).toFixed(1)} vs old ${(o.used[sys] || 0).toFixed(2)}`); }
          if (pinned && FIXED.has(sys)) { fixedChecks++; if (Math.abs(d) > 0.5) fixedFailures++; }
        }
      });
      console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${label}${problems.length ? '\n      ' + problems.join('\n      ') : ''}`);
    }
  }
  return { checks, failures, fixedChecks, fixedFailures };
}

console.log(`\n[parity] stage 1 — both engines pinned to the medium tier, tolerance ±${TOL_PINNED}`);
const s1 = runStage(true, TOL_PINNED);
console.log(`[parity] stage 1: ${s1.checks} comparisons, ${s1.failures} outside ±${TOL_PINNED}; fixed-Pk systems ${s1.fixedChecks} compared, ${s1.fixedFailures} not exact`);

console.log(`\n[parity] stage 2 — both engines averaged over ${SEEDS} seeds (legacy: tier + shot rolls; new: shot rolls only), tolerance ±${TOL_MEAN}`);
const s2 = runStage(false, TOL_MEAN);
console.log(`[parity] stage 2: ${s2.checks} comparisons, ${s2.failures} outside ±${TOL_MEAN}`);

const ok = s1.failures === 0 && s1.fixedFailures === 0 && s2.failures === 0;
console.log(`\n[parity] ${ok ? 'PASS' : 'FAIL'} (old ref ${OLD_REF})`);
process.exit(ok ? 0 : 1);
