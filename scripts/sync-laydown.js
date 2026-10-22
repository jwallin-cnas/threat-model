#!/usr/bin/env node
/**
 * sync-laydown.js — Replace data/defaults.json with the authoritative Blue
 * laydown, after validating it.
 *
 * The source is a laydown file in the Blue Builder export format
 * ({ version, name, defaults: { targetId: [entries] } }), given as a local
 * path or a URL. A Box shared link set to "People with the link" works: a
 * page link (https://<host>.box.com/s/<id>) is turned into its direct
 * download form (/shared/static/<id>) automatically.
 *
 * Checks (any failure leaves data/defaults.json untouched, exit code 1):
 *   • the download is JSON, not a Box sign-in or preview page
 *   • `defaults` is a non-empty object of target id → array of entries
 *   • every target id exists in data/targets.json
 *   • every entry has id, system, quantity, operator; only the known fields
 *     id, system, quantity, notes, operator, chips, disabled (legacy: reloads)
 *   • system exists in data/defenses.json; quantity is an integer ≥ 1;
 *     chips is a number ≥ 0 when present; operator is a non-empty string
 *   • entry ids are unique, except a shared patrol id (shared_<system>),
 *     which may be listed at several targets
 *
 * Output: data/defaults.json keeps its version and _instructions block; its
 * `defaults` becomes the source's (legacy `reloads` written as `chips`).
 * Nothing is written when the laydown is unchanged.
 *
 * Usage:
 *   node scripts/sync-laydown.js <path-or-url> [--check] [--summary FILE]
 *     --check      validate and report only; never write
 *     --summary    write a commit message (title + per-target changes) to FILE
 *
 * In GitHub Actions it also sets the step output `changed=true|false`.
 * The source URL is never printed (it is a secret).
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT          = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS_PATH = path.join(ROOT, 'data', 'defaults.json');
const TARGETS_PATH  = path.join(ROOT, 'data', 'targets.json');
const DEFENSES_PATH = path.join(ROOT, 'data', 'defenses.json');
const ENTRY_FIELDS  = ['id', 'system', 'quantity', 'notes', 'operator', 'chips', 'disabled'];

const args    = process.argv.slice(2);
const source  = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--summary');
const CHECK   = args.includes('--check');
const summaryIdx  = args.indexOf('--summary');
const SUMMARY = summaryIdx >= 0 ? args[summaryIdx + 1] : null;

function fail(msg, details = []) {
  console.error(`[sync-laydown] ${msg}`);
  for (const d of details) console.error(`  • ${d}`);
  setOutput('changed', 'false');
  process.exit(1);
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/** Box page link → direct download link; any other URL is returned as is. */
function directBoxUrl(url) {
  const u = new URL(url);
  const m = /^\/s\/([A-Za-z0-9]+)\/?$/.exec(u.pathname);
  if (/(^|\.)box\.com$/i.test(u.hostname) && m) return `${u.origin}/shared/static/${m[1]}`;
  return url;
}

async function readSource(src) {
  if (/^https?:\/\//i.test(src)) {
    let res;
    try {
      res = await fetch(directBoxUrl(src), { redirect: 'follow', headers: { Accept: 'application/json, */*' } });
    } catch (err) {
      fail(`Download failed: ${err.message}`);
    }
    if (!res.ok) fail(`Download failed: HTTP ${res.status}. Check that the Box link is set to "People with the link".`);
    return res.text();
  }
  if (!fs.existsSync(src)) fail(`File not found: ${src}`);
  return fs.readFileSync(src, 'utf8');
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function validate(data, targets, systems) {
  const errors = [], warnings = [];
  const defaults = data && typeof data === 'object' ? data.defaults : null;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return { errors: ['The file has no "defaults" object (expected the Blue Builder export format).'], warnings, out: null };
  }
  const out = {};
  const seen = new Map();          // id → targetId (non-shared ids)
  const sharedChips = new Map();   // shared id → Set of chip totals
  let entries = 0;
  for (const [targetId, list] of Object.entries(defaults)) {
    if (!targets.has(targetId)) { errors.push(`Unknown target "${targetId}"`); continue; }
    if (!Array.isArray(list))   { errors.push(`Target "${targetId}": expected a list of entries`); continue; }
    out[targetId] = [];
    list.forEach((e, i) => {
      const where = `${targets.get(targetId)} (${targetId}) entry ${i + 1}`;
      if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(`${where}: not an object`); return; }
      const extra = Object.keys(e).filter(k => !ENTRY_FIELDS.includes(k) && k !== 'reloads');
      if (extra.length) errors.push(`${where}: unknown field(s) ${extra.join(', ')}`);
      if (typeof e.id !== 'string' || !e.id)               errors.push(`${where}: missing "id"`);
      const sys = systems.get(e.system);
      if (!sys)                                             errors.push(`${where}: unknown system "${e.system}"`);
      if (!Number.isInteger(e.quantity) || e.quantity < 1)  errors.push(`${where}: quantity must be a whole number ≥ 1 (got ${JSON.stringify(e.quantity)})`);
      if (typeof e.operator !== 'string' || !e.operator)    errors.push(`${where}: missing "operator"`);
      if (e.notes != null && typeof e.notes !== 'string')   errors.push(`${where}: "notes" must be text`);
      if (e.disabled != null && typeof e.disabled !== 'boolean') errors.push(`${where}: "disabled" must be true or false`);
      const chips = e.chips ?? e.reloads;
      if (chips != null && !(typeof chips === 'number' && Number.isFinite(chips) && chips >= 0)) {
        errors.push(`${where}: chips must be a number ≥ 0 (got ${JSON.stringify(chips)})`);
      }
      if (e.chips != null && e.reloads != null) warnings.push(`${where}: both "chips" and legacy "reloads" given — using chips`);

      const isShared = sys?.shared && e.id === `shared_${e.system}`;
      if (typeof e.id === 'string' && e.id) {
        if (isShared) {
          if (!sharedChips.has(e.id)) sharedChips.set(e.id, new Set());
          sharedChips.get(e.id).add(chips ?? 1);
        } else if (seen.has(e.id)) {
          errors.push(`${where}: id "${e.id}" is already used at ${seen.get(e.id)}`);
        } else {
          seen.set(e.id, targetId);
        }
      }
      const entry = { id: e.id, system: e.system, quantity: e.quantity, notes: e.notes ?? '', operator: e.operator };
      if (chips != null) entry.chips = chips;
      if (e.disabled === true) entry.disabled = true;
      out[targetId].push(entry);
      entries++;
    });
    if (out[targetId].length === 0) delete out[targetId];
  }
  for (const [id, totals] of sharedChips) {
    if (totals.size > 1) warnings.push(`Shared asset "${id}" is listed with different chips (${[...totals].join(', ')}); the tool will use one pool`);
  }
  if (entries === 0 && errors.length === 0) errors.push('The laydown has no entries.');
  return { errors, warnings, out };
}

/** Human-readable per-target differences for the commit message. */
function describeChanges(oldDefaults, newDefaults, targetNames, systemNames) {
  const lines = [];
  const label = e => `${systemNames.get(e.system) || e.system} (${e.operator})`;
  const fmt   = e => `qty ${e.quantity}, ${e.chips ?? 1} chip${(e.chips ?? 1) === 1 ? '' : 's'}${e.notes ? `, "${e.notes}"` : ''}`;
  const ids = new Set([...Object.keys(oldDefaults), ...Object.keys(newDefaults)]);
  for (const t of [...targetNames.keys()].filter(t => ids.has(t)).concat([...ids].filter(t => !targetNames.has(t)))) {
    const before = new Map((oldDefaults[t] || []).map(e => [e.id, e]));
    const after  = new Map((newDefaults[t] || []).map(e => [e.id, e]));
    const name = targetNames.get(t) || t;
    for (const [id, e] of after) {
      const o = before.get(id);
      if (!o) lines.push(`${name}: added ${label(e)}, ${fmt(e)}`);
      else if (JSON.stringify(o) !== JSON.stringify(e)) lines.push(`${name}: ${label(e)} ${fmt(o)} → ${fmt(e)}`);
    }
    for (const [id, e] of before) if (!after.has(id)) lines.push(`${name}: removed ${label(e)}`);
  }
  return lines;
}

// ── Main ─────────────────────────────────────────────────────────────────────
if (!source) fail('Usage: node scripts/sync-laydown.js <path-or-url> [--check] [--summary FILE]');

const text = await readSource(source);
if (/^\s*</.test(text)) {
  fail('The download is a web page, not a laydown file. Check that the Box link is shared with "People with the link" and that the file itself (not its folder) is shared.');
}
let data;
try { data = JSON.parse(text); }
catch (err) { fail(`The download is not valid JSON: ${err.message}`); }

const targetsArr  = readJson(TARGETS_PATH).targets || [];
const targetNames = new Map(targetsArr.map(t => [t.id, t.name]));
const systemsArr  = readJson(DEFENSES_PATH).systems || [];
const systems     = new Map(systemsArr.map(s => [s.id, s]));
const systemNames = new Map(systemsArr.map(s => [s.id, s.name]));

const { errors, warnings, out } = validate(data, targetNames, systems);
for (const w of warnings) console.warn(`[sync-laydown] warning: ${w}`);
if (errors.length) fail(`The laydown failed validation (${errors.length} problem${errors.length !== 1 ? 's' : ''}); data/defaults.json is unchanged:`, errors);

const current = readJson(DEFAULTS_PATH);
const nEntries = Object.values(out).reduce((n, l) => n + l.length, 0);
if (JSON.stringify(current.defaults) === JSON.stringify(out)) {
  console.log(`[sync-laydown] Valid: ${Object.keys(out).length} locations, ${nEntries} systems. Unchanged — nothing to do.`);
  setOutput('changed', 'false');
  process.exit(0);
}

const changes = describeChanges(current.defaults || {}, out, targetNames, systemNames);
console.log(`[sync-laydown] Valid: ${Object.keys(out).length} locations, ${nEntries} systems. ${changes.length} change${changes.length !== 1 ? 's' : ''}:`);
for (const c of changes) console.log(`  ${c}`);

if (CHECK) { setOutput('changed', 'false'); process.exit(0); }

const next = { version: current.version || '1.0', ...(current._instructions ? { _instructions: current._instructions } : {}), defaults: out };
fs.writeFileSync(DEFAULTS_PATH, JSON.stringify(next, null, 2) + '\n');
console.log('[sync-laydown] Wrote data/defaults.json');
if (SUMMARY) {
  const title = `Sync default laydown from Box (${changes.length} change${changes.length !== 1 ? 's' : ''})`;
  fs.writeFileSync(SUMMARY, `${title}\n\n${changes.map(c => `- ${c}`).join('\n')}\n`);
}
setOutput('changed', 'true');
