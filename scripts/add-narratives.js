#!/usr/bin/env node
/**
 * add-narratives.js
 *
 * Post-processes a batch output directory to produce a new combined PDF
 * with per-combination damage narrative pages inserted after each section.
 * Narrative page selection is driven by cell fill colors in a damage-level
 * spreadsheet. Bookmarks include a child "Damage Narratives" entry per combo.
 *
 * Usage:
 *   node scripts/add-narratives.js <output-dir> <damage-levels.xlsx>
 *
 * Output:
 *   <output-dir>/combined_with_narratives.pdf
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

// ── Static mappings ───────────────────────────────────────────────────────────

// ARGB fill color (from xlsx XML) → damage level label
const ARGB_TO_LEVEL = {
  'FF00B050': 'None',
  'FFFFFF00': 'Mild',
  'FFFFC000': 'Moderate',
  'FFFF0000': 'Severe',
};

// Attack JSON name field → attack file stem
const ATTACK_FILE_STEMS = {
  'Economic Hardship':       'strategy_1_economic_hardship',
  'Double Tap':              'strategy_2_double_tap',
  'Attacking the Aggressor': 'strategy_3_attacking_aggressor',
  'U.S. Military Targets':   'strategy_4_us_military_targets',
  'Commercial Shipping':     'strategy_5_commercial_shipping',
};

// Spreadsheet column header → targetId
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

// targetId → human-readable display name for the narrative page
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

// ── Color extraction from xlsx XML ────────────────────────────────────────────
// xlsx's cellStyles option does not surface fill colors for this file format,
// so we unzip the xlsx and parse styles.xml + sheet1.xml directly.

function extractCellLevels(xlsxPath) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'add-narratives-'));
  execSync(`unzip -o "${xlsxPath}" -d "${tmpDir}"`, { stdio: 'ignore' });

  const stylesXml = readFileSync(path.join(tmpDir, 'xl', 'styles.xml'), 'utf8');

  // Build fills[]: fill index → ARGB string (null if no solid colour)
  const fills = [];
  const fillRe = /<fill>([\s\S]*?)<\/fill>/g;
  let fm;
  while ((fm = fillRe.exec(stylesXml)) !== null) {
    const fg = fm[1].match(/fgColor rgb="([A-Fa-f0-9]{8})"/);
    fills.push(fg ? fg[1].toUpperCase() : null);
  }

  // Build xfs[]: xf index → fillId (from <cellXfs> only, not <cellStyleXfs>)
  const xfs = [];
  const cellXfsMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (cellXfsMatch) {
    const xfRe = /fillId="(\d+)"/g;
    let xm;
    while ((xm = xfRe.exec(cellXfsMatch[1])) !== null) {
      xfs.push(parseInt(xm[1], 10));
    }
  }

  // Walk sheet XML; for every cell with a style index, look up its fill colour
  const sheetXml = readFileSync(
    path.join(tmpDir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8'
  );
  const cellLevels = new Map(); // "B2" → "Moderate"
  const cellRe = /<c\b[^>]*\br="([A-Z]+\d+)"[^>]*\bs="(\d+)"[^>]*>/g;
  let cm;
  while ((cm = cellRe.exec(sheetXml)) !== null) {
    const argb  = fills[xfs[parseInt(cm[2], 10)]];
    const level = ARGB_TO_LEVEL[argb];
    if (level) cellLevels.set(cm[1], level);
  }

  return cellLevels;
}

// ── Spreadsheet column index (0-based) → letter string ───────────────────────

function colLetters(idx) {
  let n = idx + 1, result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result    = String.fromCharCode(65 + rem) + result;
    n         = Math.floor((n - 1) / 26);
  }
  return result;
}

// ── Narrative HTML page ───────────────────────────────────────────────────────

function buildNarrativeHtml(laydownName, attackName, items) {
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
    <h1>${laydownName} / ${attackName}</h1>
    <p class="sub">Damage Assessment Narratives</p>
    ${sections}
  </body></html>`;
}

// ── PDF bookmark tree ─────────────────────────────────────────────────────────
// groups: [{ laydownName, attacks: [{ attackName, titlePageIdx, narrativePageIdx }] }]

function addOutlines(pdfDoc, groups) {
  const ctx   = pdfDoc.context;
  const pages = pdfDoc.getPages();

  const dest = idx => ctx.obj([pages[idx].ref, PDFName.of('Fit')]);

  const laydownRefs = groups.map(group => {
    const attackEntries = group.attacks.map(atk => {
      // Leaf: Damage Narratives
      const narRef = ctx.nextRef();
      ctx.assign(narRef, ctx.obj({
        Title: PDFString.of('Damage Narratives'),
        Parent: null,
        Dest:   dest(atk.narrativePageIdx),
        Count:  PDFNumber.of(0),
      }));

      // Attack (parent of narrative leaf)
      const atkRef = ctx.nextRef();
      ctx.assign(atkRef, ctx.obj({
        Title:  PDFString.of(atk.attackName),
        Parent: null,
        Dest:   dest(atk.titlePageIdx),
        First:  narRef,
        Last:   narRef,
        Count:  PDFNumber.of(-1), // collapsed
      }));

      ctx.lookup(narRef).set(PDFName.of('Parent'), atkRef);
      return { atkRef, narRef };
    });

    // Sibling links for attacks
    for (let i = 0; i < attackEntries.length; i++) {
      const cur = attackEntries[i].atkRef;
      if (i > 0) ctx.lookup(cur).set(PDFName.of('Prev'), attackEntries[i-1].atkRef);
      if (i < attackEntries.length-1)
        ctx.lookup(cur).set(PDFName.of('Next'), attackEntries[i+1].atkRef);
    }

    // Laydown (parent of attacks)
    const ldRef = ctx.nextRef();
    ctx.assign(ldRef, ctx.obj({
      Title:  PDFString.of(group.laydownName),
      Parent: null,
      Dest:   dest(group.attacks[0].titlePageIdx),
      First:  attackEntries[0].atkRef,
      Last:   attackEntries[attackEntries.length-1].atkRef,
      Count:  PDFNumber.of(-1), // collapsed
    }));

    attackEntries.forEach(({ atkRef }) =>
      ctx.lookup(atkRef).set(PDFName.of('Parent'), ldRef));

    return ldRef;
  });

  // Sibling links for laydowns
  for (let i = 0; i < laydownRefs.length; i++) {
    if (i > 0) ctx.lookup(laydownRefs[i]).set(PDFName.of('Prev'), laydownRefs[i-1]);
    if (i < laydownRefs.length-1)
      ctx.lookup(laydownRefs[i]).set(PDFName.of('Next'), laydownRefs[i+1]);
  }

  // Outline root
  const rootRef = ctx.nextRef();
  ctx.assign(rootRef, ctx.obj({
    Type:  PDFName.of('Outlines'),
    First: laydownRefs[0],
    Last:  laydownRefs[laydownRefs.length-1],
    Count: PDFNumber.of(laydownRefs.length),
  }));

  laydownRefs.forEach(ldRef =>
    ctx.lookup(ldRef).set(PDFName.of('Parent'), rootRef));

  pdfDoc.catalog.set(PDFName.of('Outlines'), rootRef);
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, outDir, xlsxPath] = process.argv;
  if (!outDir || !xlsxPath) {
    console.error('Usage: node scripts/add-narratives.js <output-dir> <damage-levels.xlsx>');
    process.exit(1);
  }
  if (!existsSync(outDir))   { console.error('Output dir not found:', outDir);  process.exit(1); }
  if (!existsSync(xlsxPath)) { console.error('xlsx not found:', xlsxPath);      process.exit(1); }

  // 1. Parse damage levels ─────────────────────────────────────────────────────
  console.log(`[narratives] Parsing: ${xlsxPath}`);
  const cellLevels = extractCellLevels(xlsxPath);
  console.log(`[narratives] ${cellLevels.size} colored cells found`);

  const wb      = XLSX.readFile(xlsxPath);
  const ws      = wb.Sheets[wb.SheetNames[0]];
  const rows    = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const headers = rows[0];

  // Map column index → targetId (null for unmapped columns)
  const colTargetIds = headers.map(h => COLUMN_TO_TARGET[h] ?? null);

  // 2. Load attack JSONs ────────────────────────────────────────────────────────
  const attackJsons = {};
  for (const [name, stem] of Object.entries(ATTACK_FILE_STEMS)) {
    const p = path.join(ROOT, 'data', 'batch', 'attacks', `${stem}.json`);
    attackJsons[name] = JSON.parse(readFileSync(p, 'utf8'));
  }

  // 3. Load laydown display names ───────────────────────────────────────────────
  const laydownNames = {};
  const laydownDir   = path.join(ROOT, 'data', 'batch', 'laydowns');
  for (const stem of [
    'strategy_1_gulf_coast_merged', 'strategy_2_us_allied_bases_merged',
    'strategy_3_proxy_wall_merged', 'strategy_4_defend_israel_merged',
    'strategy_5_hedge_merged',
  ]) {
    const json = JSON.parse(readFileSync(path.join(laydownDir, `${stem}.json`), 'utf8'));
    laydownNames[stem] = json.name || stem;
  }

  // 4. Build narrative items per combination row ────────────────────────────────
  const combinations = [];
  for (let ri = 1; ri < rows.length; ri++) {
    const label = String(rows[ri][0] || '').trim();
    const sep   = label.indexOf(' / ');
    if (sep === -1) continue;

    const laydownStem = label.slice(0, sep);
    const attackName  = label.slice(sep + 3);
    const attackStem  = ATTACK_FILE_STEMS[attackName];
    if (!attackStem || !laydownNames[laydownStem]) continue;

    const attackJson = attackJsons[attackName];
    const rowNum     = ri + 1; // 1-based xlsx row number

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
      laydownStem,
      laydownName: laydownNames[laydownStem],
      attackName,
      attackStem,
      narrativeItems,
    });
  }

  console.log(`[narratives] ${combinations.length} valid combinations\n`);

  // 5. Launch Playwright ────────────────────────────────────────────────────────
  const browser = await chromium.launch();
  const page    = await (await browser.newContext()).newPage();

  // 6. Build combined PDF ───────────────────────────────────────────────────────
  const combined     = await PDFDocument.create();
  const outlineGroups = [];
  let   curLaydown    = null;
  let   curGroup      = null;

  for (const combo of combinations) {
    // New laydown group
    if (combo.laydownStem !== curLaydown) {
      curLaydown = combo.laydownStem;
      curGroup   = { laydownName: combo.laydownName, attacks: [] };
      outlineGroups.push(curGroup);
    }

    const titleFile   = path.join(outDir,
      `title__${combo.laydownStem}__${combo.attackStem}.pdf`);
    const contentFile = path.join(outDir,
      `${combo.laydownStem}__${combo.attackStem}.pdf`);

    if (!existsSync(titleFile)) {
      console.warn(`  [SKIP] Missing title PDF: ${path.basename(titleFile)}`); continue;
    }
    if (!existsSync(contentFile)) {
      console.warn(`  [SKIP] Missing content PDF: ${path.basename(contentFile)}`); continue;
    }

    // Title pages
    const titleDoc   = await PDFDocument.load(readFileSync(titleFile));
    const titlePageIdx = combined.getPageCount();
    for (const p of await combined.copyPages(titleDoc, titleDoc.getPageIndices()))
      combined.addPage(p);

    // Content pages
    const contentDoc = await PDFDocument.load(readFileSync(contentFile));
    for (const p of await combined.copyPages(contentDoc, contentDoc.getPageIndices()))
      combined.addPage(p);

    // Narrative page(s)
    const narrativePageIdx = combined.getPageCount();
    if (combo.narrativeItems.length > 0) {
      const html = buildNarrativeHtml(
        combo.laydownName, combo.attackName, combo.narrativeItems);
      await page.setContent(html, { waitUntil: 'load' });
      const narBytes = await page.pdf({ format: 'Letter', printBackground: true });
      const narDoc   = await PDFDocument.load(narBytes);
      for (const p of await combined.copyPages(narDoc, narDoc.getPageIndices()))
        combined.addPage(p);
    }

    // Duplex padding — keep even total page count
    if (combined.getPageCount() % 2 !== 0) {
      const last   = combined.getPage(combined.getPageCount() - 1);
      const { width, height } = last.getSize();
      combined.addPage([width, height]);
    }

    curGroup.attacks.push({
      attackName:      combo.attackName,
      titlePageIdx,
      narrativePageIdx,
    });

    const nTargets = combo.narrativeItems.length;
    const levels   = combo.narrativeItems.map(i => i.level).join(', ');
    console.log(`  ✓ ${combo.laydownName} / ${combo.attackName}`);
    console.log(`      ${nTargets} narrative(s): ${levels || '—'}`);
  }

  await browser.close();

  // 7. Add bookmarks ────────────────────────────────────────────────────────────
  addOutlines(combined, outlineGroups);

  // 8. Write output ─────────────────────────────────────────────────────────────
  const outPath = path.join(outDir, 'combined_with_narratives.pdf');
  writeFileSync(outPath, await combined.save());
  console.log(`\n[narratives] Written: ${outPath}`);
  console.log(`[narratives] Total pages: ${combined.getPageCount()}`);
}

main().catch(err => {
  console.error('[narratives] Fatal:', err);
  process.exit(1);
});
