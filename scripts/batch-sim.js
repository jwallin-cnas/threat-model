#!/usr/bin/env node
/**
 * batch-sim.js — Batch simulation runner
 *
 * Drives the Strike Assessment Tool in a headless Chromium browser, running
 * every combination of laydown × attack files found in:
 *
 *   data/batch/laydowns/   — one JSON file per defensive laydown
 *   data/batch/attacks/    — one JSON file per attack sequence
 *
 * Magazine state resets between attack files (fresh start per pairing) but
 * carries over within a single attack queue (as specified).
 *
 * Output directory:  output/YYYY-MM-DD_HH-MM-SS/
 * Individual PDFs:   {laydown-name}__{attack-name}.pdf
 * Combined PDF:      combined.pdf  (all combinations, sorted laydown → attack,
 *                    with title pages, duplex-safe odd-page breaks, bookmarks)
 *
 * Usage:
 *   npm run batch
 *   node scripts/batch-sim.js
 *
 * Prerequisites:
 *   npm install
 *   npx playwright install chromium
 */

import { chromium }                               from 'playwright';
import { PDFDocument, PDFName, PDFString, PDFNumber } from 'pdf-lib';
import XLSXModule                                 from 'xlsx';
const XLSX = XLSXModule;
import * as http                                  from 'http';
import * as fs                                    from 'fs';
import * as path                                  from 'path';
import { fileURLToPath }                          from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// Minimal static file server
// Serves the project root so the app can load its JSON data files via fetch().
// ─────────────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon'
};

function startServer(root, port = 8732) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const safePath = req.url.split('?')[0].replace(/\.\./g, '');
      const filePath = path.join(root, safePath === '/' ? 'index.html' : safePath);

      if (!filePath.startsWith(root)) {
        res.writeHead(403); res.end(); return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404); res.end(`Not found: ${safePath}`); return;
        }
        const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      });
    });

    server.listen(port, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Timestamp helper
// ─────────────────────────────────────────────────────────────────────────────

function timestamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_` +
         `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Title page HTML
// ─────────────────────────────────────────────────────────────────────────────

function buildTitlePageHtml(laydownName, attackName) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    font-size: 30px;
    font-weight: bold;
    text-align: center;
    max-width: 460px;
    line-height: 1.25;
    margin-bottom: 36px;
  }
  .attack {
    font-size: 20px;
    color: #555;
    text-align: center;
    max-width: 460px;
    line-height: 1.4;
    font-style: italic;
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
  <div class="laydown">${esc(laydownName)}</div>
  <div class="section-label">Attack Strategy</div>
  <div class="attack">${esc(attackName)}</div>
  <div class="footer">Middle East &nbsp;·&nbsp; Simulation Report</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF outline (bookmark) builder
// groups: [{ displayName, pageIndex, children: [{ displayName, pageIndex }] }]
// pageIndex is 0-based index into the combined document's page list.
// ─────────────────────────────────────────────────────────────────────────────

function addOutlines(pdfDoc, groups) {
  const ctx = pdfDoc.context;
  if (groups.length === 0) return;

  const rootRef      = ctx.nextRef();
  const groupRefs    = groups.map(() => ctx.nextRef());
  const childRefGrid = groups.map(g => g.children.map(() => ctx.nextRef()));

  // Destination: jump to top of the given page, fit width.
  const makeDest = pageIndex => [pdfDoc.getPage(pageIndex).ref, PDFName.of('Fit')];

  // Child (attack) outline items
  for (let gi = 0; gi < groups.length; gi++) {
    const { children } = groups[gi];
    for (let ci = 0; ci < children.length; ci++) {
      ctx.assign(childRefGrid[gi][ci], ctx.obj({
        Title:  PDFString.of(children[ci].displayName),
        Parent: groupRefs[gi],
        Dest:   makeDest(children[ci].pageIndex),
        ...(ci > 0                   && { Prev: childRefGrid[gi][ci - 1] }),
        ...(ci < children.length - 1 && { Next: childRefGrid[gi][ci + 1] }),
      }));
    }
  }

  // Group (laydown) outline items
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    ctx.assign(groupRefs[gi], ctx.obj({
      Title:  PDFString.of(g.displayName),
      Parent: rootRef,
      Dest:   makeDest(g.pageIndex),
      ...(g.children.length > 0 && {
        First: childRefGrid[gi][0],
        Last:  childRefGrid[gi][g.children.length - 1],
        Count: PDFNumber.of(-g.children.length),  // negative = collapsed by default
      }),
      ...(gi > 0                 && { Prev: groupRefs[gi - 1] }),
      ...(gi < groups.length - 1 && { Next: groupRefs[gi + 1] }),
    }));
  }

  // Outline root
  ctx.assign(rootRef, ctx.obj({
    Type:  PDFName.of('Outlines'),
    First: groupRefs[0],
    Last:  groupRefs[groups.length - 1],
    Count: PDFNumber.of(groups.length),
  }));

  pdfDoc.catalog.set(PDFName.of('Outlines'), rootRef);
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined PDF builder
// combinations: array of combo objects in desired order (laydown → attack).
// Each combo has: laydownName, laydownDisplayName, attackName,
//                 attackDisplayName, pdfPath, titlePdfPath.
// ─────────────────────────────────────────────────────────────────────────────

async function buildCombinedPdf(combinations, outDir) {
  const combined = await PDFDocument.create();
  let currentPage = 0;

  // Preserve insertion order (already sorted laydown → attack by the main loop)
  const laydownMap = new Map();
  for (const combo of combinations) {
    if (!laydownMap.has(combo.laydownName)) {
      laydownMap.set(combo.laydownName, {
        displayName: combo.laydownDisplayName,
        attacks:     [],
      });
    }
    laydownMap.get(combo.laydownName).attacks.push(combo);
  }

  const outlineGroups = [];

  for (const [, laydown] of laydownMap) {
    const laydownFirstPage = currentPage;
    const attackBookmarks  = [];

    for (const combo of laydown.attacks) {
      const comboFirstPage = currentPage;

      // Title page
      const titleDoc   = await PDFDocument.load(fs.readFileSync(combo.titlePdfPath));
      const titlePages = await combined.copyPages(titleDoc, titleDoc.getPageIndices());
      titlePages.forEach(p => combined.addPage(p));
      currentPage += titlePages.length;

      // Simulation report
      const contentDoc   = await PDFDocument.load(fs.readFileSync(combo.pdfPath));
      const contentPages = await combined.copyPages(contentDoc, contentDoc.getPageIndices());
      contentPages.forEach(p => combined.addPage(p));
      currentPage += contentPages.length;

      attackBookmarks.push({
        displayName: combo.attackDisplayName,
        pageIndex:   comboFirstPage,
      });

      // Pad to an even page total so the next combination always starts on
      // an odd (right-hand / front) page when printing duplex.
      // currentPage is 0-based count; page numbers are 1-based, so an odd
      // currentPage means the last page carries an odd number (front side).
      if (currentPage % 2 !== 0) {
        combined.addPage([595.28, 841.89]);  // blank A4
        currentPage++;
      }
    }

    outlineGroups.push({
      displayName: laydown.displayName,
      pageIndex:   laydownFirstPage,
      children:    attackBookmarks,
    });
  }

  addOutlines(combined, outlineGroups);

  const combinedPath = path.join(outDir, 'combined.pdf');
  fs.writeFileSync(combinedPath, await combined.save());
  console.log(`[batch] Combined PDF → ${combinedPath}  (${combined.getPageCount()} pages)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Spreadsheet builder
//
// rows: [{
//   laydownDisplayName, attackDisplayName,
//   attacks: [{ targetId, targetName, manifest: [{platformName, count}],
//               byThreatType: [{threatType, initialCount, finalCount}] }]
// }]
// ─────────────────────────────────────────────────────────────────────────────

const THREAT_LABELS = {
  mrbm:         'MRBM',
  srbm:         'SRBM',
  cruise_missile:'cruise missile',
  drone_jet:    'jet drone',
  drone:        'drone',
  fpv:          'FPV',
};

function formatCell(attackEntry) {
  // Manifest: "150× Shahed-238 (Geran-3); 50× Fateh-110"
  const manifest = attackEntry.manifest
    .map(p => `${p.count}× ${p.platformName}`)
    .join('; ');

  // Outcome: only show threat types that had inbound, list leaker counts
  const outcome = attackEntry.byThreatType
    .filter(g => g.initialCount > 0)
    .map(g => {
      const label = THREAT_LABELS[g.threatType] || g.threatType;
      return `${g.finalCount} ${label}`;
    })
    .join('; ');

  return outcome ? `${manifest} → ${outcome}` : manifest;
}

function buildSpreadsheet(rows, outDir) {
  // Collect all target locations in first-appearance order
  const targetOrder = [];
  const targetNames = {};
  for (const row of rows) {
    for (const atk of row.attacks) {
      if (!targetNames[atk.targetId]) {
        targetOrder.push(atk.targetId);
        targetNames[atk.targetId] = atk.targetName;
      }
    }
  }

  // Header row
  const header = ['Combination', ...targetOrder.map(id => targetNames[id])];
  const wsData  = [header];

  for (const row of rows) {
    const byTarget = {};
    for (const atk of row.attacks) {
      byTarget[atk.targetId] = formatCell(atk);
    }
    wsData.push([
      `${row.laydownDisplayName} / ${row.attackDisplayName}`,
      ...targetOrder.map(id => byTarget[id] || ''),
    ]);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Auto-size columns (approximate: max char length in each column)
  const colWidths = wsData.reduce((acc, r) => {
    r.forEach((cell, ci) => {
      const len = String(cell ?? '').length;
      acc[ci] = Math.max(acc[ci] ?? 10, len);
    });
    return acc;
  }, []);
  ws['!cols'] = colWidths.map(w => ({ wch: Math.min(w + 2, 80) }));

  XLSX.utils.book_append_sheet(wb, ws, 'Results');

  const xlsxPath = path.join(outDir, 'results.xlsx');
  XLSX.writeFile(wb, xlsxPath);
  console.log(`[batch] Spreadsheet  → ${xlsxPath}  (${rows.length} rows × ${targetOrder.length} targets)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const laydownDir = path.join(ROOT, 'data', 'batch', 'laydowns');
  const attackDir  = path.join(ROOT, 'data', 'batch', 'attacks');

  // ── Collect input files ───────────────────────────────────────────────────
  const laydownFiles = fs.readdirSync(laydownDir)
    .filter(f => f.toLowerCase().endsWith('.json'))
    .sort();

  const attackFiles = fs.readdirSync(attackDir)
    .filter(f => f.toLowerCase().endsWith('.json'))
    .sort();

  if (laydownFiles.length === 0) {
    console.error(`[batch] No laydown files found in ${laydownDir}`);
    console.error('        Add .json files matching the defaults.json schema.');
    process.exit(1);
  }
  if (attackFiles.length === 0) {
    console.error(`[batch] No attack files found in ${attackDir}`);
    console.error('        Add .json files matching the sample-attacks.json schema.');
    process.exit(1);
  }

  const total = laydownFiles.length * attackFiles.length;
  console.log(`[batch] ${laydownFiles.length} laydown(s) × ${attackFiles.length} attack(s) = ${total} combination(s)`);

  // ── Create output directory ───────────────────────────────────────────────
  const stamp  = timestamp();
  const outDir = path.join(ROOT, 'output', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[batch] Output → ${outDir}`);

  // ── Start local HTTP server ───────────────────────────────────────────────
  const { server, url } = await startServer(ROOT);
  console.log(`[batch] Server  → ${url}`);

  // ── Launch headless browser ───────────────────────────────────────────────
  const browser = await chromium.launch();
  const page    = await (await browser.newContext()).newPage();

  // Surface browser console errors to the terminal for visibility
  page.on('console', msg => {
    if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`);
  });

  // Navigate and wait for the app to finish initialising
  await page.goto(url);
  await page.waitForFunction(() => window._appReady === true, { timeout: 20_000 });
  // Reset to the fixed seed so the full batch is reproducible from this point
  await page.evaluate(() => window._setSeed(window.FIXED_SEED));
  console.log('[batch] App ready\n');

  // ── Run all combinations ──────────────────────────────────────────────────
  let pdfCount    = 0;
  const combinations  = [];  // track successful combos in order for combined PDF
  const spreadsheetRows = []; // track simulation results for spreadsheet

  for (const laydownFile of laydownFiles) {
    const laydownName        = laydownFile.replace(/\.json$/i, '');
    const laydownData        = JSON.parse(fs.readFileSync(path.join(laydownDir, laydownFile), 'utf8'));
    const laydownDisplayName = laydownData.name || laydownName;

    console.log(`[laydown] ${laydownDisplayName}`);

    // Apply laydown — clears all defenses and restores them from the file
    const ldResult = await page.evaluate((data) => {
      try {
        return window._importLaydownDirect(data);
      } catch (e) {
        return { error: e.message };
      }
    }, laydownData);

    if (ldResult?.error) {
      console.error(`  [error] Failed to import laydown "${laydownFile}": ${ldResult.error}`);
      continue;
    }
    if (ldResult?.warnings?.length) {
      ldResult.warnings.forEach(w => console.warn(`  [warn]  ${w}`));
    }
    console.log(`  Targets updated: ${ldResult?.targetsUpdated ?? '?'}`);

    for (const attackFile of attackFiles) {
      const attackName        = attackFile.replace(/\.json$/i, '');
      const attackData        = JSON.parse(fs.readFileSync(path.join(attackDir, attackFile), 'utf8'));
      const attackDisplayName = attackData.name || attackName;

      process.stdout.write(`  [attack] ${attackDisplayName} ... `);

      // Import attack queue — resets magazine and simulation history
      const aqResult = await page.evaluate((data) => {
        try {
          return window._importAttackQueueDirect(data);
        } catch (e) {
          return { error: e.message };
        }
      }, attackData);

      if (aqResult?.error) {
        console.error(`FAILED (import): ${aqResult.error}`);
        continue;
      }
      if (aqResult?.warnings?.length) {
        aqResult.warnings.forEach(w => console.warn(`\n  [warn]  ${w}`));
      }

      // Execute the queue
      const attacksRun = await page.evaluate(() => {
        return window._simulateQueueDirect();
      });

      if (attacksRun === 0) {
        console.log('0 attacks run (queue was empty after validation)');
        continue;
      }

      // Capture simulation results for the spreadsheet before tearing down state
      const simResults = await page.evaluate(() => window._getSimulationResults());

      // Dismiss any lingering toast (e.g. "Changes saved to local storage.")
      // before capturing the PDF so it doesn't appear in the output.
      await page.evaluate(() => {
        const toast = document.getElementById('toast');
        if (toast) toast.remove();
      });

      // Build the print document and capture as PDF
      const printHtml = await page.evaluate(() => {
        return window._buildPrintDocument();
      });

      await page.evaluate((html) => {
        document.getElementById('print-root').innerHTML = html;
        document.body.classList.add('is-printing');
      }, printHtml);

      const pdfPath = path.join(outDir, `${laydownName}__${attackName}.pdf`);
      await page.pdf({
        path:            pdfPath,
        format:          'A4',
        printBackground: true,
        margin:          { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' }
      });

      // Tear down print state
      await page.evaluate(() => {
        document.body.classList.remove('is-printing');
        document.getElementById('print-root').innerHTML = '';
      });

      pdfCount++;
      console.log(`${attacksRun} attack(s) → ${path.basename(pdfPath)}`);

      combinations.push({
        laydownName,
        laydownDisplayName,
        attackName,
        attackDisplayName,
        pdfPath,
        titlePdfPath: path.join(outDir, `title__${laydownName}__${attackName}.pdf`),
      });

      spreadsheetRows.push({
        laydownDisplayName,
        attackDisplayName,
        attacks: simResults,
      });
    }

    console.log('');
  }

  // ── Generate title pages ──────────────────────────────────────────────────
  if (combinations.length > 0) {
    console.log('[batch] Generating title pages...');
    for (const combo of combinations) {
      await page.setContent(
        buildTitlePageHtml(combo.laydownDisplayName, combo.attackDisplayName),
        { waitUntil: 'domcontentloaded' }
      );
      await page.pdf({
        path:            combo.titlePdfPath,
        format:          'A4',
        printBackground: true,
        margin:          { top: '0', right: '0', bottom: '0', left: '0' },
      });
      console.log(`  ${combo.laydownDisplayName} / ${combo.attackDisplayName}`);
    }
    console.log('');
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await browser.close();
  server.close();

  // ── Build combined PDF ────────────────────────────────────────────────────
  if (combinations.length > 0) {
    console.log('[batch] Building combined PDF...');
    await buildCombinedPdf(combinations, outDir);
    console.log('');
  }

  // ── Build spreadsheet ─────────────────────────────────────────────────────
  if (spreadsheetRows.length > 0) {
    buildSpreadsheet(spreadsheetRows, outDir);
  }

  console.log(`[batch] Done — ${pdfCount} / ${total} PDF(s) written to:\n        ${outDir}`);
}

main().catch(err => {
  console.error('[batch] Fatal error:', err);
  process.exit(1);
});
