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
 *   node scripts/e2e-check.js [--only tool|pk|doctrine|blue|red]
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
// Report summaries — chip changes (Blue) and platform losses (Red)
// ─────────────────────────────────────────────────────────────────────────────
async function checkReportSummaries(browser, base) {
  console.log('\n── report summaries ──');
  const page = await browser.newPage();
  const errs = collectErrors(page);
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window._appReady === true, { timeout: 20000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload(); await page.waitForFunction(() => window._appReady === true);
  const r = await page.evaluate(() => {
    window._setSeed(0);
    window._importAttackQueueDirect({ version: '1.0', attacks: [
      { targetId: 'us_fifth_fleet', platforms: [{ platformId: 'geran_2', quantity: 200 }, { platformId: 'fateh_110', quantity: 10 }] },
      { targetId: 'doha',           platforms: [{ platformId: 'geran_2', quantity: 150 }] },
      { targetId: 'riyadh',         platforms: [{ platformId: 'geran_2', quantity: 150 }] }
    ] });
    window._simulateQueueDirect();
    const div = document.createElement('div'); div.innerHTML = window._buildPrintDocument();
    const secs = [...div.querySelectorAll('.pr-summary')];
    const lines = sec => [...sec.querySelectorAll('.pr-sum-heading, .pr-sum-location, .pr-sum-line')].map(e => e.textContent);
    return { titles: secs.map(x => x.querySelector('.pr-summary-title').textContent), blue: lines(secs[0]), red: lines(secs[1]),
             thaadChip: _fmtChips(48 / 48), half: _fmtChips(18 / 36), label: _printSystemLabel(DEFENSE_CATALOG.thaad) };
  });
  check(r.titles.join('|') === 'Chip Changes — Blue|Platform Losses — Red', 'summaries: both sections close the report');
  check(r.blue[0] === 'Bahrain' && r.blue[1] === 'U.S. Fifth Fleet' && r.blue[2] === 'Patriot (Bahrain): -1 chip (-36 ints.)',
        'summaries: country, location, then "-1 chip (-36 ints.)" for one Patriot load ' + JSON.stringify(r.blue.slice(0, 3)));
  check(r.blue.includes('Patriot (Qatar): -3 chips (-108 ints.)'), 'summaries: a three-system Patriot entry emptied is three chips');
  check(r.thaadChip === '-1 chip' && r.half === '-0.5 chips' && r.label === 'THAAD', 'summaries: chip wording and THAAD short label');
  check(JSON.stringify(r.red) === JSON.stringify(['Short-Range Ballistic Missiles', 'Fateh-110: -10', 'Drones', 'Geran-2: -500']),
        'summaries: Red losses sum salvos by type (Geran-2 200+150+150 = -500) ' + JSON.stringify(r.red));
  check(errs.length === 0, 'summaries: no page errors ' + JSON.stringify(errs));
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
    summary: document.getElementById('pk-summary').textContent,
    counts: (() => { let n = 0, t = 0; for (const row of Object.values(window._pkState().table.cells)) for (const c of Object.values(row)) { t++; if (c.pk > 0) n++; } return [n, t]; })()
  }));
  check(r1.rows === 23 && r1.cols === 24, 'pk: matrix is 23 × 24');
  check(r1.patriot === '0.4687' && r1.thaadZero && r1.deDisabled, 'pk: defaults, zero shading and DE shots disabled');
  check(r1.summary === `${r1.counts[0]} of ${r1.counts[1]} pairings engage` && r1.counts[1] === 23 * 24, 'pk: summary counts engageable pairings (' + r1.summary + ')');

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
  // Locked systems: F-15I is fixed in the default doctrine
  await page.evaluate(async () => { const raw = await fetch('data/doctrine.json').then(r => r.json()); window._doctrineApplyData(raw); });
  const r2b = await page.evaluate(() => {
    const col  = document.querySelector('.dc-col[data-type="drone"]');
    const card = col.querySelector('.dc-card[data-system="f15i_patrol"]');
    const before = window._doctrineState().doctrine.engage.drone.slice();
    moveSystem('drone', 0, 3);                       // move the F-15E past the locked card
    const after = window._doctrineState().doctrine.engage.drone.slice();
    removeSystem('drone', after.indexOf('f15i_patrol'));
    const afterRemove = window._doctrineState().doctrine.engage.drone.slice();
    const ex = window._doctrineBuildExport('L');
    return { locked: card?.classList.contains('dc-card--locked'), lockIcon: !!card?.querySelector('.dc-lock'), noRemove: !card?.querySelector('.dc-btn-remove'),
      idxBefore: before.indexOf('f15i_patrol'), idxAfter: after.indexOf('f15i_patrol'), movedFirst: after[0], stillThere: afterRemove.includes('f15i_patrol'), exportLocked: ex.locked };
  });
  check(r2b.locked && r2b.lockIcon && r2b.noRemove, 'doctrine: locked card shows a lock and no remove button');
  check(r2b.idxBefore === 2 && r2b.idxAfter === 2 && r2b.movedFirst === 'fa18_patrol', 'doctrine: moving another card past the locked one leaves it at its index');
  check(r2b.stillThere && JSON.stringify(r2b.exportLocked) === '["f15i_patrol"]', 'doctrine: locked card cannot be removed and the export carries locked');
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
// Blue builder — type-ahead System / Operator boxes, Enter moves field to field
// ─────────────────────────────────────────────────────────────────────────────
async function checkBlueBuilder(browser, base) {
  console.log('\n── blue builder ──');
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = collectErrors(page);
  await page.goto(base + '/blue/');
  await page.waitForFunction(() => window._blueReady === true, { timeout: 20000 });
  await page.evaluate(() => localStorage.removeItem('threatmodel_blue_builder_v1'));
  await page.reload(); await page.waitForFunction(() => window._blueReady === true);
  await page.evaluate(() => window._blueApplyData({ version: '1.0', defaults: {} }));   // start empty

  const card   = '#tc-doha';
  const active = () => page.evaluate(() => document.activeElement?.className || '');
  const labels = sel => page.$$eval(`${sel} .ta-option .ta-option-label`, els => els.map(e => e.textContent));
  const entries = () => page.evaluate(() => window._blueState().laydown.doha || []);
  const center  = sel => page.$eval(sel, e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));   // clear of the sticky header; instant, as the page scrolls smoothly

  await center(`${card} .tc-btn-add`); await page.click(`${card} .tc-btn-add`);
  const r1 = await page.evaluate(c => ({
    focused: document.activeElement.classList.contains('tc-system'),
    groups:  [...document.querySelectorAll(`${c} .tc-system + .ta-list .ta-group`)].map(g => g.textContent)
  }), card);
  check(r1.focused && r1.groups.join(',') === 'Presets,Systems', 'blue: opening the form focuses System and lists the grouped full list');

  await page.keyboard.type('Pat');
  const l1 = await labels(`${card} .tc-system + .ta-list`);
  check(l1[0] === 'Patriot' && l1.slice(1).length === 3 && l1.slice(1).every(x => x.includes('Patrol')), 'blue: "Pat" lists Patriot first, then the three Patrol entries (' + l1.join(' | ') + ')');

  await page.keyboard.press('Enter');
  const a1 = await active();
  await page.keyboard.type('4');   await page.keyboard.press('Enter');
  const a2 = await active();
  await page.keyboard.type('Bah'); await page.keyboard.press('Enter');
  const a3 = await active();
  await page.keyboard.type('6');   await page.keyboard.press('Enter');
  const a4 = await active();
  check(a1.includes('tc-qty') && a2.includes('tc-operator') && a3.includes('tc-chips') && a4.includes('tc-notes'),
        'blue: Enter moves System → Quantity → Operator → Chips → Notes (' + [a1, a2, a3, a4].join(' / ') + ')');
  await page.keyboard.press('Enter');
  const e1 = await entries();
  const after = await page.evaluate(c => ({
    formOpen: !document.querySelector(`${c} .tc-add-form`).classList.contains('hidden'),
    focused:  document.activeElement.classList.contains('tc-system'),
    system:   document.querySelector(`${c} .tc-system`).value,
    operator: document.querySelector(`${c} .tc-operator`).value,
    qty:      document.querySelector(`${c} .tc-qty`).value,
    chips:    document.querySelector(`${c} .tc-chips`).value
  }), card);
  const last = e1[e1.length - 1] || {};
  check(e1.length === 1 && last.system === 'patriot' && last.quantity === 4 && last.operator === 'Bahrain' && last.chips === 6,
        'blue: keyboard-only entry adds Patriot × 4, Bahrain, 6 chips ' + JSON.stringify(last));
  check(after.formOpen && after.focused && after.system === '' && after.operator === 'Bahrain' && after.qty === '1' && after.chips === '1',
        'blue: after an add the form stays open, System is focused and empty, Operator is kept ' + JSON.stringify(after));

  await page.keyboard.type('Pat'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  const r2 = await page.evaluate(c => ({ sys: document.querySelector(`${c} .tc-system`).value, qtyDisabled: document.querySelector(`${c} .tc-qty`).disabled, focused: document.activeElement.className }), card);
  check(r2.sys.startsWith('F-15E Patrol') && r2.qtyDisabled && r2.focused.includes('tc-operator'), 'blue: ↓ picks the first Patrol; quantity is locked so focus skips to Operator ' + JSON.stringify(r2));

  // Invalid operator text reverts on blur; Escape closes the popup first
  await page.keyboard.type('Narnia');
  const empty = await page.$eval(`${card} .tc-operator + .ta-list .ta-empty`, e => e.textContent).catch(() => null);
  await page.keyboard.press('Enter');
  const stillOp = await active();
  await page.keyboard.press('Escape');
  const popupClosed = await page.$eval(`${card} .tc-operator + .ta-list`, e => e.classList.contains('hidden'));
  await page.keyboard.press('Tab');
  const opAfter = await page.$eval(`${card} .tc-operator`, e => e.value);
  check(empty === 'No matching nations' && stillOp.includes('tc-operator') && popupClosed && opAfter === 'Bahrain',
        'blue: no match shows a message, Enter does nothing, Escape closes, blur reverts the operator (' + opAfter + ')');

  // Click a row: focus System, type, click "Iron Dome"
  await center(`${card} .tc-system`); await page.click(`${card} .tc-system`);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');   // close, then clear
  await page.keyboard.type('Iron');
  await page.click(`${card} .tc-system + .ta-list .ta-option:has-text("Iron Dome")`);
  const r3 = await page.evaluate(c => ({ sys: document.querySelector(`${c} .tc-system`).value, focused: document.activeElement.className, mag: document.querySelector(`${c} .tc-mag`).textContent }), card);
  check(r3.sys === 'Iron Dome' && r3.focused.includes('tc-qty') && r3.mag.includes('interceptors'), 'blue: clicking a row chooses it and moves to Quantity ' + JSON.stringify(r3));

  // Preset locks quantity; Add System button still works from any field
  await center(`${card} .tc-system`); await page.click(`${card} .tc-system`);
  await page.keyboard.type('carrier'); await page.keyboard.press('Enter');
  const r4 = await page.evaluate(c => ({ qtyDisabled: document.querySelector(`${c} .tc-qty`).disabled, focused: document.activeElement.className }), card);
  await center(`${card} .tc-confirm`); await page.click(`${card} .tc-confirm`);
  const e2 = await entries();
  check(r4.qtyDisabled && r4.focused.includes('tc-operator') && e2.length > 2, 'blue: a preset is found, locks quantity, and the Add button adds its components');

  // Matching rules
  const m = await page.evaluate(() => {
    const sys = systemTypeAheadItems(), ops = operatorTypeAheadItems(), first = (items, q, n = 1) => typeAheadFilter(items, q).slice(0, n).map(i => i.id).join(',');
    return { thaad: first(sys, 'thaad'), sm: first(sys, 'sm', 3), dome: first(sys, 'dome'), f15: first(sys, 'f15'), nasams: first(sys, 'nasams'),
             uae: first(ops, 'uae'), us: first(ops, 'us'), arab: first(ops, 'arab', 2), zzz: typeAheadFilter(sys, 'zzz').length };
  });
  check(m.thaad === 'thaad' && m.sm === 'aegis_sm2,aegis_sm3,aegis_sm6' && m.dome === 'iron_dome' && m.f15 === 'f15e_patrol' && m.nasams === 'nasams'
        && m.uae === 'United Arab Emirates' && m.us === 'United States' && m.arab === 'Saudi Arabia,United Arab Emirates' && m.zzz === 0,
        'blue: matching by name, word, abbreviation and compact form ' + JSON.stringify(m));

  // Export matches the entered values
  const ex = await page.evaluate(() => window._blueBuildExport('T').defaults.doha);
  check(ex[0].system === 'patriot' && ex[0].quantity === 4 && ex[0].operator === 'Bahrain' && ex[0].chips === 6, 'blue: export carries the type-ahead entry');

  await page.evaluate(() => localStorage.removeItem('threatmodel_blue_builder_v1'));
  check(errs.length === 0, 'blue: no page errors ' + JSON.stringify(errs));
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Red builder — type-ahead Platform box, Enter to Salvo, Enter adds
// ─────────────────────────────────────────────────────────────────────────────
async function checkRedBuilder(browser, base) {
  console.log('\n── red builder ──');
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = collectErrors(page);
  await page.goto(base + '/red/');
  await page.waitForFunction(() => window._redReady === true, { timeout: 20000 });
  await page.evaluate(() => localStorage.removeItem('threatmodel_red_builder_v1'));
  await page.reload(); await page.waitForFunction(() => window._redReady === true);
  const col    = '#attack-col-0';
  const active = () => page.evaluate(() => document.activeElement?.className || '');

  await page.click(`${col} .rc-platform`);
  const groups = await page.$$eval(`${col} .ta-group`, els => els.map(e => e.textContent));
  check(groups.length >= 5 && groups[0].startsWith('Medium-Range'), 'red: clicking the empty box lists platforms grouped by threat type');

  await page.keyboard.type('Fat'); await page.keyboard.press('Enter');
  const r1 = await page.evaluate(c => ({ focused: document.activeElement.className, qty: document.querySelector(`${c} .rc-qty`).value }), col);
  const firstSalvo = await page.evaluate(() => String(PLATFORM_CATALOG.fateh_110.salvo_sizes?.[0] ?? 1));
  check(r1.focused.includes('rc-qty') && r1.qty === firstSalvo, 'red: "Fat" + Enter focuses Salvo seeded with the first salvo size ' + JSON.stringify(r1));

  await page.keyboard.type('12'); await page.keyboard.press('Enter');
  const r2 = await page.evaluate(c => ({ manifest: window._redState().attacks[0].manifest, focused: document.activeElement.className,
                                         box: document.querySelector(`${c} .rc-platform`).value, qtyDisabled: document.querySelector(`${c} .rc-qty`).disabled }), col);
  check(JSON.stringify(r2.manifest) === '[{"platformId":"fateh_110","count":12}]' && r2.focused.includes('rc-platform') && r2.box === '' && r2.qtyDisabled,
        'red: typing replaces the seeded salvo; Enter adds 12 × Fateh-110 and returns to an empty Platform box ' + JSON.stringify(r2));

  await page.keyboard.type('mrbm');
  const tags = await page.$$eval(`${col} .ta-option-tag`, els => els.map(e => e.textContent));
  check(tags.length >= 4 && tags.every(t => t === 'MRBM'), 'red: "mrbm" lists the MRBMs, each tagged MRBM (' + tags.length + ')');

  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.keyboard.type('Sha'); await page.keyboard.press('Tab');
  const r3 = await page.evaluate(c => ({ box: document.querySelector(`${c} .rc-platform`).value, focused: document.activeElement.className }), col);
  check(r3.box === 'Shahab-3' && r3.focused.includes('rc-qty'), 'red: Tab takes the highlighted platform and moves to Salvo ' + JSON.stringify(r3));

  await page.evaluate(() => localStorage.removeItem('threatmodel_red_builder_v1'));
  check(errs.length === 0, 'red: no page errors ' + JSON.stringify(errs));
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
const { server, base } = await startServer();
const browser = await chromium.launch();
try {
  if (!ONLY || ONLY === 'tool')     await checkTool(browser, base);
  if (!ONLY || ONLY === 'tool')     await checkReportSummaries(browser, base);
  if (!ONLY || ONLY === 'pk')       await checkPkBuilder(browser, base);
  if (!ONLY || ONLY === 'doctrine') await checkDoctrineBuilder(browser, base);
  if (!ONLY || ONLY === 'blue')     await checkBlueBuilder(browser, base);
  if (!ONLY || ONLY === 'red')      await checkRedBuilder(browser, base);
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter(r => !r.ok);
console.log(`\n[e2e] ${results.length - failed.length} / ${results.length} checks passed${failed.length ? ' — FAILED: ' + failed.map(f => f.label).join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
