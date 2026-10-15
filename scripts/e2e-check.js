#!/usr/bin/env node
/**
 * e2e-check.js — Browser-level checks of the tool and the builder pages.
 *
 * Serves the repository over a local static server, drives the pages in
 * headless Chromium through their automation hooks, and asserts the
 * behaviour that the unit tests cannot reach: results rendering, manual
 * overrides, Pk-table and doctrine import, persistence, the builders'
 * import/export round trips, and the batch hooks.
 *
 * Usage:
 *   npm run e2e
 *   node scripts/e2e-check.js [--only tool|pk|doctrine]
 *
 * Prerequisites: npm install && npx playwright install chromium
 */

import { chromium }      from 'playwright';
import * as http         from 'http';
import * as fs           from 'fs';
import * as path         from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const ONLY      = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : null; })();

// ── Static server ─────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (f.endsWith('/')) f += 'index.html';
      if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ── Tiny assertion harness ────────────────────────────────────────────────────
const results = [];
function check(cond, label) {
  results.push({ ok: !!cond, label });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
}
function collectErrors(page) {
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  return errs;
}
const DUBAI_ATTACK = { version: '1.0', attacks: [{ targetId: 'dubai', platforms: [{ platformId: 'fateh_110', quantity: 10 }, { platformId: 'shahed_136', quantity: 50 }] }] };

// ─────────────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────────────
async function checkTool(browser, base) {
  console.log('\n── tool ──');
  const page = await browser.newPage();
  const errs = collectErrors(page);
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window._appReady === true, { timeout: 20000 });

  const r1 = await page.evaluate(async (attack) => {
    window._setSeed(0);
    window._importAttackQueueDirect(attack);
    window._simulateQueueDirect();
    const sel = document.getElementById('target-select'); sel.value = 'dubai'; sel.dispatchEvent(new Event('change'));
    const snap = simHistory[simHistory.length - 1];
    const drone = snap.results.byThreatType.find(t => t.threatType === 'drone').platforms[0].engagements[0];
    return {
      badges: document.getElementById('pk-badge').textContent + '/' + document.getElementById('doctrine-badge').textContent,
      thaadTypes: DEFENSE_CATALOG.thaad.effectiveAgainst,
      totals: [snap.results.totalIn, snap.results.totalOut],
      firstDrone: `${drone.defId}:${drone.killed}/${drone.threatsIn} pk ${drone.pk.toFixed(2)} shot ${drone.pkShot}`,
      platformBlocks: document.querySelectorAll('.platform-section').length,
      rows: document.querySelectorAll('.engagement-row').length,
      editBtns: document.querySelectorAll('.btn-override-eng').length,
      printPlatformRows: (window._buildPrintDocument().match(/pr-platform-row/g) || []).length,
      simPlatforms: window._getSimulationResults()[0].byThreatType.map(t => t.platforms.length),
      cfg: snap.engagementConfig
    };
  }, DUBAI_ATTACK);
  check(r1.badges === 'Default/Default', 'tool: default badges');
  check(JSON.stringify(r1.thaadTypes) === '["mrbm","srbm"]', 'tool: THAAD capability derived from the doctrine');
  check(r1.totals[0] === 60 && r1.totals[1] === 0, 'tool: Dubai example 60 in / 0 out');
  check(r1.firstDrone === 'dubai_d1:20/50 pk 0.85 shot 0.4687', 'tool: first drone engagement matches the engine tests');
  check(r1.platformBlocks === 2 && r1.rows >= 5 && r1.editBtns >= 4, 'tool: per-platform result blocks with override buttons');
  check(r1.printPlatformRows === 2 && r1.simPlatforms.every(n => n === 1), 'tool: print document and batch results carry platforms');
  check(r1.cfg && r1.cfg.pkHash && r1.cfg.doctrineHash, 'tool: snapshot records the engagement config');

  const r2 = await page.evaluate(() => {
    applyLayerOverride('drone', 'shahed_136', 'dubai_d1', 45, false);
    const a1 = { notice: !document.getElementById('override-notice').classList.contains('hidden'), badge: !!document.querySelector('.eng-overridden'), mag: { ...globalMagState } };
    applyLayerOverride('drone', 'shahed_136', 'jebel_ali_port_d1', 0, true);
    const a2 = { mag: { ...globalMagState } };
    clearAllOverrides();
    const a3 = { notice: !document.getElementById('override-notice').classList.contains('hidden'), mag: { ...globalMagState }, headline: document.querySelector('.final-headline').textContent };
    return { a1, a2, a3 };
  });
  check(r2.a1.notice && r2.a1.badge && r2.a1.mag.dubai_d1 === 0, 'tool: kill override renders and keeps the Dubai Patriot spent');
  check(r2.a2.mag.jebel_ali_port_d1 === undefined, 'tool: disengage override restores that battery to full');
  check(!r2.a3.notice && r2.a3.mag.jebel_ali_port_d1 === 0 && /All 60/.test(r2.a3.headline), 'tool: clearing overrides restores the original result');

  const r3 = await page.evaluate(async () => {
    const pk = JSON.parse(JSON.stringify(defaultPkTableRaw)); pk.name = 'E2E Pk'; pk.cells.patriot.shahed_136 = { pk: 1, shots: 1 };
    const a = window._importPkTableDirect(pk);
    const doc = JSON.parse(JSON.stringify(defaultDoctrineRaw)); doc.name = 'E2E Doctrine'; doc.engage.drone = doc.engage.drone.filter(s => s !== 'patriot');
    const b = window._importDoctrineDirect(doc);
    rerenderWithOverrides();
    const noticeOld = !document.getElementById('config-notice').classList.contains('hidden');
    globalMagState = {}; attackManifest = [{ platformId: 'shahed_136', count: 50 }]; _manifestUnchanged = false; await simulate();
    const snap = simHistory[simHistory.length - 1];
    return {
      warnings: a.warnings.length + b.warnings.length,
      badges: document.getElementById('pk-badge').textContent + '/' + document.getElementById('doctrine-badge').textContent,
      patriotDrone: DEFENSE_CATALOG.patriot.effectiveAgainst.includes('drone'),
      noticeOld,
      systems: snap.results.byThreatType[0].platforms[0].engagements.map(e => e.systemId),
      noticeNew: !document.getElementById('config-notice').classList.contains('hidden'),
      cfgName: snap.engagementConfig.pkName
    };
  });
  check(r3.warnings === 0 && r3.badges === 'E2E Pk/E2E Doctrine', 'tool: Pk table and doctrine imports apply and badge');
  check(!r3.patriotDrone && !r3.systems.includes('patriot'), 'tool: imported doctrine removes Patriot from the drone pass');
  check(r3.noticeOld && !r3.noticeNew && r3.cfgName === 'E2E Pk', 'tool: config notice only on results from another configuration');

  await page.reload(); await page.waitForFunction(() => window._appReady === true);
  const r4 = await page.evaluate(() => document.getElementById('pk-badge').textContent + '/' + document.getElementById('doctrine-badge').textContent);
  check(r4 === 'E2E Pk/E2E Doctrine', 'tool: imported configuration survives a reload');
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload(); await page.waitForFunction(() => window._appReady === true);
  const r5 = await page.evaluate(() => document.getElementById('pk-badge').textContent + '/' + document.getElementById('doctrine-badge').textContent);
  check(r5 === 'Default/Default', 'tool: clearing storage restores the defaults');
  check(errs.length === 0, 'tool: no page errors ' + JSON.stringify(errs));
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pk builder
// ─────────────────────────────────────────────────────────────────────────────
async function checkPkBuilder(browser, base) {
  console.log('\n── pk builder ──');
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = collectErrors(page);
  await page.goto(base + '/pk/');
  await page.waitForFunction(() => window._pkReady === true, { timeout: 20000 });
  const r1 = await page.evaluate(() => ({
    rows: document.querySelectorAll('.pk-row').length, cols: document.querySelectorAll('.pk-sys-head').length,
    patriot: document.querySelector('.pk-cell[data-system="patriot"][data-platform="geran_2"] .pk-in').value,
    thaadZero: document.querySelector('.pk-cell[data-system="thaad"][data-platform="geran_2"]').classList.contains('pk-zero'),
    deDisabled: document.querySelector('.pk-cell[data-system="iron_beam"][data-platform="geran_2"] .shots-in').disabled,
    summary: document.getElementById('pk-summary').textContent
  }));
  check(r1.rows === 22 && r1.cols === 23, 'pk: matrix is 22 × 23');
  check(r1.patriot === '0.4687' && r1.thaadZero && r1.deDisabled, 'pk: defaults, zero shading and DE shots disabled');
  check(/284 of 506/.test(r1.summary), 'pk: summary counts engageable pairings');

  await page.fill('.pk-cell[data-system="patriot"][data-platform="geran_2"] .pk-in', '0.9');
  await page.press('.pk-cell[data-system="patriot"][data-platform="geran_2"] .pk-in', 'Tab');
  await page.fill('#tier-low', '0.8'); await page.press('#tier-low', 'Tab');
  const r2 = await page.evaluate(() => { const s = window._pkState(); return { pk: s.table.cells.patriot.geran_2.pk, low: s.table.tiers.low }; });
  check(r2.pk === 0.9 && r2.low === 0.8, 'pk: UI edits update the draft');
  await page.reload(); await page.waitForFunction(() => window._pkReady === true);
  const r3 = await page.evaluate(() => document.querySelector('.pk-cell[data-system="patriot"][data-platform="geran_2"] .pk-in').value);
  check(r3 === '0.9', 'pk: draft survives a reload');
  const r4 = await page.evaluate(() => { const w = window._pkApplyData({ version: '1.0', cells: { patriot: { geran_2: { pk: 1.5, shots: 1 } }, bogus: {} } }); const s = window._pkState(); return { w: w.length, pk: s.table.cells.patriot.geran_2.pk, other: s.table.cells.thaad.fateh_110.pk }; });
  check(r4.w > 400 && r4.pk === 1 && r4.other === 0, 'pk: sparse import warns, clamps, fills gaps with 0');
  await page.evaluate(async () => { const raw = await fetch('data/pk-table.json').then(r => r.json()); window._pkApplyData(raw); });
  const exported = await page.evaluate(() => window._pkBuildExport('Round Trip'));
  const tool = await browser.newPage(); const terrs = collectErrors(tool);
  await tool.goto(base + '/index.html'); await tool.waitForFunction(() => window._appReady === true);
  const r5 = await tool.evaluate(d => { const r = window._importPkTableDirect(d); const out = { w: r.warnings.length, badge: document.getElementById('pk-badge').textContent }; localStorage.removeItem('threatmodel_pk_v1'); return out; }, exported);
  check(r5.w === 0 && r5.badge === 'Round Trip', 'pk: the tool imports the builder export without warnings');
  await page.evaluate(() => localStorage.removeItem('threatmodel_pk_builder_v1'));
  check(errs.length === 0 && terrs.length === 0, 'pk: no page errors ' + JSON.stringify([...errs, ...terrs]));
  await tool.close(); await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctrine builder
// ─────────────────────────────────────────────────────────────────────────────
async function checkDoctrineBuilder(browser, base) {
  console.log('\n── doctrine builder ──');
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = collectErrors(page);
  await page.goto(base + '/doctrine/');
  await page.waitForFunction(() => window._doctrineReady === true, { timeout: 20000 });
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/doctrine.json'), 'utf8'));
  const r1 = await page.evaluate(() => { const ex = window._doctrineBuildExport('X'); return { typeOrder: ex.typeOrder, counts: ex.typeOrder.map(t => ex.engage[t].length) }; });
  check(JSON.stringify(r1.typeOrder) === JSON.stringify(expected.typeOrder), 'doctrine: default type order');
  check(JSON.stringify(r1.counts) === JSON.stringify(expected.typeOrder.map(t => expected.engage[t].length)), 'doctrine: default column counts');
  const r2 = await page.evaluate(() => { const w = window._doctrineApplyData({ version: '1.0', typeOrder: ['drone', 'bogus'], engage: { drone: ['patriot', 'nope'] } }); const s = window._doctrineState(); return { w: w.length, order: s.doctrine.typeOrder, drone: s.doctrine.engage.drone }; });
  check(r2.w >= 2 && r2.order[0] === 'drone' && JSON.stringify(r2.drone) === '["patriot"]', 'doctrine: import drops unknown ids and types with warnings');
  await page.evaluate(() => window._doctrineApplyData(JSON.parse(JSON.stringify({ version: '1.0', typeOrder: ['mrbm', 'srbm', 'cruise_missile', 'drone_jet', 'drone', 'fpv'], engage: window._doctrineBuildExport('d').engage }))));
  await page.evaluate(async () => { const raw = await fetch('data/doctrine.json').then(r => r.json()); window._doctrineApplyData(raw); });
  const exported = await page.evaluate(() => window._doctrineBuildExport('Round Trip'));
  const tool = await browser.newPage(); const terrs = collectErrors(tool);
  await tool.goto(base + '/index.html'); await tool.waitForFunction(() => window._appReady === true);
  const r3 = await tool.evaluate(d => { const r = window._importDoctrineDirect(d); const out = { w: r.warnings.length, badge: document.getElementById('doctrine-badge').textContent }; localStorage.removeItem('threatmodel_doctrine_v1'); return out; }, exported);
  check(r3.w === 0 && r3.badge === 'Round Trip', 'doctrine: the tool imports the builder export without warnings');
  await page.evaluate(() => localStorage.removeItem('threatmodel_doctrine_builder_v1'));
  check(errs.length === 0 && terrs.length === 0, 'doctrine: no page errors ' + JSON.stringify([...errs, ...terrs]));
  await tool.close(); await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
const { server, base } = await startServer();
const browser = await chromium.launch();
try {
  if (!ONLY || ONLY === 'tool')     await checkTool(browser, base);
  if (!ONLY || ONLY === 'pk')       await checkPkBuilder(browser, base);
  if (!ONLY || ONLY === 'doctrine') await checkDoctrineBuilder(browser, base);
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter(r => !r.ok);
console.log(`\n[e2e] ${results.length - failed.length} / ${results.length} checks passed${failed.length ? ' — FAILED: ' + failed.map(f => f.label).join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
