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
 * PDF naming:        {laydown-name}__{attack-name}.pdf
 *
 * Usage:
 *   npm run batch
 *   node scripts/batch-sim.js
 *
 * Prerequisites:
 *   npm install
 *   npx playwright install chromium
 */

import { chromium }       from 'playwright';
import * as http          from 'http';
import * as fs            from 'fs';
import * as path          from 'path';
import { fileURLToPath }  from 'url';

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
  let pdfCount = 0;

  for (const laydownFile of laydownFiles) {
    const laydownName = laydownFile.replace(/\.json$/i, '');
    const laydownData = JSON.parse(
      fs.readFileSync(path.join(laydownDir, laydownFile), 'utf8')
    );

    console.log(`[laydown] ${laydownName}`);

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
      const attackName = attackFile.replace(/\.json$/i, '');
      const attackData = JSON.parse(
        fs.readFileSync(path.join(attackDir, attackFile), 'utf8')
      );

      process.stdout.write(`  [attack] ${attackName} ... `);

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
    }

    console.log('');
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await browser.close();
  server.close();

  console.log(`[batch] Done — ${pdfCount} / ${total} PDF(s) written to:\n        ${outDir}`);
}

main().catch(err => {
  console.error('[batch] Fatal error:', err);
  process.exit(1);
});
