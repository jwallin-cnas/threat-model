#!/usr/bin/env node
/**
 * update-narrative-titles.js
 *
 * Produces combined_with_narratives_update.pdf — identical to
 * combined_with_narratives.pdf except:
 *
 *   • Defensive Laydown titles reformatted as "Gulf Coast (Strategy 1)"
 *   • Attack Strategy titles reformatted as "Economic Hardship (Strategy 1)"
 *   • Both subtitle lines on the title page are the same font size
 *   • Narrative page headers use the same reformatted names
 *   • Bookmarks match the new titling
 *   • "merged" is removed from all laydown display names
 *
 * All content (simulation report) pages are copied unchanged from the
 * existing individual PDFs in the output directory.
 * Damage levels and narratives are re-drawn from the same sources as
 * add-narratives.js.
 *
 * Usage:
 *   node scripts/update-narrative-titles.js <output-dir> <damage-levels.xlsx>
 */

import { execSync }                         from 'child_process';
import { mkdtempSync, readFileSync,
         writeFileSync, existsSync }        from 'fs';
import { tmpdir }                           from 'os';
import path                                 from 'path';
import { fileURLToPath }                    from 'url';
import { chromium }                         from 'playwright';
import { PDFDocument, PDFName,
         PDFString, PDFNumber }             from 'pdf-lib';
import XLSXModule                           from 'xlsx';
const XLSX = XLSXModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

// ── Name formatting ───────────────────────────────────────────────────────────

// "strategy_2_us_allied_bases_merged" → "U.S. Allied Bases (Strategy 2)"
function formatLaydownName(stem) {
  const m = stem.match(/^strategy_(\d+)_(.+?)(?:_merged)?$/i);
  if (!m) return stem;
  const num  = m[1];
  const nice = m[2]
    .split('_')
    .map(w => w.toLowerCase() === 'us' ? 'U.S.' : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `${nice} (Strategy ${num})`;
}

// "Economic Hardship" → "Economic Hardship (Strategy 1)"
const ATTACK_STRATEGY_NUM = {
  'Economic Hardship':       1,
  'Double Tap':              2,
  'Attacking the Aggressor': 3,
  'U.S. Military Targets':   4,
  'Commercial Shipping':     5,
};
function formatAttackName(name) {
  const n = ATTACK_STRATEGY_NUM[name];
  return n != null ? `${name} (Strategy ${n})` : name;
}

// ── Static mappings (same as add-narratives.js) ───────────────────────────────

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

const TARGET_DISPLAY = {
  dubai:                 'Dubai',
  riyadh:                'Riyadh — International Airport',
  aramco_riyadh:         'ARAMCO — Riyadh',
  fujairah_port:         'Fujairah Port',
  jebel_ali_port:        'Jebel Ali Port',
  al_dhafra_ab:          'Al Dhafra Air Base',
  ruwais_refinery:       'Ruwais Refinery',
  al_udeid_ab:           'Al Udeid Air Base',
  hamad_port:            'Hamad Port',
  doha:                  'Doha — International Airport',
  tel_nof_ab:            'Tel Nof Air Base',
  tel_aviv:              'Tel Aviv',
  haifa:                 'Haifa',
  ramat_david_ab:        'Ramat David Air Base',
  beer_sheva:            "Be'er Sheva",
  muwaffaq_al_salti_ab:  'Muwaffaq al-Salti Air Base',
  prince_sultan_ab:      'Prince Sultan Air Base',
  us_fifth_fleet:        'U.S. Fifth Fleet',
  isa_ab:                'Isa Air Base',
  port_of_salalah:       'Port of Salalah',
  shuaiba_port:          'Shuaiba Port',
};

// ── Color extraction (same logic as add-narratives.js) ────────────────────────

function extractCellLevels(xlsxPath) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'upd-narratives-'));
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
  const cxMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (cxMatch) {
    const xfRe = /fillId="(\d+)"/g;
    let xm;
    while ((xm = xfRe.exec(cxMatch[1])) !== null) xfs.push(parseInt(xm[1], 10));
  }

  const sheetXml = readFileSync(
    path.join(tmpDir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8');
  const cellLevels = new Map();
  const cellRe = /<c\b[^>]*\br="([A-Z]+\d+)"[^>]*\bs="(\d+)"[^>]*>/g;
  let cm;
  while ((cm = cellRe.exec(sheetXml)) !== null) {
    const level = ARGB_TO_LEVEL[fills[xfs[parseInt(cm[2], 10)]]];
    if (level) cellLevels.set(cm[1], level);
  }
  return cellLevels;
}

function colLetters(idx) {
  let n = idx + 1, result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result    = String.fromCharCode(65 + rem) + result;
    n         = Math.floor((n - 1) / 26);
  }
  return result;
}

// ── Title page HTML (both subtitles same size) ────────────────────────────────

function buildTitlePageHtml(laydownFormatted, attackFormatted) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100vh; background: #fff; }
  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: Georgia, 'Times New Roman', serif;
    color: #1a1a2e;
    position: relative;
  }
  .supertitle {
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #999;
    margin-bottom: 40px;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }
  .rule { width: 48px; height: 3px; background: #b52b2b; margin-bottom: 40px; }
  .section-label {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #bbb;
    margin-bottom: 8px;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }
  .laydown {
    font-size: 24px;
    font-weight: bold;
    text-align: center;
    max-width: 500px;
    line-height: 1.25;
    margin-bottom: 36px;
  }
  .attack {
    font-size: 24px;
    font-weight: bold;
    font-style: italic;
    color: #555;
    text-align: center;
    max-width: 500px;
    line-height: 1.25;
  }
  .footer {
    position: absolute;
    bottom: 28px;
    font-size: 10px;
    color: #ccc;
    letter-spacing: 0.06em;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }
</style>
</head>
<body>
  <div class="supertitle">Strike Assessment Tool &nbsp;·&nbsp; Layered Air Defense Adjudicator</div>
  <div class="rule"></div>
  <div class="section-label">Defensive Laydown</div>
  <div class="laydown">${esc(laydownFormatted)}</div>
  <div class="section-label">Attack Strategy</div>
  <div class="attack">${esc(attackFormatted)}</div>
  <div class="footer">Middle East &nbsp;·&nbsp; Simulation Report</div>
</body>
</html>`;
}

// ── Narrative page HTML ───────────────────────────────────────────────────────

function buildNarrativeHtml(laydownFormatted, attackFormatted, items) {
  const sections = items.map(({ displayName, level, text }) => `
    <div class="tgt">
      <div class="tgt-head">
        <span class="tgt-name">${displayName}</span>
        <span class="badge lvl-${level.toLowerCase()}">${level}</span>
      </div>
      <p>${text}</p>
    </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: letter; margin: 0.85in 1in; }
    body  { font-family: 'Times New Roman', serif; font-size: 11pt; color: #000; margin: 0; }
    h1    { font-size: 15pt; margin: 0 0 3px; }
    .sub  { font-size: 11pt; font-style: italic; color: #444; margin: 0 0 18px;
            padding-bottom: 8px; border-bottom: 1.5px solid #666; }
    .tgt  { margin-bottom: 0; padding: 12px 0 0; border-top: 1px solid #ccc; }
    .tgt:first-of-type { border-top: none; padding-top: 0; }
    .tgt-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 5px; }
    .tgt-name { font-weight: bold; }
    .badge    { font-size: 8.5pt; padding: 1px 7px; border-radius: 3px; white-space: nowrap; }
    .lvl-none     { background: #00B050; color: #fff; }
    .lvl-mild     { background: #FFFF00; color: #000; border: 1px solid #ccc; }
    .lvl-moderate { background: #FFC000; color: #000; }
    .lvl-severe   { background: #FF0000; color: #fff; }
    p { margin: 0; line-height: 1.55; }
  </style></head><body>
    <h1>${laydownFormatted} / ${attackFormatted}</h1>
    <p class="sub">Damage Assessment Narratives</p>
    ${sections}
  </body></html>`;
}

// ── PDF bookmarks (3 levels: laydown > attack > Damage Narratives) ────────────

function addOutlines(pdfDoc, groups) {
  const ctx   = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const dest  = idx => ctx.obj([pages[idx].ref, PDFName.of('Fit')]);

  const laydownRefs = groups.map(group => {
    const attackEntries = group.attacks.map(atk => {
      const narRef = ctx.nextRef();
      ctx.assign(narRef, ctx.obj({
        Title:  PDFString.of('Damage Narratives'),
        Parent: null,
        Dest:   dest(atk.narrativePageIdx),
        Count:  PDFNumber.of(0),
      }));
      const atkRef = ctx.nextRef();
      ctx.assign(atkRef, ctx.obj({
        Title:  PDFString.of(atk.attackLabel),
        Parent: null,
        Dest:   dest(atk.titlePageIdx),
        First:  narRef,
        Last:   narRef,
        Count:  PDFNumber.of(-1),
      }));
      ctx.lookup(narRef).set(PDFName.of('Parent'), atkRef);
      return { atkRef, narRef };
    });

    for (let i = 0; i < attackEntries.length; i++) {
      const cur = attackEntries[i].atkRef;
      if (i > 0) ctx.lookup(cur).set(PDFName.of('Prev'), attackEntries[i-1].atkRef);
      if (i < attackEntries.length-1)
        ctx.lookup(cur).set(PDFName.of('Next'), attackEntries[i+1].atkRef);
    }

    const ldRef = ctx.nextRef();
    ctx.assign(ldRef, ctx.obj({
      Title:  PDFString.of(group.laydownLabel),
      Parent: null,
      Dest:   dest(group.attacks[0].titlePageIdx),
      First:  attackEntries[0].atkRef,
      Last:   attackEntries[attackEntries.length-1].atkRef,
      Count:  PDFNumber.of(-1),
    }));
    attackEntries.forEach(({ atkRef }) =>
      ctx.lookup(atkRef).set(PDFName.of('Parent'), ldRef));
    return ldRef;
  });

  for (let i = 0; i < laydownRefs.length; i++) {
    if (i > 0) ctx.lookup(laydownRefs[i]).set(PDFName.of('Prev'), laydownRefs[i-1]);
    if (i < laydownRefs.length-1)
      ctx.lookup(laydownRefs[i]).set(PDFName.of('Next'), laydownRefs[i+1]);
  }

  const rootRef = ctx.nextRef();
  ctx.assign(rootRef, ctx.obj({
    Type:  PDFName.of('Outlines'),
    First: laydownRefs[0],
    Last:  laydownRefs[laydownRefs.length-1],
    Count: PDFNumber.of(laydownRefs.length),
  }));
  laydownRefs.forEach(r => ctx.lookup(r).set(PDFName.of('Parent'), rootRef));

  pdfDoc.catalog.set(PDFName.of('Outlines'), rootRef);
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, outDir, xlsxPath] = process.argv;
  if (!outDir || !xlsxPath) {
    console.error('Usage: node scripts/update-narrative-titles.js <output-dir> <damage-levels.xlsx>');
    process.exit(1);
  }
  if (!existsSync(outDir))   { console.error('Output dir not found:', outDir);  process.exit(1); }
  if (!existsSync(xlsxPath)) { console.error('xlsx not found:', xlsxPath);      process.exit(1); }

  // 1. Parse damage levels ─────────────────────────────────────────────────────
  console.log(`[update] Parsing damage levels…`);
  const cellLevels = extractCellLevels(xlsxPath);
  console.log(`[update] ${cellLevels.size} colored cells\n`);

  const wb      = XLSX.readFile(xlsxPath);
  const ws      = wb.Sheets[wb.SheetNames[0]];
  const rows    = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const headers = rows[0];
  const colTargetIds = headers.map(h => COLUMN_TO_TARGET[h] ?? null);

  // 2. Load attack JSONs ────────────────────────────────────────────────────────
  const attackJsons = {};
  for (const [name, stem] of Object.entries(ATTACK_FILE_STEMS)) {
    const p = path.join(ROOT, 'data', 'batch', 'attacks', `${stem}.json`);
    attackJsons[name] = JSON.parse(readFileSync(p, 'utf8'));
  }

  // 3. Build combination list ───────────────────────────────────────────────────
  const combinations = [];
  for (let ri = 1; ri < rows.length; ri++) {
    const label = String(rows[ri][0] || '').trim();
    const sep   = label.indexOf(' / ');
    if (sep === -1) continue;

    const laydownStem  = label.slice(0, sep);
    const attackName   = label.slice(sep + 3);
    const attackStem   = ATTACK_FILE_STEMS[attackName];
    if (!attackStem) continue;

    const laydownLabel = formatLaydownName(laydownStem);
    const attackLabel  = formatAttackName(attackName);
    const attackJson   = attackJsons[attackName];
    const rowNum       = ri + 1;

    const narrativeItems = [];
    for (const entry of attackJson.attacks) {
      const colIdx = colTargetIds.indexOf(entry.targetId);
      if (colIdx === -1) continue;
      const level = cellLevels.get(`${colLetters(colIdx)}${rowNum}`);
      if (!level) continue;
      const text = entry.narratives?.[level];
      if (!text) continue;
      narrativeItems.push({
        displayName: TARGET_DISPLAY[entry.targetId] || entry.targetId,
        level,
        text,
      });
    }

    combinations.push({
      laydownStem, laydownLabel,
      attackName,  attackLabel, attackStem,
      narrativeItems,
    });
  }

  console.log(`[update] ${combinations.length} combinations\n`);

  // 4. Launch Playwright ────────────────────────────────────────────────────────
  const browser = await chromium.launch();
  const page    = await (await browser.newContext()).newPage();

  // 5. Build combined PDF ───────────────────────────────────────────────────────
  const combined      = await PDFDocument.create();
  const outlineGroups = [];
  let   curStem       = null;
  let   curGroup      = null;

  for (const combo of combinations) {
    if (combo.laydownStem !== curStem) {
      curStem  = combo.laydownStem;
      curGroup = { laydownLabel: combo.laydownLabel, attacks: [] };
      outlineGroups.push(curGroup);
    }

    const contentFile = path.join(outDir,
      `${combo.laydownStem}__${combo.attackStem}.pdf`);
    if (!existsSync(contentFile)) {
      console.warn(`  [SKIP] Missing: ${path.basename(contentFile)}`); continue;
    }

    // ── New title page ─────────────────────────────────────────────────────────
    const titlePageIdx = combined.getPageCount();
    await page.setContent(
      buildTitlePageHtml(combo.laydownLabel, combo.attackLabel),
      { waitUntil: 'load' }
    );
    const titleBytes = await page.pdf({ format: 'Letter', printBackground: true });
    const titleDoc   = await PDFDocument.load(titleBytes);
    for (const p of await combined.copyPages(titleDoc, titleDoc.getPageIndices()))
      combined.addPage(p);

    // ── Existing content pages (unchanged) ────────────────────────────────────
    const contentDoc = await PDFDocument.load(readFileSync(contentFile));
    for (const p of await combined.copyPages(contentDoc, contentDoc.getPageIndices()))
      combined.addPage(p);

    // ── New narrative page ─────────────────────────────────────────────────────
    const narrativePageIdx = combined.getPageCount();
    if (combo.narrativeItems.length > 0) {
      await page.setContent(
        buildNarrativeHtml(combo.laydownLabel, combo.attackLabel, combo.narrativeItems),
        { waitUntil: 'load' }
      );
      const narBytes = await page.pdf({ format: 'Letter', printBackground: true });
      const narDoc   = await PDFDocument.load(narBytes);
      for (const p of await combined.copyPages(narDoc, narDoc.getPageIndices()))
        combined.addPage(p);
    }

    // ── Duplex padding ─────────────────────────────────────────────────────────
    if (combined.getPageCount() % 2 !== 0) {
      const last           = combined.getPage(combined.getPageCount() - 1);
      const { width, height } = last.getSize();
      combined.addPage([width, height]);
    }

    curGroup.attacks.push({
      attackLabel: combo.attackLabel, titlePageIdx, narrativePageIdx,
    });

    console.log(`  ✓ ${combo.laydownLabel} / ${combo.attackLabel}`);
  }

  await browser.close();

  // 6. Add bookmarks ────────────────────────────────────────────────────────────
  addOutlines(combined, outlineGroups);

  // 7. Write output ─────────────────────────────────────────────────────────────
  const outPath = path.join(outDir, 'combined_with_narratives_update.pdf');
  writeFileSync(outPath, await combined.save());
  console.log(`\n[update] Written: ${outPath}`);
  console.log(`[update] Total pages: ${combined.getPageCount()}`);
}

main().catch(err => {
  console.error('[update] Fatal:', err);
  process.exit(1);
});
