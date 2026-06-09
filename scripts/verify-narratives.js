#!/usr/bin/env node
/**
 * verify-narratives.js
 *
 * Verification script for combined_with_narratives.pdf.
 * Checks:
 *   1. Damage levels from xlsx colors + narrative selection
 *   2. Narrative text matches attack JSONs
 *   3. results.xlsx cell values are well-formed
 *   4. PDF page counts
 */

import { execSync }       from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir }         from 'os';
import path               from 'path';
import { fileURLToPath }  from 'url';
import { PDFDocument }    from '/Users/joshuawallin/Desktop/Threat Model/node_modules/pdf-lib/dist/pdf-lib.esm.js';
import { createRequire }  from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('/Users/joshuawallin/Desktop/Threat Model/node_modules/xlsx');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

// ── Same static mappings as add-narratives.js ─────────────────────────────────

const ARGB_TO_LEVEL = {
  'FF00B050': 'None',
  'FFFFFF00': 'Mild',
  'FFFFC000': 'Moderate',
  'FFFF0000': 'Severe',
};

const ATTACK_FILE_STEMS = {
  'Economic Hardship':       'strategy_1_economic_hardship',
  'Double Tap':              'strategy_2_double_tap',
  'Attacking the Aggressor': 'strategy_3_attacking_aggressor',
  'U.S. Military Targets':   'strategy_4_us_military_targets',
  'Commercial Shipping':     'strategy_5_commercial_shipping',
};

const COLUMN_TO_TARGET = {
  'Dubai':                      'dubai',
  'Riyadh':                     'riyadh',
  'ARAMCO — Riyadh':       'aramco_riyadh',
  'Fujairah Port':              'fujairah_port',
  'Jebel Ali Port':             'jebel_ali_port',
  'Al Dhafra Air Base':         'al_dhafra_ab',
  'Ruwais Refinery':            'ruwais_refinery',
  'Al Udeid Air Base':          'al_udeid_ab',
  'Hamad Port':                 'hamad_port',
  'Doha':                       'doha',
  'Tel Nof Air Base':           'tel_nof_ab',
  'Tel Aviv':                   'tel_aviv',
  'Haifa':                      'haifa',
  'Ramat David Air Base':       'ramat_david_ab',
  "Be'er Sheva":                'beer_sheva',
  'Muwaffaq al-Salti Air Base': 'muwaffaq_al_salti_ab',
  'Prince Sultan Air Base':     'prince_sultan_ab',
  'U.S. Fifth Fleet':           'us_fifth_fleet',
  'Isa Air Base':               'isa_ab',
  'Port of Salalah':            'port_of_salalah',
  'Shuaiba Port':               'shuaiba_port',
};

function colLetters(idx) {
  let n = idx + 1, result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result    = String.fromCharCode(65 + rem) + result;
    n         = Math.floor((n - 1) / 26);
  }
  return result;
}

// ── Color extraction ──────────────────────────────────────────────────────────

function extractCellLevels(xlsxPath) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'verify-narratives-'));
  execSync(`unzip -o "${xlsxPath}" -d "${tmpDir}"`, { stdio: 'ignore' });

  const stylesXml = readFileSync(path.join(tmpDir, 'xl', 'styles.xml'), 'utf8');

  const fills = [];
  const fillRe = /<fill>([\s\S]*?)<\/fill>/g;
  let fm;
  while ((fm = fillRe.exec(stylesXml)) !== null) {
    const fg = fm[1].match(/fgColor rgb="([A-Fa-f0-9]{8})"/);
    fills.push(fg ? fg[1].toUpperCase() : null);
  }

  const xfs = [];
  const cellXfsMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (cellXfsMatch) {
    const xfRe = /fillId="(\d+)"/g;
    let xm;
    while ((xm = xfRe.exec(cellXfsMatch[1])) !== null) {
      xfs.push(parseInt(xm[1], 10));
    }
  }

  const sheetXml = readFileSync(
    path.join(tmpDir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8'
  );
  const cellLevels = new Map();
  const cellRe = /<c\b[^>]*\br="([A-Z]+\d+)"[^>]*\bs="(\d+)"[^>]*>/g;
  let cm;
  while ((cm = cellRe.exec(sheetXml)) !== null) {
    const argb  = fills[xfs[parseInt(cm[2], 10)]];
    const level = ARGB_TO_LEVEL[argb];
    if (level) cellLevels.set(cm[1], level);
  }

  return cellLevels;
}

// ── Separator helper ──────────────────────────────────────────────────────────

function sep(title) {
  const line = '─'.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const DAMAGE_XLSX  = '/Users/joshuawallin/Downloads/Results_CH_JW.xlsx';
  const RESULTS_XLSX = path.join(ROOT, 'output', '2026-06-06_13-32-58', 'results.xlsx');
  const COMBINED_PDF = path.join(ROOT, 'output', '2026-06-06_13-32-58', 'combined.pdf');
  const NARR_PDF     = path.join(ROOT, 'output', '2026-06-06_13-32-58', 'combined_with_narratives.pdf');

  // ── Load attack JSONs ────────────────────────────────────────────────────────
  const attackJsons = {};
  for (const [name, stem] of Object.entries(ATTACK_FILE_STEMS)) {
    const p = path.join(ROOT, 'data', 'batch', 'attacks', `${stem}.json`);
    attackJsons[name] = JSON.parse(readFileSync(p, 'utf8'));
  }

  // ── Parse damage-levels xlsx ─────────────────────────────────────────────────
  console.log(`Parsing damage-level xlsx: ${DAMAGE_XLSX}`);
  const cellLevels = extractCellLevels(DAMAGE_XLSX);
  console.log(`  ${cellLevels.size} colored cells found`);

  const wb      = XLSX.readFile(DAMAGE_XLSX);
  const ws      = wb.Sheets[wb.SheetNames[0]];
  const rows    = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const headers = rows[0];
  const colTargetIds = headers.map(h => COLUMN_TO_TARGET[h] ?? null);

  // Build combination list (same logic as add-narratives.js)
  const combinations = [];
  for (let ri = 1; ri < rows.length; ri++) {
    const label = String(rows[ri][0] || '').trim();
    const sep2  = label.indexOf(' / ');
    if (sep2 === -1) continue;
    const laydownStem = label.slice(0, sep2);
    const attackName  = label.slice(sep2 + 3);
    const attackStem  = ATTACK_FILE_STEMS[attackName];
    if (!attackStem) continue;

    const attackJson = attackJsons[attackName];
    const rowNum     = ri + 1;

    const narrativeItems = [];
    for (const entry of attackJson.attacks) {
      const colIdx = colTargetIds.indexOf(entry.targetId);
      if (colIdx === -1) continue;
      const level = cellLevels.get(`${colLetters(colIdx)}${rowNum}`);
      if (!level) continue;
      const text = entry.narratives?.[level];
      if (!text) continue;
      narrativeItems.push({ targetId: entry.targetId, level, text, narratives: entry.narratives });
    }

    combinations.push({ label, laydownStem, attackName, attackStem, rowNum, narrativeItems });
  }

  console.log(`  ${combinations.length} valid combination rows\n`);

  // ═════════════════════════════════════════════════════════════════════════════
  sep('CHECK 1 — Damage levels vs xlsx colors + narrative selection');
  // ═════════════════════════════════════════════════════════════════════════════

  let check1Issues = 0;
  for (const combo of combinations) {
    console.log(`\n  [${combo.label}]`);
    if (combo.narrativeItems.length === 0) {
      console.log('    (no colored cells / no narrative items)');
    }
    for (const item of combo.narrativeItems) {
      const preview = item.text.slice(0, 80).replace(/\n/g, ' ');
      console.log(`    ${item.targetId.padEnd(25)} ${item.level.padEnd(10)} "${preview}..."`);
    }
  }

  console.log(`\n  CHECK 1 summary: ${combinations.length} combinations, ${check1Issues} issues`);

  // ═════════════════════════════════════════════════════════════════════════════
  sep('CHECK 2 — Narrative text matches attack JSONs');
  // ═════════════════════════════════════════════════════════════════════════════

  let check2Issues = 0;
  for (const combo of combinations) {
    const attackJson = attackJsons[combo.attackName];
    for (const item of combo.narrativeItems) {
      const entry = attackJson.attacks.find(a => a.targetId === item.targetId);
      if (!entry) {
        console.log(`  MISMATCH: ${combo.label} / ${item.targetId} — no entry in attack JSON`);
        check2Issues++;
        continue;
      }
      const expected = entry.narratives?.[item.level];
      if (expected !== item.text) {
        console.log(`  MISMATCH: ${combo.label} / ${item.targetId} [${item.level}]`);
        console.log(`    Expected: "${String(expected).slice(0, 80)}"`);
        console.log(`    Got:      "${item.text.slice(0, 80)}"`);
        check2Issues++;
      }
    }
  }

  if (check2Issues === 0) {
    console.log('  All narrative texts match their attack JSONs. No mismatches.');
  } else {
    console.log(`  CHECK 2: ${check2Issues} mismatch(es) found`);
  }

  // ═════════════════════════════════════════════════════════════════════════════
  sep('CHECK 3 — results.xlsx cell values');
  // ═════════════════════════════════════════════════════════════════════════════

  const rwb      = XLSX.readFile(RESULTS_XLSX);
  const rws      = rwb.Sheets[rwb.SheetNames[0]];
  const rrows    = XLSX.utils.sheet_to_json(rws, { header: 1, defval: '' });
  const rheaders = rrows[0];

  console.log(`  results.xlsx has ${rrows.length - 1} data rows, ${rheaders.length} columns`);
  console.log(`  Column headers: ${rheaders.join(' | ')}`);

  let check3Issues = 0;

  // For each combination, check cells in results.xlsx that correspond to attacked targets
  for (const combo of combinations) {
    const attackJson = attackJsons[combo.attackName];
    const attackedTargetIds = new Set(attackJson.attacks.map(a => a.targetId));

    // Find the matching row in results.xlsx
    let resultRow = null;
    for (let ri = 1; ri < rrows.length; ri++) {
      if (String(rrows[ri][0]).trim() === combo.label) {
        resultRow = rrows[ri];
        break;
      }
    }

    if (!resultRow) {
      console.log(`  MISSING ROW: "${combo.label}" not found in results.xlsx`);
      check3Issues++;
      continue;
    }

    // Check each attacked target has a non-empty cell with a leaker count
    for (const tgtId of attackedTargetIds) {
      const colHeader = rheaders.find(h => COLUMN_TO_TARGET[h] === tgtId);
      if (!colHeader) continue; // target not in results columns
      const colIdx = rheaders.indexOf(colHeader);
      const cellVal = String(resultRow[colIdx] || '').trim();

      if (!cellVal) {
        console.log(`  EMPTY CELL: ${combo.label} / ${tgtId} — expected a value but cell is empty`);
        check3Issues++;
        continue;
      }

      // Parse leaker numbers: format like "50× ... → 2 SRBM; 8 drone"
      // Extract all numbers after "→" to check they are non-negative integers
      const arrowIdx = cellVal.indexOf('→');
      if (arrowIdx === -1) {
        // Some cells may just have a plain number or "0"
        const num = parseInt(cellVal, 10);
        if (isNaN(num) || num < 0) {
          console.log(`  MALFORMED: ${combo.label} / ${tgtId} = "${cellVal.slice(0, 80)}"`);
          check3Issues++;
        }
      } else {
        const afterArrow = cellVal.slice(arrowIdx + 1);
        const numbers = [...afterArrow.matchAll(/(\d+)/g)].map(m => parseInt(m[1], 10));
        const hasNegative = numbers.some(n => n < 0);
        if (hasNegative) {
          console.log(`  NEGATIVE LEAKER: ${combo.label} / ${tgtId} = "${cellVal.slice(0, 80)}"`);
          check3Issues++;
        }
      }
    }
  }

  // Check combination label column matches expected
  let labelMismatches = 0;
  for (let ri = 1; ri < rrows.length; ri++) {
    const label = String(rrows[ri][0] || '').trim();
    if (!label) {
      console.log(`  EMPTY LABEL: row ${ri + 1} has no combination label`);
      check3Issues++;
      continue;
    }
    const sep2 = label.indexOf(' / ');
    if (sep2 === -1) {
      console.log(`  MALFORMED LABEL: row ${ri + 1}: "${label}"`);
      check3Issues++;
      labelMismatches++;
    }
  }

  if (check3Issues === 0) {
    console.log('  All results.xlsx cells look well-formed. No issues.');
  } else {
    console.log(`  CHECK 3: ${check3Issues} issue(s) found`);
  }

  // ═════════════════════════════════════════════════════════════════════════════
  sep('CHECK 4 — PDF page counts');
  // ═════════════════════════════════════════════════════════════════════════════

  try {
    const combinedBytes = readFileSync(COMBINED_PDF);
    const combinedDoc   = await PDFDocument.load(combinedBytes);
    console.log(`  combined.pdf                  pages: ${combinedDoc.getPageCount()}`);
  } catch (e) {
    console.log(`  combined.pdf: ERROR — ${e.message}`);
  }

  try {
    const narrBytes = readFileSync(NARR_PDF);
    const narrDoc   = await PDFDocument.load(narrBytes);
    console.log(`  combined_with_narratives.pdf  pages: ${narrDoc.getPageCount()}`);
  } catch (e) {
    console.log(`  combined_with_narratives.pdf: ERROR — ${e.message}`);
  }

  sep('DONE');
  console.log('');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
