#!/usr/bin/env node
/**
 * apply-reloads.js — One-shot migration script.
 *
 * Reads reload counts from "Loadout Laydowns" xlsx and writes them into
 * all six laydown JSON files (defaults.json + five strategy files).
 *
 * Rules:
 *   • defaults.json        ← Base sheet values only
 *   • strategy_N_*.json    ← Strategy N value if present, else Base value;
 *                            if neither is present the existing JSON value
 *                            is left unchanged
 *   • Values are NOT additive — the spreadsheet value is the total reload
 *     count, not a delta on top of anything else
 *
 * Usage:
 *   node scripts/apply-reloads.js [path-to-xlsx]
 *   node scripts/apply-reloads.js          # defaults to ~/Downloads/Loadout Laydowns (1).xlsx
 */

import XLSXModule from 'xlsx';
const XLSX = XLSXModule;
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

// ── Spreadsheet column name → JSON system ID ──────────────────────────────────

const SYSTEM_MAP = {
  'THAAD':               'thaad',
  'Patriot':             'patriot',
  'Arrow 2/3':           'arrow',
  "David's Sling":       'davids_sling',
  'Iron Dome':           'iron_dome',
  'Cheongung II':        'cheongung2',
  'NASAMs':              'nasams',
  'MEROPS':              'merops',
  'FS-LIDS':             'fslids',
  'IFPC-2':              'ifpc2',
  'M-SHORAD':            'm_shorad',
  'HPM':                 'high_powered_microwave',
  'Containerized Laser': 'containerized_laser',
  'Centurion C-RAM':     'phalanx_cram',
  'Tactical Jammer':     'tactical_jammer',
};

// ── Spreadsheet location name → JSON targetId ─────────────────────────────────

const LOCATION_MAP = {
  'Manama':                                         'manama',
  'U.S. Fifth Fleet':                               'us_fifth_fleet',
  'Isa AB':                                         'isa_ab',
  'Baghdad':                                        'baghdad',
  'Basra':                                          'basra',
  'Mosul':                                          'mosul',
  'Erbil AB':                                       'erbil_ab',
  'Al Asad AB':                                     'al_asad_ab',
  'Rumaila Oil Field':                              'rumaila_oil_field',
  'Lanaz Refinery':                                 'lanaz_refinery',
  'Tel Aviv':                                       'tel_aviv',
  'Haifa':                                          'haifa',
  'Jerusalem':                                      'jerusalem',
  "Be'er Sheva":                                    'beer_sheva',
  'Tel Nof AB':                                     'tel_nof_ab',
  'Ramat David AB':                                 'ramat_david_ab',
  'Hatzerim AB':                                    'hatzerim_ab',
  'Nevatim AB':                                     'nevatim_ab',
  'Amman':                                          'amman',
  'Muwaffaq al Salti AB':                           'muwaffaq_al_salti_ab',
  'King Faisal AB':                                 'king_faisal_ab',
  'King Khalid AB':                                 'king_khalid_ab',
  'Kuwait City':                                    'kuwait_city',
  'Shuaiba Port':                                   'shuaiba_port',
  'Burgan Oil Field':                               'burgan_oil_field',
  'Camp Buehring':                                  'camp_buehring',
  'Ali Al Salem AB':                                'ali_al_salem_ab',
  'Ahmed Al Jaber AB':                              'ahmed_al_jaber_ab',
  'Camp Arifjan':                                   'camp_arifjan',
  'Mohammed al Ahmed Naval Base':                   'mohammed_al_ahmed_naval_base',
  'Muscat':                                         'muscat',
  'Masirah AB':                                     'masirah_ab',
  'Thumrait AB':                                    'thumrait_ab',
  'Port of Salalah':                                'port_of_salalah',
  'Duqm Port':                                      'duqm_port',
  'Doha':                                           'doha',
  'Hamad Port':                                     'hamad_port',
  'Al Udeid AB':                                    'al_udeid_ab',
  'Ras Laffan LNG Facility':                        'ras_laffan_lng',
  'Riyadh':                                         'riyadh',
  'Dammam':                                         'dammam',
  'Jeddah':                                         'jeddah',
  'Prince Sultan AB':                               'prince_sultan_ab',
  'ARAMCO - Persian Gulf Corridor':                 'aramco_persian_gulf_corridor',
  'ARAMCO - Riyadh':                                'aramco_riyadh',
  'ARAMCO-Red Sea Corridor':                        'aramco_red_sea_corridor',
  'Ruwais Refinery':                                'ruwais_refinery',
  'Upper Zakum Oil Field':                          'upper_zakum_oil_field',
  'Murban Bab and Hashah Oil and Gas Facilities':   'murban_bab_hashah',
  'Fujairah Port':                                  'fujairah_port',
  'Dubai':                                          'dubai',
  'Abu Dhabi':                                      'abu_dhabi',
  'Al Dhafra AB':                                   'al_dhafra_ab',
  'Jebel Ali Port':                                 'jebel_ali_port',
};

// ── Target JSON files ─────────────────────────────────────────────────────────

const LAYDOWN_FILES = [
  {
    file:  path.join(ROOT, 'data', 'defaults.json'),
    sheet: 'Base',
  },
  {
    file:  path.join(ROOT, 'data', 'batch', 'laydowns', 'strategy_1_gulf_coast_merged.json'),
    sheet: 'Strategy 1',
  },
  {
    file:  path.join(ROOT, 'data', 'batch', 'laydowns', 'strategy_2_us_allied_bases_merged.json'),
    sheet: 'Strategy 2',
  },
  {
    file:  path.join(ROOT, 'data', 'batch', 'laydowns', 'strategy_3_proxy_wall_merged.json'),
    sheet: 'Strategy 3',
  },
  {
    file:  path.join(ROOT, 'data', 'batch', 'laydowns', 'strategy_4_defend_israel_merged.json'),
    sheet: 'Strategy 4',
  },
  {
    file:  path.join(ROOT, 'data', 'batch', 'laydowns', 'strategy_5_hedge_merged.json'),
    sheet: 'Strategy 5',
  },
];

// ── Parse a worksheet → Map<targetId, Map<systemId, reloadCount>> ─────────────

function parseSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rows.length < 2) return new Map();

  const headers = rows[0];
  const locCol  = headers.indexOf('Location');
  if (locCol === -1) throw new Error('No "Location" column found in sheet');

  // Build col → systemId index
  const systemCols = {};
  for (let c = 0; c < headers.length; c++) {
    const sysId = SYSTEM_MAP[String(headers[c]).trim()];
    if (sysId) systemCols[c] = sysId;
  }

  const result = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row      = rows[r];
    const locName  = String(row[locCol] || '').trim();
    const targetId = LOCATION_MAP[locName];
    if (!targetId) continue;

    const sysMap = new Map();
    for (const [col, sysId] of Object.entries(systemCols)) {
      const raw = row[col];
      if (raw === '' || raw === null || raw === undefined) continue;
      const n = Number(raw);
      if (!isNaN(n) && n > 0) sysMap.set(sysId, n);
    }
    if (sysMap.size > 0) result.set(targetId, sysMap);
  }
  return result;
}

// ── Merge base + strategy maps (strategy overrides base) ──────────────────────

function mergeWithBase(baseMap, stratMap) {
  const merged = new Map();
  // Start with all base entries
  for (const [tid, sysMap] of baseMap) {
    merged.set(tid, new Map(sysMap));
  }
  // Overlay strategy values
  for (const [tid, stratSysMap] of stratMap) {
    const existing = merged.get(tid) || new Map();
    for (const [sysId, count] of stratSysMap) {
      existing.set(sysId, count);
    }
    merged.set(tid, existing);
  }
  return merged;
}

// ── Apply effective reload map to a laydown JSON object ───────────────────────

function applyReloads(laydown, effectiveMap) {
  let updated  = 0;
  let skipped  = 0;

  for (const [targetId, entries] of Object.entries(laydown.defaults)) {
    const sysMap = effectiveMap.get(targetId);
    for (const entry of entries) {
      const count = sysMap?.get(entry.system);
      if (count !== undefined) {
        if (entry.reloads !== count) {
          entry.reloads = count;
          updated++;
        }
      } else {
        skipped++;
      }
    }
  }
  return { updated, skipped };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const xlsxPath = process.argv[2]
  || path.join(os.homedir(), 'Downloads', 'Loadout Laydowns (1).xlsx');

console.log(`[apply-reloads] Reading xlsx: ${xlsxPath}`);
if (!fs.existsSync(xlsxPath)) {
  console.error(`[apply-reloads] File not found: ${xlsxPath}`);
  process.exit(1);
}

const wb      = XLSX.readFile(xlsxPath);
const baseMap = parseSheet(wb.Sheets['Base']);

console.log(`[apply-reloads] Base sheet: ${baseMap.size} locations with reload data\n`);

for (const { file, sheet } of LAYDOWN_FILES) {
  const isBase      = sheet === 'Base';
  const stratSheet  = wb.Sheets[sheet];

  if (!stratSheet) {
    console.warn(`[${sheet}] Sheet not found in workbook — skipping`);
    continue;
  }

  const effectiveMap = isBase
    ? baseMap
    : mergeWithBase(baseMap, parseSheet(stratSheet));

  const laydown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { updated, skipped } = applyReloads(laydown, effectiveMap);

  fs.writeFileSync(file, JSON.stringify(laydown, null, 2) + '\n', 'utf8');
  console.log(`[${sheet}]  ${path.basename(file)}`);
  console.log(`           ${updated} reloads updated, ${skipped} entries not in spreadsheet (left unchanged)`);
}

console.log('\n[apply-reloads] Done.');
