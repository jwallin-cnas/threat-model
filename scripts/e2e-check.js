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
 *   node scripts/e2e-check.js [--only tool|pk|doctrine|blue|red|reload|export|patrols|water|replay|attrition]
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
    appAttrition = null;   // these numbers match the engine tests, which have no attrition (checked in its own section)
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
    const a2 = { mag: { ...globalMagState }, jaFull: _fullOfId('jebel_ali_port_d1') };
    clearAllOverrides();
    const a3 = { notice: !document.getElementById('override-notice').classList.contains('hidden'), mag: { ...globalMagState }, headline: document.querySelector('.final-headline').textContent };
    return { a1, a2, a3 };
  });
  check(r2.a1.notice && r2.a1.badge && r2.a1.mag.dubai_d1 === 0, 'tool: kill override renders and keeps the Dubai Patriot spent');
  check(r2.a2.mag.jebel_ali_port_d1 === undefined || r2.a2.mag.jebel_ali_port_d1 === r2.a2.jaFull, 'tool: disengage override restores that battery to full');
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
  const realErrs = errs.filter(e => !/status of 403/.test(e));   // map tiles refused for 127.0.0.1
  check(realErrs.length === 0, 'tool: no page errors ' + JSON.stringify(realErrs));
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Independent patrols — each its own magazine, cap and number; old shared ids still pooled
// ─────────────────────────────────────────────────────────────────────────────
async function checkIndependentPatrols(browser, base) {
  console.log('\n── independent patrols ──');
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = collectErrors(page);
  await page.goto(base + '/index.html'); await page.waitForFunction(() => window._appReady === true, { timeout: 20000 });
  await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForFunction(() => window._appReady === true);

  // 1. Add three F-15E patrols: one at Tel Aviv, two at Al Dhafra
  const add = await page.evaluate(async () => {
    addDefense('tel_aviv', 'f15e_patrol', 1, '');
    await new Promise(r => setTimeout(r, 2));
    addDefense('al_dhafra_ab', 'f15e_patrol', 1, '');
    await new Promise(r => setTimeout(r, 2));
    addDefense('al_dhafra_ab', 'f15e_patrol', 1, 'second');
    const ids = appTargetCatalog.flatMap(t => (t.defenses || []).filter(d => d.system === 'f15e_patrol').map(d => ({ t: t.id, id: d.id, q: d.quantity, op: d.operator })));
    const nums = patrolNumbers();
    return { ids, labels: ids.map(x => `${x.t}: ${defLabel(x.id, 'F-15E')}`) };
  });
  const uniq = new Set(add.ids.map(x => x.id)).size;
  check(add.ids.length === 3 && uniq === 3 && add.ids.every(x => x.q === 1 && x.op === 'United States'), 'patrols: three F-15E patrols added, two at one location, each with its own id ' + JSON.stringify(add.ids.map(x => x.id)));
  check(JSON.stringify(add.labels) === JSON.stringify(['tel_aviv: F-15E #1', 'al_dhafra_ab: F-15E #2', 'al_dhafra_ab: F-15E #3']), 'patrols: numbered #1–#3 in target order ' + JSON.stringify(add.labels));
  await page.selectOption('#target-select', 'al_dhafra_ab');
  const cards = await page.$$eval('.defense-name', els => els.map(e => e.textContent.trim()).filter(t => /F-15E/.test(t)));
  check(cards.includes('F-15E Patrol (×4) #2') && cards.includes('F-15E Patrol (×4) #3'), 'patrols: Al Dhafra cards show #2 and #3 ' + JSON.stringify(cards));

  // 2. An attack on Al Dhafra: the two patrols fire from separate magazines with separate caps
  await page.selectOption('#target-select', 'dubai');   // the direct queue hook stores results for other targets only
  const sim = await page.evaluate(() => {
    const ids = getTarget('al_dhafra_ab').defenses.filter(d => d.system === 'f15e_patrol').map(d => d.id);
    window._setSeed(0);
    window._importAttackQueueDirect({ version: '1.0', attacks: [{ targetId: 'al_dhafra_ab', platforms: [{ platformId: 'shahed_136', quantity: 300 }] }] });
    return null;
  });
  await page.waitForTimeout(5);
  const run = await page.evaluate(() => {
    window._simulateQueueDirect();
    const s = simHistory[simHistory.length - 1];
    const pat = allEngagements(s.results).filter(e => e.systemId === 'f15e_patrol');
    const div = document.createElement('div'); div.innerHTML = window._buildPrintDocument();
    const block = [...div.querySelectorAll('.pr-sum-block')].find(b => /Al Dhafra/.test(b.querySelector('.pr-sum-location').textContent));
    const lines = block ? [...block.querySelectorAll('.pr-sum-line')].map(e => e.textContent).filter(t => /F-15E/.test(t)) : [];
    const rows = [...div.querySelectorAll('.pr-table td:first-child')].map(td => td.textContent.trim()).filter(t => /F-15E/.test(t));
    return { pat: pat.map(e => ({ id: e.defId, label: defLabel(e.defId, 'F-15E'), killed: e.killed, used: e.interceptorsUsed, left: e.magazineRemaining, in: e.threatsIn })), lines, rows: [...new Set(rows)] };
  });
  await page.selectOption('#target-select', 'dubai'); await page.selectOption('#target-select', 'al_dhafra_ab');   // open the attacked location as a user would
  run.results = await page.$$eval('#simulation-results .eng-name', els => [...new Set(els.map(e => e.textContent.trim()).filter(t => /F-15E/.test(t)))]);
  const [p2, p3] = run.pat;
  check(run.pat.length === 2 && p2.id !== p3.id && p2.left >= 0 && p3.in === p2.in - p2.killed, 'patrols: both Al Dhafra patrols engage in turn, each from its own magazine ' + JSON.stringify(run.pat));
  check(run.lines.length === 2 && run.lines.some(l => l.startsWith('F-15E Patrol (×4) #2 (United States)')) && run.lines.some(l => l.startsWith('F-15E Patrol (×4) #3 (United States)')),
        'patrols: the report chip summary lists #2 and #3 under Al Dhafra ' + JSON.stringify(run.lines));
  check(run.rows.some(r => /#2/.test(r)) && run.rows.some(r => /#3/.test(r)) && run.results.includes('F-15E Patrol (×4) #2') && run.results.includes('F-15E Patrol (×4) #3'), 'patrols: report tables and the results panel carry the numbers ' + JSON.stringify({ rows: run.rows, results: run.results }));

  // 3. Reset All Loadouts at Al Dhafra resets both patrols; removing one renumbers
  const rr = await page.evaluate(() => {
    selectedTargetId = 'al_dhafra_ab'; resetLoadouts();
    const ids = getTarget('al_dhafra_ab').defenses.filter(d => d.system === 'f15e_patrol').map(d => d.id);
    const afterReset = ids.map(id => globalMagState[id] ?? 'full');
    removeDefense('al_dhafra_ab', ids[0]);
    const left = appTargetCatalog.flatMap(t => (t.defenses || []).filter(d => d.system === 'f15e_patrol').map(d => `${t.id}: ${defLabel(d.id, 'F-15E')}`));
    return { afterReset, removedMag: ids[0] in globalMagState, left };
  });
  check(rr.afterReset.every(v => v === 'full') && !rr.removedMag && JSON.stringify(rr.left) === JSON.stringify(['tel_aviv: F-15E #1', 'al_dhafra_ab: F-15E #2']),
        'patrols: Reset All Loadouts refills both; removing one drops its magazine and renumbers ' + JSON.stringify(rr));

  // 4. An older laydown with one shared patrol id at two locations still pools
  const legacy = await page.evaluate(() => {
    const e = (t, c) => ({ id: 'shared_fa18_patrol', system: 'fa18_patrol', quantity: 1, notes: '', operator: 'United States', chips: c });
    window._importLaydownDirect({ version: '1.0', defaults: { gulf_of_oman_place_point: [e('gulf_of_oman_place_point', 2)], fujairah_port: [e('fujairah_port', 2)] } });
    const sel = document.getElementById('target-select'); sel.value = 'fujairah_port'; sel.dispatchEvent(new Event('change'));
    globalMagState.shared_fa18_patrol = 10;
    const label = defLabel('shared_fa18_patrol', 'F/A-18');
    selectedTargetId = 'fujairah_port'; resetLoadouts();   // listed elsewhere too → left alone
    const keptAfterReset = globalMagState.shared_fa18_patrol;
    const exported = buildLaydownStateExport().data.defaults;
    return { label, keptAfterReset, reserves: [findDefenseEntryById('shared_fa18_patrol').reloads],
             exportIds: [exported.gulf_of_oman_place_point?.[0]?.id, exported.fujairah_port?.[0]?.id] };
  });
  check(legacy.label === 'F/A-18' && legacy.keptAfterReset === 10 && legacy.exportIds.every(id => id === 'shared_fa18_patrol'),
        'patrols: an older shared patrol at two locations is still one unnumbered patrol, kept by a reset and by export ' + JSON.stringify(legacy));

  // 5. Blue Builder: repeated patrols allowed, numbered across cards, unique ids on export; old shared id kept
  const blue = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await blue.goto(base + '/blue/'); await blue.waitForFunction(() => window._blueReady === true);
  const b = await blue.evaluate(() => {
    window._blueApplyData({ version: '1.0', defaults: { gulf_of_oman_place_point: [{ id: 'shared_fa18_patrol', system: 'fa18_patrol', quantity: 1, notes: '', operator: 'United States', chips: 2 }] } });
    renderAll();
    addEntries('doha', 'f15e_patrol', 1, '', 'United States', 1); refreshCard('doha');
    addEntries('doha', 'f15e_patrol', 1, '', 'United States', 1);
    addEntries('tel_aviv', 'f15e_patrol', 1, '', 'United States', 1);
    refreshPatrolCards('f15e_patrol');
    const names = id => [...document.querySelectorAll(`#tc-${id} .tc-defense-name`)].map(e => e.textContent.trim());
    const ex = window._blueBuildExport('T').defaults;
    localStorage.removeItem('threatmodel_blue_builder_v1');
    return { doha: names('doha').filter(n => /F-15E/.test(n)), telAviv: names('tel_aviv').filter(n => /F-15E/.test(n)), fa18: names('gulf_of_oman_place_point').filter(n => /F\/A-18/.test(n)),
             ids: [...ex.doha.map(e => e.id), ...ex.tel_aviv.map(e => e.id)], fa18Id: ex.gulf_of_oman_place_point[0].id, file: ex };
  });
  check(JSON.stringify(b.telAviv) === JSON.stringify(['F-15E Patrol (×4) #1']) && JSON.stringify(b.doha) === JSON.stringify(['F-15E Patrol (×4) #2', 'F-15E Patrol (×4) #3']) && JSON.stringify(b.fa18) === JSON.stringify(['F/A-18 Patrol (×4)']),
        'builder: two F-15Es at one location allowed, numbered #1–#3 across cards; a single patrol is unnumbered ' + JSON.stringify([b.telAviv, b.doha, b.fa18]));
  check(new Set(b.ids).size === 3 && b.ids.every(id => !/^shared_/.test(id)) && b.fa18Id === 'shared_fa18_patrol', 'builder: new patrols export with their own ids; the old shared id is kept ' + JSON.stringify({ ids: b.ids, fa18: b.fa18Id }));
  await blue.close();

  // 6. The tool imports the builder file: three independent F-15Es; the laydown document numbers them the same way
  const back = await page.evaluate(d => { const r = window._importLaydownDirect({ version: '1.0', name: 'T', defaults: d });
    return { w: r.warnings, labels: appTargetCatalog.flatMap(t => (t.defenses || []).filter(x => x.system === 'f15e_patrol').map(x => `${t.id}: ${defLabel(x.id, 'F-15E')}`)) }; }, b.file);
  check(back.w.length === 0 && JSON.stringify(back.labels) === JSON.stringify(['tel_aviv: F-15E #1', 'doha: F-15E #2', 'doha: F-15E #3']), 'patrols: the tool imports the builder file with the same numbering ' + JSON.stringify(back));
  const tmp = path.join(ROOT, 'output', `e2e_patrols_${Date.now()}`); fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({ version: '1.0', name: 'Patrol Test', defaults: b.file }));
  const { spawnSync } = await import('child_process');
  const py = spawnSync('python3', [path.join(ROOT, 'scripts', 'laydown-docx.py'), path.join(tmp, 'p.json'), '--out-dir', tmp], { encoding: 'utf8' });
  const docx = fs.readdirSync(tmp).find(f => f.endsWith('.docx'));
  const xml = docx ? spawnSync('unzip', ['-p', path.join(tmp, docx), 'word/document.xml'], { encoding: 'utf8' }).stdout : '';
  const docLines = [...xml.matchAll(/<w:t[^>]*>([^<]*F-15E[^<]*)<\/w:t>/g)].map(m => m[1]);
  fs.rmSync(tmp, { recursive: true, force: true });
  check(py.status === 0 && docLines.length === 3 && docLines.some(l => l.startsWith('F-15E Patrol (×4) #1 ')) && docLines.filter(l => /#2 |#3 /.test(l)).length === 2,
        'patrols: the laydown document numbers them #1–#3 too ' + JSON.stringify(docLines));

  const realErrs = errs.filter(e => !/status of 403/.test(e));
  check(realErrs.length === 0, 'patrols: no page errors ' + JSON.stringify(realErrs));
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Export Laydown — current state as chips, re-imported with Import Laydown
// ─────────────────────────────────────────────────────────────────────────────
async function checkLaydownExport(browser, base) {
  console.log('\n── export laydown ──');
  // Counts follow the shipped default laydown, which the Box sync can change.
  const DEF = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'defaults.json'), 'utf8')).defaults;
  const nSys = Object.values(DEF).reduce((n, l) => n + l.length, 0), nLoc = Object.keys(DEF).length;
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = collectErrors(page);
  await page.goto(base + '/index.html'); await page.waitForFunction(() => window._appReady === true, { timeout: 20000 });
  await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForFunction(() => window._appReady === true);

  // 1. The stated example: Patriot at 0 of 36 with 2 reserve chips → exports 2 chips → imports 36 of 36 with 1 reserve chip
  const ex = await page.evaluate(() => {
    const t = getTarget('isa_ab');
    t.defenses = [_ingestDefenseEntry({ id: 'isa_ab_d1', system: 'patriot', quantity: 1, notes: '', operator: 'Bahrain', chips: 3 }, t)];
    globalMagState.isa_ab_d1 = 0;
    const out = buildLaydownStateExport().data;
    const entry = out.defaults.isa_ab[0];
    window._importLaydownDirect(out);
    return { chips: entry.chips, mag: globalMagState.isa_ab_d1 ?? 36, reserve: findDefenseEntryById('isa_ab_d1').reloads };
  });
  check(ex.chips === 2 && ex.mag === 36 && ex.reserve === 1, 'export: Patriot 0/36 + 2 reserve chips → 2 chips → 36/36 + 1 reserve chip ' + JSON.stringify(ex));

  // 2. Round trip after real attacks, a Reload, a switched-off system and a fractional THAAD magazine
  await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForFunction(() => window._appReady === true);
  const rt = await page.evaluate(async () => {
    window.showModal = async () => true;
    window._setSeed(0);
    window._importAttackQueueDirect({ version: '1.0', attacks: [
      { targetId: 'doha',     platforms: [{ platformId: 'shahed_136', quantity: 60 }, { platformId: 'fateh_110', quantity: 10 }] },
      { targetId: 'tel_aviv', platforms: [{ platformId: 'geran_2', quantity: 80 }, { platformId: 'shahab_3', quantity: 6 }] },
      { targetId: 'dubai',    platforms: [{ platformId: 'shahed_136', quantity: 40 }] } ] });
    window._simulateQueueDirect();
    await performGlobalReload();
    globalMagState.riyadh_d1 = 40.5;                     // THAAD after 1.5-shot salvos
    toggleOwnDefenseDisabled('jeddah', 'jeddah_d1');     // switched off
    const ammo = () => { const m = {}; for (const t of appTargetCatalog) for (const d of t.defenses || []) { const size = chipSizeFor(d); if (!size) continue;
      const c = DEFENSE_CATALOG[d.system]; const full = c.isShared ? c.magazinePerBattery : c.magazinePerBattery * d.quantity;
      m[`${t.id}/${d.id}`] = Math.round(((d.id in globalMagState ? globalMagState[d.id] : full) + (d.reloads ?? 0) * size) * 1e4) / 1e4; } return m; };
    const shape = () => appTargetCatalog.flatMap(t => (t.defenses || []).map(d => [t.id, d.id, d.system, d.quantity, d.operator, d.notes || '', !!d.disabled].join('|')));
    const before = { ammo: ammo(), shape: shape() };
    const { data, warnings } = buildLaydownStateExport();
    const r = window._importLaydownDirect(data);
    const after = { ammo: ammo(), shape: shape() };
    const diffs = Object.keys({ ...before.ammo, ...after.ammo }).filter(k => Math.abs((before.ammo[k] ?? -1) - (after.ammo[k] ?? -1)) > 1e-3).map(k => `${k}: ${before.ammo[k]} → ${after.ammo[k]}`);
    return { warnings, importWarnings: r.warnings, n: Object.values(data.defaults).flat().length, name: data.name, diffs, shapeSame: JSON.stringify(before.shape) === JSON.stringify(after.shape),
             spent: Object.values(before.ammo).filter((v, i) => v < Object.values(after.ammo)[i] + 1).length,
             thaad: { mag: globalMagState.riyadh_d1, chips: data.defaults.riyadh[0].chips }, jeddahOff: !!findDefenseEntryById('jeddah_d1').disabled, data };
  });
  check(rt.warnings.length === 0 && rt.importWarnings.length === 0 && rt.n === nSys, `export: ${rt.n} systems exported and re-imported without warnings (default laydown: ${nSys})`);
  check(rt.diffs.length === 0, 'export: every system keeps its total ammunition (loaded + reserve) through export and import ' + JSON.stringify(rt.diffs.slice(0, 4)));
  check(rt.shapeSame, 'export: placements, quantities, operators, notes and on/off switches are unchanged');
  check(rt.thaad.chips === 0.84375 && rt.thaad.mag === 40.5 && rt.jeddahOff, 'export: a fractional THAAD magazine (40.5 of 48) and a switched-off system survive ' + JSON.stringify(rt.thaad));
  check(/ — state after 3 attacks$/.test(rt.name), 'export: the file is named for the state it holds (' + rt.name + ')');

  // 3. The exported file passes the Box sync validator and the Blue Builder import
  const tmp = path.join(ROOT, 'output', `e2e_export_${Date.now()}.json`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(rt.data));
  const { spawnSync } = await import('child_process');
  const v = spawnSync('node', [path.join(ROOT, 'scripts', 'sync-laydown.js'), tmp, '--check'], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  check(v.status === 0 && v.stdout.includes(`Valid: ${nLoc} locations, ${nSys} systems`), 'export: the file passes the laydown validator (' + (v.stdout + v.stderr).trim().split('\n')[0] + ')');
  const blue = await browser.newPage(); await blue.goto(base + '/blue/'); await blue.waitForFunction(() => window._blueReady === true);
  const b = await blue.evaluate(d => { const w = window._blueApplyData(d); const ex2 = window._blueBuildExport(d.name);
    const pick = o => Object.fromEntries(Object.entries(o.defaults).map(([t, l]) => [t, l.map(e => [e.system, e.quantity, e.operator, e.chips, !!e.disabled].join('|'))]));
    localStorage.removeItem('threatmodel_blue_builder_v1');
    return { w: w.length, same: JSON.stringify(pick(ex2)) === JSON.stringify(pick(d)) }; }, rt.data);
  check(b.w === 0 && b.same, 'export: the Blue Builder imports it and re-exports the same systems, chips and switches');
  await blue.close();

  // 4. A battery count edited to a part system: rounded with a warning, same ammunition
  const q = await page.evaluate(() => { const d = findDefenseEntryById('dubai_d1'); d.quantity = 4; delete globalMagState.dubai_d1;
    const { data, warnings } = buildLaydownStateExport(); const e = data.defaults.dubai.find(x => x.id === 'dubai_d1'); return { warnings, q: e.quantity, chips: e.chips }; });
  check(q.warnings.length === 1 && q.q === 1 && q.chips === 1.333333, 'export: 4 Patriot batteries (1.33 systems, full) export as 1 system and 1.333333 chips (48 interceptors) with a warning ' + JSON.stringify(q));

  // 5. The header button downloads the file
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-laydown')]);
  const file = await dl.path(); const got = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(/^.+_state_after_\d+_attacks?_\d{4}-\d\d-\d\d_\d{4}\.json$/.test(dl.suggestedFilename()) && Object.keys(got.defaults).length === nLoc, 'export: the Export Laydown button downloads ' + dl.suggestedFilename());

  const realErrs = errs.filter(e => !/status of 403/.test(e));
  check(realErrs.length === 0, 'export: no page errors ' + JSON.stringify(realErrs));
  await page.close();
}
// ─────────────────────────────────────────────────────────────────────────────
// Reload and target switching — magazines survive revisits; Reload spends chips
// ─────────────────────────────────────────────────────────────────────────────
async function checkReloadAndSwitching(browser, base) {
  console.log('\n── reload & switching ──');
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = collectErrors(page);
  const fresh = async () => {
    await page.goto(base + '/index.html'); await page.waitForFunction(() => window._appReady === true, { timeout: 20000 });
    await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForFunction(() => window._appReady === true);
    await page.evaluate(() => { appAttrition = null; });   // exact counts below assume no attrition
  };
  const queue = attacks => page.evaluate(a => { window._setSeed(0); window._importAttackQueueDirect({ version: '1.0', attacks: a }); window._simulateQueueDirect(); }, attacks);
  // 'full' when the magazine is at capacity (absent key or an explicit full count)
  const magExpr = `(i => { const v = globalMagState[i]; const d = findDefenseEntryById(i); const c = DEFENSE_CATALOG[d.system];
    const full = c.isShared ? c.magazinePerBattery : c.magazinePerBattery * d.quantity; return (v == null || v >= full) ? 'full' : v; })`;
  const mag   = id => page.evaluate(`${magExpr}(${JSON.stringify(id)})`);
  const res   = id => page.evaluate(i => findDefenseEntryById(i).reloads, id);
  const pick  = id => page.selectOption('#target-select', id);
  const reloadBtn = async () => { await page.click('#btn-reload-all'); await page.waitForTimeout(100); };
  const A = 'al_udeid_ab_d1';   // Al Udeid Patriot (3 systems, 108), covers Doha
  const D50 = [{ targetId: 'doha', platforms: [{ platformId: 'shahed_136', quantity: 50 }] }];

  // 1. Card reset at home, then switch to the covered target
  await fresh(); await queue(D50);
  const a0 = await mag(A);
  await pick('al_udeid_ab'); await page.click(`.btn-reset-sys-loadout[data-defense-id="${A}"]`); await page.waitForTimeout(50);
  const a1 = await mag(A); await pick('doha'); const a2 = await mag(A);
  check(a0 < 108 && a1 === 'full' && a2 === 'full', `switching: a card reset survives a switch to a covered target (${a0} → ${a1} → ${a2})`);

  // 2. Reload, then switch: the refill stays and the chips stay spent
  await fresh(); await page.evaluate(i => { findDefenseEntryById(i).reloads = 3; }, A); await queue(D50);
  await pick('al_udeid_ab'); await reloadBtn();
  const r1 = { mag: await mag(A), res: await res(A) };
  await pick('doha');
  const r2 = { mag: await mag(A), res: await res(A), snap: await page.evaluate(i => simHistory[simHistory.length - 1].magStateAfter[i] ?? 'full', A) };
  check(r1.mag === 'full' && r2.mag === 'full' && r2.res === r1.res && (r2.snap === 'full' || r2.snap >= 108), 'switching: a Reload survives a switch, and its snapshot keeps the refill ' + JSON.stringify({ r1, r2 }));

  // 3. Two attacks, then switch back to the first target: no interceptors appear
  await fresh(); await queue([{ targetId: 'doha', platforms: [{ platformId: 'shahed_136', quantity: 30 }] }, { targetId: 'al_udeid_ab', platforms: [{ platformId: 'shahed_136', quantity: 30 }] }]);
  const t1 = await mag(A); await pick('doha'); const t2 = await mag(A); await pick('al_udeid_ab'); const t3 = await mag(A);
  check(t1 === t2 && t2 === t3, `switching: revisiting an older attack leaves magazines alone (${t1}, ${t2}, ${t3})`);

  // 4. The report is unchanged by the switch
  const chipLine = () => page.evaluate(() => { const d = document.createElement('div'); d.innerHTML = window._buildPrintDocument();
    return [...d.querySelectorAll('.pr-sum-block')].filter(x => /Al Udeid/.test(x.querySelector('.pr-sum-location').textContent)).map(x => x.textContent.replace(/\s+/g, ' ').trim()).join('|'); });
  const rep1 = await chipLine(); await pick('doha'); const rep2 = await chipLine();
  check(rep1 === rep2 && /-2\.83 chips \(-102 ints\.\)/.test(rep1), 'switching: the PDF chip summary does not change on a switch (' + rep1 + ')');

  // 5. Override on an OLDER attack: magazines and later history move by the difference only
  await pick('doha');
  const o = await page.evaluate(i => {
    const before = { live: globalMagState[i], laterPre: simHistory[2].preSimMagState[i], laterAfter: simHistory[2].magStateAfter[i] };
    applyLayerOverride('drone', 'shahed_136', i, 0, true);   // disengage A from the Doha attack
    const f = v => (v == null || v >= 108) ? 'full' : v;   // A holds 108
    const after = { live: f(globalMagState[i]), laterPre: f(simHistory[2].preSimMagState[i]), laterAfter: f(simHistory[2].magStateAfter[i]), dohaAfter: f(simHistory[1].magStateAfter[i]) };
    clearAllOverrides();
    const undone = { live: f(globalMagState[i]), laterAfter: f(simHistory[2].magStateAfter[i]) };
    return { before, after, undone };
  }, A);
  const used = 108 - o.before.laterPre;   // what A fired at Doha
  check(o.after.live === o.before.live + used && o.after.laterPre === 'full' && o.after.laterAfter === o.before.laterAfter + used && o.after.dohaAfter === 'full'
        && o.undone.live === o.before.live && o.undone.laterAfter === o.before.laterAfter,
        'overrides: disengaging a system in an older attack returns only what it fired there, through later history ' + JSON.stringify(o));

  // 6. Reload decrements chips and refills: full refill, half refill on 0.5 chip, fractional cost
  await fresh();
  const rl = await page.evaluate(async () => {
    const t = getTarget('doha');
    const mk = (id, sys, q, chips) => _ingestDefenseEntry({ id, system: sys, quantity: q, notes: '', operator: 'Qatar', chips }, t);
    t.defenses = [mk('R_full', 'patriot', 1, 2), mk('R_half', 'patriot', 1, 1.5), mk('R_two', 'patriot', 2, 3), mk('R_part', 'patriot', 1, 2), mk('R_none', 'patriot', 1, 1)];
    globalMagState.R_full = 0; globalMagState.R_half = 0; globalMagState.R_two = 0; globalMagState.R_part = 18; globalMagState.R_none = 0;
    const res0 = Object.fromEntries(t.defenses.map(d => [d.id, d.reloads]));
    saveToStorage();
    return res0;
  });
  await pick('doha'); await reloadBtn();
  const rl2 = await page.evaluate(() => {
    const ids = ['R_full', 'R_half', 'R_two', 'R_part', 'R_none'];
    const cards = Object.fromEntries(ids.map(id => [id, document.querySelector(`[data-defense-id="${id}"]`)?.closest('.defense-card')?.querySelector('.defense-reloads')?.textContent.trim()]));
    const m = i => { const v = globalMagState[i]; const d = findDefenseEntryById(i); return (v == null || v >= DEFENSE_CATALOG[d.system].magazinePerBattery * d.quantity) ? 'full' : v; };
    return { mag: Object.fromEntries(ids.map(id => [id, m(id)])), res: Object.fromEntries(ids.map(id => [id, findDefenseEntryById(id).reloads])), cards,
             snap: simHistory[simHistory.length - 1].type };
  });
  check(JSON.stringify(rl) === JSON.stringify({ R_full: 1, R_half: 0.5, R_two: 1, R_part: 1, R_none: 0 }), 'reload: reserve chips at start ' + JSON.stringify(rl));
  check(rl2.mag.R_full === 'full' && rl2.res.R_full === 0, 'reload: 1 reserve chip refills an empty Patriot (36) and is spent');
  check(rl2.mag.R_half === 18 && rl2.res.R_half === 0, 'reload: 0.5 reserve chip refills an empty Patriot to half (18 of 36)');
  check(rl2.mag.R_two === 36 && rl2.res.R_two === 0, 'reload: 1 chip on an empty 2-system entry refills one system (36 of 72)');
  check(rl2.mag.R_part === 'full' && rl2.res.R_part === 0.5, 'reload: topping up 18 of 36 costs 0.5 chip and keeps 0.5');
  check(rl2.mag.R_none === 0 && rl2.res.R_none === 0, 'reload: an entry with no reserve chips stays empty');
  check(rl2.cards.R_part === '↻ 0.5 reserve chips' && rl2.cards.R_full === '↻ 0 reserve chips' && rl2.snap === 'reload', 'reload: cards show reserve chips; a reload snapshot is recorded ' + JSON.stringify(rl2.cards));

  // 7. A second Reload spends the kept 0.5 chip on the next shortfall, then nothing is left
  await page.evaluate(() => { globalMagState.R_part = 0; }); await reloadBtn();
  const rl3 = await page.evaluate(() => ({ mag: globalMagState.R_part ?? 'full', res: findDefenseEntryById('R_part').reloads }));
  check(rl3.mag === 18 && rl3.res === 0, 'reload: the kept 0.5 chip later refills 18 interceptors ' + JSON.stringify(rl3));

  // 8. Undo and redo through the reload restore magazines and chips
  const u = await page.evaluate(() => {
    const last = simHistory.length - 1;
    const m = () => { const v = globalMagState.R_part; return (v == null || v >= 36) ? 'full' : v; };
    navigateToSnapshot(last - 1); const back = { mag: m(), res: findDefenseEntryById('R_part').reloads };
    navigateToSnapshot(last);     const fwd  = { mag: m(), res: findDefenseEntryById('R_part').reloads };
    return { back, fwd };
  });
  check(u.back.mag === 'full' && u.back.res === 0.5 && u.fwd.mag === 18 && u.fwd.res === 0, 'reload: undo and redo restore magazine and reserve chips ' + JSON.stringify(u));

  // 9. Reload persists across a page reload
  await page.reload(); await page.waitForFunction(() => window._appReady === true);
  const p9 = await page.evaluate(() => ({ mag: globalMagState.R_part ?? 'full', res: findDefenseEntryById('R_part')?.reloads, half: globalMagState.R_half ?? 'full' }));
  check(p9.mag === 18 && p9.res === 0 && p9.half === 18, 'reload: magazines and reserve chips survive a page reload ' + JSON.stringify(p9));

  const realErrs = errs.filter(e => !/status of 403/.test(e));   // map tiles refused for 127.0.0.1
  check(realErrs.length === 0, 'reload & switching: no page errors ' + JSON.stringify(realErrs));
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
    const groups = sec => [...sec.querySelectorAll('.pr-sum-group')].map(lines);
    // Expected Blue totals, built from the laydown and history independently of the report code
    const group = op => op === 'United States' ? 'United States' : op === 'Israel' ? 'Israel' : 'Ally/Partner';
    const inv = (def, snap) => {
      const full = DEFENSE_CATALOG[def.system].magazinePerBattery * def.quantity;
      return (def.id in snap.magStateAfter ? snap.magStateAfter[def.id] : full) + (snap.reloadsState[def.id] ?? 0) * chipSizeFor(def);
    };
    const exp = {}, seen = new Set();
    for (const t of appTargetCatalog) for (const d of t.defenses || []) {
      if (seen.has(d.id) || !(chipSizeFor(d) > 0)) continue; seen.add(d.id);
      const k = group(d.operator) + ': ' + _printSystemLabel(DEFENSE_CATALOG[d.system]);
      exp[k] = exp[k] || { start: 0, end: 0 };
      exp[k].start += inv(d, simHistory[0]); exp[k].end += inv(d, simHistory[simHistory.length - 1]);
    }
    return { titles: secs.map(x => x.querySelector('.pr-summary-title').textContent), blue: groups(secs[0]).slice(1).flat(), red: lines(secs[1]),
             blueTotals: groups(secs[0])[0], redTotals: groups(secs[1])[0], exp,
             thaadChip: _fmtChips(48 / 48), half: _fmtChips(18 / 36), label: _printSystemLabel(DEFENSE_CATALOG.thaad) };
  });
  check(r.titles.join('|') === 'Chip Changes — Blue|Platform Losses — Red', 'summaries: both sections close the report');
  check(r.blue[0] === 'Bahrain' && r.blue[1] === 'U.S. Fifth Fleet' && r.blue[2] === 'Patriot (Bahrain): -1 chip (-36 ints.)',
        'summaries: country, location, then "-1 chip (-36 ints.)" for one Patriot load ' + JSON.stringify(r.blue.slice(0, 3)));
  check(r.blue.includes('Patriot (Qatar): -3 chips (-108 ints.)'), 'summaries: a three-system Patriot entry emptied is three chips');
  check(r.thaadChip === '-1 chip' && r.half === '-0.5 chips' && r.label === 'THAAD', 'summaries: chip wording and THAAD short label');
  check(JSON.stringify(r.red) === JSON.stringify(['Totals by Class', 'SRBMs: -10', 'Drones: -500',
                                                   'Short-Range Ballistic Missiles', 'Fateh-110: -10', 'Drones', 'Geran-2: -500']),
        'summaries: Red class totals, then losses summed by platform (Geran-2 200+150+150 = -500) ' + JSON.stringify(r.red));
  check(JSON.stringify(r.redTotals) === JSON.stringify(['Totals by Class', 'SRBMs: -10', 'Drones: -500']), 'summaries: Red totals block comes first');

  // Blue totals: "Group: System: -used (remaining/starting)", groups in order, numbers consistent
  const tl = r.blueTotals.slice(1).map(l => /^(United States|Israel|Ally\/Partner): (.+): -([\d.]+) \(([\d.]+)\/([\d.]+)\)$/.exec(l));
  check(r.blueTotals[0] === 'Totals by Interceptor and Operator' && tl.length > 0 && tl.every(Boolean),
        'summaries: Blue totals lines read "Group: System: -n (left/start)" ' + JSON.stringify(r.blueTotals));
  const order = ['United States', 'Israel', 'Ally/Partner'];
  check(tl.every((m, i) => i === 0 || order.indexOf(tl[i - 1][1]) <= order.indexOf(m[1])), 'summaries: Blue totals ordered U.S., Israel, Ally/Partner');
  check(tl.every(m => { const e = r.exp[m[1] + ': ' + m[2]]; return e && +m[5] === e.start && +m[4] === e.end && Math.abs(+m[5] - +m[4] - +m[3]) < 1e-6; }),
        'summaries: Blue totals match laydown inventory, and starting − expended = remaining');
  const patUsed = r.blue.filter(l => /^Patriot \((Bahrain|Qatar|Saudi Arabia|United Arab Emirates|Kuwait|Oman)\)/.test(l))
                        .reduce((n, l) => n + +/\(-([\d.]+) ints\.\)/.exec(l)[1], 0);
  const patTot  = tl.find(m => m[1] === 'Ally/Partner' && m[2] === 'Patriot');
  check(patTot && +patTot[3] === patUsed, `summaries: Ally/Partner Patriot total is the sum of the partner Patriot lines (${patUsed})`);
  check(errs.length === 0, 'summaries: no page errors ' + JSON.stringify(errs));
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Overrides re-run the attack and every later history entry
// ─────────────────────────────────────────────────────────────────────────────
async function checkOverrideReplay(browser, base) {
  console.log('\n── override replay ──');
  const page = await browser.newPage();
  const errs = collectErrors(page);
  // Tel Nof alone: an F-15I patrol (100 shots, full Pk on 25 per type) and one
  // David's Sling (36 shots) with one reserve chip. Nothing else in range.
  const LAYDOWN = { version: '1.0', defaults: { tel_nof_ab: [
    { id: 'tn_cap', system: 'f15i_patrol',  quantity: 1, notes: '', operator: 'Israel', chips: 1 },
    { id: 'tn_ds',  system: 'davids_sling', quantity: 1, notes: '', operator: 'Israel', chips: 2 } ] } };
  const fresh = async () => {
    await page.goto(base + '/index.html'); await page.waitForFunction(() => window._appReady === true, { timeout: 20000 });
    await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForFunction(() => window._appReady === true);
    await page.evaluate(l => { appAttrition = null; window._setSeed(0); window._importLaydownDirect(l); _resetSimulationHistory(); }, LAYDOWN);
  };
  const queue = attacks => page.evaluate(a => { window._importAttackQueueDirect({ version: '1.0', attacks: a }); window._simulateQueueDirect(); }, attacks);
  const TN = n => ({ targetId: 'tel_nof_ab', platforms: [{ platformId: 'shahed_136', quantity: n }] });
  const helpers = `
    window.__eng  = (r, id) => r.byThreatType.flatMap(t => t.platforms.flatMap(p => p.engagements)).find(e => e.defId === id) || null;
    window.__show = i => { navigateToSnapshot(i); };`;

  // 1. Layers that did not fire the first time engage the extra leakers
  await fresh(); await queue([TN(10)]); await page.evaluate(helpers);
  const r1 = await page.evaluate(() => {
    const orig = __eng(simHistory[1].results, 'tn_ds');
    selectedTargetId = 'tel_nof_ab'; _loadTargetState('tel_nof_ab');   // view the attack's results
    applyLayerOverride('drone', 'shahed_136', 'tn_cap', 5, false, 5);   // CAP kills 5 of 10
    const d = _computeDisplayResults();
    return { orig, cap: __eng(d, 'tn_cap'), ds: __eng(d, 'tn_ds'), out: d.totalOut, live: globalMagState.tn_ds, snapAfter: simHistory[1].magStateAfter.tn_ds };
  });
  check(r1.orig === null && r1.ds && r1.ds.threatsIn === 5 && r1.ds.killed > 0, 'replay: a layer that never fired now engages the extra leakers ' + JSON.stringify(r1.ds && { in: r1.ds.threatsIn, killed: r1.ds.killed }));
  check(r1.cap.killed === 5 && r1.cap.interceptorsUsed === 10 && r1.cap.isManualOverride, 'replay: the overridden layer keeps its kills and spends shots on every threat it engaged');
  check(r1.live === r1.ds.magazineRemaining && r1.snapAfter === r1.ds.magazineRemaining && r1.out === 5 - r1.ds.killed, 'replay: its interceptors come off the live magazine and the history entry');

  // 2. Later attacks are re-simulated from the new magazines; clearing restores them exactly
  await fresh(); await queue([TN(30), TN(60)]); await page.evaluate(helpers);
  const r2 = await page.evaluate(() => {
    const origA2 = JSON.stringify(simHistory[2].results), origAfter1 = JSON.stringify(simHistory[1].magStateAfter);
    const ds2Before = __eng(simHistory[2].results, 'tn_ds');
    __show(1);
    applyLayerOverride('drone', 'shahed_136', 'tn_cap', 20, false, 10);   // CAP kills 10 of 30 instead of 25
    const s1 = simHistory[1], s2 = simHistory[2];
    const ds1 = __eng(_snapshotShownResults(s1), 'tn_ds'), ds2 = __eng(s2.results, 'tn_ds');
    const out = {
      ds1In: ds1.threatsIn, s1Ds: s1.magStateAfter.tn_ds, s2Pre: s2.preSimMagState.tn_ds, ds2Start: ds2.magazineAtStart,
      ds2UsedBefore: ds2Before.interceptorsUsed, ds2Used: ds2.interceptorsUsed, s2After: s2.magStateAfter.tn_ds, ds2Rem: ds2.magazineRemaining,
      statsOk: s2.stats.totalOut === s2.results.totalOut, live: globalMagState.tn_ds,
      printOk: /David's Sling/.test(window._buildPrintDocument())
    };
    clearAllOverrides();
    out.restored = JSON.stringify(simHistory[2].results) === origA2 && JSON.stringify(simHistory[1].magStateAfter) === origAfter1;
    return out;
  });
  check(r2.ds1In === 20 && r2.s1Ds < 36, 'replay: the edited attack sends 20 drones to David\'s Sling ' + JSON.stringify(r2));
  check(r2.s2Pre === r2.s1Ds && r2.ds2Start === r2.s1Ds, 'replay: the next attack starts from the new magazine');
  check(r2.ds2Used !== r2.ds2UsedBefore && r2.ds2Used <= r2.s1Ds && r2.s2After === r2.ds2Rem && r2.statsOk, 'replay: the next attack is re-simulated (interceptor use and leakers follow the shortage)');
  check(r2.live === r2.s1Ds, 'replay: the live magazine matches the history entry being viewed');
  check(r2.restored, 'replay: clearing the override restores later attacks exactly (same draws)');

  // 3. A reload in between is redone, and the live reserve follows when the session is at the end
  await fresh(); await queue([TN(30)]); await page.evaluate(() => performGlobalReload());
  await page.evaluate(() => {   // queue the second attack without resetting the history
    attackQueue.push({ id: 'q_e2e', targetId: 'tel_nof_ab', targetName: 'Tel Nof Air Base', targetCountry: 'Israel', manifest: [{ platformId: 'shahed_136', count: 60 }] });
    window._simulateQueueDirect();
  });
  await page.evaluate(helpers);
  const r3 = await page.evaluate(() => {
    const before = { res: simHistory[2].reloadsState.tn_ds, label: simHistory[2].label, a3: JSON.stringify(simHistory[3].results), live: findDefenseEntryById('tn_ds').reloads };
    // View attack 1 while the session stays at the end (as the target menu does)
    const s1 = simHistory[1];
    lastSimResults = JSON.parse(JSON.stringify(s1.results)); lastSimDefenses = JSON.parse(JSON.stringify(s1.allDefenses));
    preSimMagState = JSON.parse(JSON.stringify(s1.preSimMagState)); manualOverrides = {}; lastSimSnapshotId = s1.id; lastSimTarget = getTarget('tel_nof_ab');
    applyLayerOverride('drone', 'shahed_136', 'tn_cap', 20, false, 10);
    return { before, res: simHistory[2].reloadsState.tn_ds, label: simHistory[2].label, a3Same: JSON.stringify(simHistory[3].results) === before.a3,
             a3Pre: simHistory[3].preSimMagState.tn_ds, live: findDefenseEntryById('tn_ds').reloads, cursor: simHistoryCursor };
  });
  check(r3.before.res > 0 && r3.res === 0 && /\+36 missiles/.test(r3.label), 'replay: the reload is redone with the bigger refill (reserve chip spent) ' + JSON.stringify({ was: r3.before.res, now: r3.res, label: r3.label }));
  check(r3.a3Pre === 36 && r3.a3Same, 'replay: the attack after the reload starts full again, so its result is unchanged');
  check(r3.cursor === 3 && r3.live === 0, 'replay: the live reserve chips follow the redone reload');

  // 5. Incoming count changed after simulating: added at that layer, earlier layers unchanged
  await fresh(); await queue([TN(10)]); await page.evaluate(helpers);
  const r5 = await page.evaluate(() => {
    selectedTargetId = 'tel_nof_ab'; _loadTargetState('tel_nof_ab');
    applyIncomingOverride('drone', 'shahed_136', 'tn_ds', 6);   // the CAP killed all 10; 6 more reach David's Sling
    const d = _computeDisplayResults();
    const headline = document.querySelector('.final-headline')?.textContent || '';
    const badge = document.querySelector('.override-badge--incoming')?.textContent.replace(/\s+/g, ' ').trim() || '';
    return { cap: __eng(d, 'tn_cap'), ds: __eng(d, 'tn_ds'), added: d.totalAdded, out: d.totalOut, headline, badge,
             live: globalMagState.tn_ds, stats: simHistory[1].stats, ov: JSON.stringify(manualOverrides) };
  });
  check(r5.cap.threatsIn === 10 && r5.cap.killed === 10 && r5.ds && r5.ds.threatsIn === 6 && r5.ds.incomingFrom === 0 && r5.added === 6,
        'incoming: 6 set to reach a layer the first run never reached; the layer before keeps its result ' + JSON.stringify(r5.ds && { in: r5.ds.threatsIn, from: r5.ds.incomingFrom }));
  check(r5.live === r5.ds.magazineRemaining && r5.stats.totalAdded === 6 && r5.headline.includes(`of 16`) === (r5.out > 0),
        'incoming: interceptors come off, the history entry and headline count the 6 added ' + JSON.stringify({ headline: r5.headline, stats: r5.stats }));
  check(/6 in \(was 0\)/.test(r5.badge) && r5.ov === '{"drone":{"shahed_136":{"tn_ds":{"incoming":6}}}}', 'incoming: the row shows "6 in (was 0)" and only the incoming count is stored ' + r5.badge);

  // 6. Incoming change on an older attack re-simulates the later ones
  await fresh(); await queue([TN(30), TN(60)]); await page.evaluate(helpers);
  const r6 = await page.evaluate(() => {
    const origA2 = JSON.stringify(simHistory[2].results);
    const dsUsedA2 = __eng(simHistory[2].results, 'tn_ds').interceptorsUsed;
    __show(1);
    applyIncomingOverride('drone', 'shahed_136', 'tn_ds', 0);   // none of the 5 leakers reach David's Sling
    const ds1 = __eng(_snapshotShownResults(simHistory[1]), 'tn_ds'), ds2 = __eng(simHistory[2].results, 'tn_ds');
    const out = { ds1In: ds1?.threatsIn ?? null, ds1Used: ds1?.interceptorsUsed ?? null, a2Pre: simHistory[2].preSimMagState.tn_ds ?? 'full', a2Start: ds2.magazineAtStart, a2Used: ds2.interceptorsUsed, dsUsedA2 };
    clearLayerOverride('drone', 'shahed_136', 'tn_ds', 'incoming');
    out.restored = JSON.stringify(simHistory[2].results) === origA2 && Object.keys(manualOverrides).length === 0;
    return out;
  });
  check(r6.ds1In === 0 && r6.ds1Used === 0 && (r6.a2Pre === 'full' || r6.a2Pre === 36) && r6.a2Start === 36 && r6.a2Used !== r6.dsUsedA2,
        'incoming: removing the leakers at a layer leaves it full, and the next attack is re-simulated from that ' + JSON.stringify(r6));
  check(r6.restored, 'incoming: clearing the incoming count restores the later attack exactly');

  // 7. Set before simulating, in the manifest: applied when the attack runs, then editable like any override
  await fresh(); await page.evaluate(helpers);
  await page.selectOption('#target-select', 'tel_nof_ab');
  await page.evaluate(() => addPlatformToManifest('shahed_136', 10));
  await page.click('.btn-manifest-layers[data-pid="shahed_136"]');
  const editorRows = await page.locator('.manifest-layer-input').count();
  await page.fill('.manifest-layer-input[data-def="tn_ds"]', '6');
  await page.press('.manifest-layer-input[data-def="tn_ds"]', 'Tab');
  const btnText = (await page.textContent('.btn-manifest-layers[data-pid="shahed_136"]')).trim();
  await page.click('#btn-simulate');
  await page.waitForSelector('.override-badge--incoming', { timeout: 5000 });
  const r7 = await page.evaluate(() => {
    const s = simHistory[simHistory.length - 1];
    return { ov: JSON.stringify(s.manualOverrides), dsIn: __eng(_snapshotShownResults(s), 'tn_ds')?.threatsIn, rawDs: __eng(s.results, 'tn_ds'),
             live: globalMagState.tn_ds, after: s.magStateAfter.tn_ds };
  });
  check(editorRows === 2 && btnText === 'Layers (1)', 'preset: the manifest editor lists the CAP and David\'s Sling, and counts the one set (' + btnText + ')');
  check(r7.ov === '{"drone":{"shahed_136":{"tn_ds":{"incoming":6}}}}' && r7.dsIn === 6 && r7.rawDs === null && r7.live === r7.after,
        'preset: the attack runs with 6 reaching David\'s Sling, stored as an override on the result ' + JSON.stringify({ ov: r7.ov, dsIn: r7.dsIn }));
  await page.click('.override-badge--incoming .btn-clear-override');
  const r7b = await page.evaluate(() => ({ ov: Object.keys(simHistory[simHistory.length - 1].manualOverrides).length, ds: globalMagState.tn_ds ?? 'full', rows: document.querySelectorAll('.engagement-row').length,
                                           layers: attackManifest[0].layers ?? null, btn: document.querySelector('.btn-manifest-layers').textContent.trim() }));
  check(r7b.ov === 0 && (r7b.ds === 'full' || r7b.ds === 36) && r7b.rows === 1, 'preset: clearing it on the result returns the interceptors and the row ' + JSON.stringify(r7b));
  check(r7b.layers === null && r7b.btn === 'Layers', 'preset: clearing it on the result also clears it in the manifest (no second attack re-applies it) ' + JSON.stringify(r7b));

  // 7c. After simulating, the Layers editor edits the shown attack in place — no second attack
  const hist0 = await page.evaluate(() => simHistory.length);
  const head = await page.textContent('.manifest-layers-head');
  await page.fill('.manifest-layer-input[data-def="tn_ds"]', '9');
  await page.press('.manifest-layer-input[data-def="tn_ds"]', 'Tab');
  const r7c = await page.evaluate(() => ({ hist: simHistory.length, dsIn: __eng(_computeDisplayResults(), 'tn_ds')?.threatsIn, snapOv: JSON.stringify(simHistory[simHistory.length - 1].manualOverrides),
                                           focus: document.activeElement?.className, btn: document.querySelector('.btn-manifest-layers').textContent.trim() }));
  await page.fill('.manifest-layer-input[data-def="tn_ds"]', '');
  await page.press('.manifest-layer-input[data-def="tn_ds"]', 'Tab');
  const r7d = await page.evaluate(() => ({ hist: simHistory.length, ov: Object.keys(manualOverrides).length, rows: document.querySelectorAll('.engagement-row').length, layers: attackManifest[0].layers ?? null }));
  check(/re-simulate the attack shown below/.test(head) && r7c.hist === hist0 && r7c.dsIn === 9 && r7c.snapOv === '{"drone":{"shahed_136":{"tn_ds":{"incoming":9}}}}' && r7c.btn === 'Layers (1)',
        'live layers: after simulating, the editor re-simulates the shown attack in place (no new history entry) ' + JSON.stringify(r7c));
  check(r7d.hist === hist0 && r7d.ov === 0 && r7d.rows === 1 && r7d.layers === null, 'live layers: blanking the box undoes it on the shown attack ' + JSON.stringify(r7d));

  // 7e. Simulating the same manifest again asks first, and Cancel adds nothing
  await page.click('#btn-simulate');
  await page.waitForSelector('#modal-overlay:not(.hidden)', { timeout: 3000 });
  const modal = await page.textContent('#modal-overlay');
  await page.click('#modal-overlay button:has-text("Cancel")');
  const hist1 = await page.evaluate(() => simHistory.length);
  check(/second attack/.test(modal) && /no need to simulate again/.test(modal) && hist1 === hist0, 'live layers: simulating the same manifest again warns that it is a second attack; Cancel adds none');

  // 8. Pre-set counts ride along in the queue
  await page.fill('.manifest-layer-input[data-def="tn_ds"]', '6');
  await page.press('.manifest-layer-input[data-def="tn_ds"]', 'Tab');
  await page.evaluate(() => { addToQueue(); });
  const qLabel = await page.textContent('#queue-list');
  const r8 = await page.evaluate(() => { window._simulateQueueDirect(); const s = simHistory[simHistory.length - 1]; return { ov: JSON.stringify(s.manualOverrides), pts: JSON.stringify(perTargetState.tel_nof_ab.manualOverrides) }; });
  check(/1 layer count set/.test(qLabel) && r8.ov === '{"drone":{"shahed_136":{"tn_ds":{"incoming":6}}}}' && r8.pts === r8.ov, 'preset: a queued attack keeps and applies its layer counts');

  // 4. A replay with no change reproduces the recorded result, THAAD shot rolls included
  await page.goto(base + '/index.html'); await page.waitForFunction(() => window._appReady === true);
  await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForFunction(() => window._appReady === true);
  const r4 = await page.evaluate(() => {
    window._setSeed(7);
    window._importAttackQueueDirect({ version: '1.0', attacks: [{ targetId: 'abu_dhabi', platforms: [{ platformId: 'khorramshahr', quantity: 12 }] }] });
    window._simulateQueueDirect();
    const s = simHistory[simHistory.length - 1];
    return { keys: Object.keys(s.draws || {}).length, same: JSON.stringify(_replayAttack(s, s.preSimMagState)) === JSON.stringify(s.results) };
  });
  check(r4.keys > 0 && r4.same, 'replay: an attack with THAAD shot rolls records its draws and replays identically ' + JSON.stringify(r4));
  const realErrs = errs.filter(e => !/status of 403/.test(e));   // map tiles refused for 127.0.0.1
  check(realErrs.length === 0, 'replay: no page errors ' + JSON.stringify(realErrs));
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Organic attrition before the first defenses
// ─────────────────────────────────────────────────────────────────────────────
async function checkAttrition(browser, base) {
  console.log('\n── attrition ──');
  const page = await browser.newPage();
  const errs = collectErrors(page);
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window._appReady === true, { timeout: 20000 });
  await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForFunction(() => window._appReady === true);
  const r = await page.evaluate(() => {
    const ids = ['dubai', 'manama', 'baghdad', 'riyadh', 'jeddah', 'muscat', 'seeb_ab', 'tel_aviv', 'amman',
                 'persian_gulf_place_point', 'strait_of_hormuz_place_point', 'gulf_of_oman_place_point', 'red_sea_place_point', 'mediterranean_sea_place_point'];
    const rates = Object.fromEntries(ids.map(id => { const a = _attritionFor(id); return [id, [a.drone, a.cruise_missile, a.fpv, a.mrbm, a.srbm]]; }));
    const unset = appTargetCatalog.filter(t => !(_attritionFor(t.id).drone > 0)).map(t => t.id);
    window._setSeed(0);
    window._importAttackQueueDirect({ version: '1.0', attacks: [
      { targetId: 'tel_aviv', platforms: [{ platformId: 'shahed_136', quantity: 250 }, { platformId: 'khorramshahr', quantity: 10 }, { platformId: 'paveh_quds', quantity: 20 }] },
      { targetId: 'dubai',    platforms: [{ platformId: 'shahed_136', quantity: 250 }] } ] });
    window._simulateQueueDirect();
    const s1 = simHistory[1], s2 = simHistory[2];
    const plat = (res, pid) => res.byThreatType.flatMap(t => t.platforms).find(p => p.platformId === pid);
    const sh = plat(s1.results, 'shahed_136'), mr = plat(s1.results, 'khorramshahr'), cm = plat(s1.results, 'paveh_quds');
    const firstIn = p => p.engagements[0]?.threatsIn ?? null;
    // the results panel for Tel Aviv
    const sel = document.getElementById('target-select'); sel.value = 'tel_aviv'; sel.dispatchEvent(new Event('change'));
    const table = [...document.querySelectorAll('.attrition-table tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()).join('|'));
    const foot  = [...document.querySelectorAll('.attrition-table tfoot td')].map(td => td.textContent.trim()).join('|');
    const summaryFirst = document.querySelector('#results-summary .summary-attrition') !== null
      && document.querySelector('#results-summary').compareDocumentPosition(document.querySelector('#results-layers')) & Node.DOCUMENT_POSITION_FOLLOWING;
    const d = document.createElement('div'); d.innerHTML = window._buildPrintDocument();
    const redLine = [...d.querySelectorAll('.pr-sum-line')].map(e => e.textContent).find(t => /^Shahed-136:/.test(t));
    return {
      rates, unset,
      sh: [sh.initialCount, sh.attritionLost, sh.attritionPct, firstIn(sh)], mr: [mr.initialCount, mr.attritionLost, firstIn(mr)], cm: [cm.initialCount, cm.attritionLost, firstIn(cm)],
      dubai: [plat(s2.results, 'shahed_136').attritionLost, firstIn(plat(s2.results, 'shahed_136'))],
      stored: JSON.stringify(s1.attrition), stats: s1.stats, replay: JSON.stringify(_replayAttack(s1, s1.preSimMagState)) === JSON.stringify(s1.results),
      table, foot, summaryFirst: !!summaryFirst, redLine, printHasArrive: /Arrive/.test(d.innerHTML)
    };
  });
  const R = r.rates;
  check(R.dubai[0] === 5 && R.manama[0] === 5 && R.baghdad[0] === 5 && R.riyadh[0] === 10 && R.jeddah[0] === 10 && R.muscat[0] === 10 && R.seeb_ab[0] === 10
        && R.tel_aviv[0] === 15 && R.amman[0] === 15, 'attrition: drones lose 5% at Gulf states and Iraq, 10% in Saudi Arabia and Oman, 15% in Israel and Jordan ' + JSON.stringify(R));
  check(R.persian_gulf_place_point[0] === 5 && R.strait_of_hormuz_place_point[0] === 5 && R.gulf_of_oman_place_point[0] === 5
        && R.red_sea_place_point[0] === 10 && R.mediterranean_sea_place_point[0] === 15, 'attrition: water points 5% (Gulf waters), 10% (Red Sea), 15% (Mediterranean)');
  check(Object.values(R).every(v => v[0] === v[1] && v[1] === v[2] && v[3] === 5 && v[4] === 5), 'attrition: cruise missiles and FPVs follow the drone rate; ballistic missiles lose 5% everywhere');
  check(r.unset.length === 0, 'attrition: every location has a drone/cruise-missile rate ' + JSON.stringify(r.unset));
  check(JSON.stringify(r.sh) === '[250,37,15,213]' && JSON.stringify(r.mr) === '[10,0,10]' && JSON.stringify(r.cm) === '[20,3,17]',
        'attrition: Tel Aviv — 250 Shaheds → 213 reach the first layer (212.5 rounded up), 10 MRBMs → 10 (9.5 up), 20 cruise missiles → 17 ' + JSON.stringify([r.sh, r.mr, r.cm]));
  check(JSON.stringify(r.dubai) === '[12,238]', 'attrition: Dubai — 250 Shaheds → 238 arrive ' + JSON.stringify(r.dubai));
  check(r.stored === '{"mrbm":5,"srbm":5,"cruise_missile":15,"drone_jet":15,"drone":15,"fpv":15}' && r.stats.totalAttrited === 40 && r.replay,
        'attrition: the history entry keeps its rates and lost count, and replays identically ' + r.stored);
  check(r.summaryFirst && r.table.includes('Shahed-136|250|−37|15%|213') && r.table.includes('Khorramshahr|10|0|5%|10') && r.foot === 'Total|280|−40||240',
        'attrition: the results open with launched → lost → arrive per platform ' + JSON.stringify({ t: r.table, f: r.foot }));
  check(r.redLine === 'Shahed-136: -500' && r.printHasArrive, 'attrition: Red still loses every platform launched; the PDF shows arrivals ' + r.redLine);
  const realErrs = errs.filter(e => !/status of 403/.test(e));
  check(realErrs.length === 0, 'attrition: no page errors ' + JSON.stringify(realErrs));
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Water place points: littoral partners' systems enabled by default
// ─────────────────────────────────────────────────────────────────────────────
async function checkWaterCoverage(browser, base) {
  console.log('\n── water coverage ──');
  const page = await browser.newPage();
  const errs = collectErrors(page);
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window._appReady === true, { timeout: 20000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload(); await page.waitForFunction(() => window._appReady === true);
  const r = await page.evaluate(() => {
    const off = (tid, operator) => isCrossTargetDefenseDisabled(tid, { id: 'probe_' + operator, operator });
    const rule = {
      hormuzOman: off('strait_of_hormuz_place_point', 'Oman'), hormuzUae: off('strait_of_hormuz_place_point', 'United Arab Emirates'),
      hormuzIsrael: off('strait_of_hormuz_place_point', 'Israel'), hormuzUs: off('strait_of_hormuz_place_point', 'United States'),
      gulfOman: off('persian_gulf_place_point', 'Oman'), gulfQatar: off('persian_gulf_place_point', 'Qatar'),
      medIsrael: off('mediterranean_sea_place_point', 'Israel'), dohaUae: off('doha', 'United Arab Emirates')
    };
    // Red Sea: Saudi THAAD at Jeddah (62 km) is in range and now on by default; Israel's Arrow stays off
    const cover = getCrossTargetDefenses('red_sea_place_point');
    const thaad = cover.find(d => d.system === 'thaad' && d.operator === 'Saudi Arabia');
    const arrow = cover.find(d => d.system === 'arrow');
    const before = { thaad: thaad && isCrossTargetDefenseDisabled('red_sea_place_point', thaad), arrow: arrow && isCrossTargetDefenseDisabled('red_sea_place_point', arrow) };
    toggleCrossTargetDefenseDisabled('red_sea_place_point', thaad);
    const toggled = isCrossTargetDefenseDisabled('red_sea_place_point', thaad);
    toggleCrossTargetDefenseDisabled('red_sea_place_point', thaad);
    // A stored target object without the field still gets its littoral operators
    const t = getTarget('strait_of_hormuz_place_point'); delete t.coverage_operators;
    const stored = off('strait_of_hormuz_place_point', 'Oman');
    return { rule, hasThaad: !!thaad, before, toggled, stored };
  });
  const x = r.rule;
  check(!x.hormuzOman && !x.hormuzUae && x.hormuzIsrael && !x.hormuzUs, 'water: Strait of Hormuz enables Oman, UAE, U.S. by default, not Israel ' + JSON.stringify(x));
  check(x.gulfOman && !x.gulfQatar && !x.medIsrael, 'water: each point uses its own littoral list (Persian Gulf, Mediterranean)');
  check(x.dohaUae, 'water: land targets keep the old rule (UAE system off at Doha)');
  check(r.hasThaad && r.before.thaad === false && r.before.arrow === true, 'water: Saudi THAAD at Jeddah covers the Red Sea by default; Arrow stays excluded ' + JSON.stringify(r.before));
  check(r.toggled === true, 'water: the per-system toggle still overrides the default');
  check(r.stored === false, 'water: the list comes from targets.json, not the stored target object');
  check(errs.length === 0, 'water: no page errors ' + JSON.stringify(errs));
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
  check(!after.formOpen, 'blue: after an add the form closes ' + JSON.stringify(after));

  await center(`${card} .tc-btn-add`); await page.click(`${card} .tc-btn-add`);
  const reopened = await page.evaluate(c => ({ system: document.querySelector(`${c} .tc-system`).value, operator: document.querySelector(`${c} .tc-operator`).value, chips: document.querySelector(`${c} .tc-chips`).value }), card);
  check(reopened.system === '' && reopened.operator === 'United States' && reopened.chips === '1', 'blue: reopening the form starts from the defaults ' + JSON.stringify(reopened));
  await page.keyboard.press('Escape');   // close the System list that opening the form shows
  await page.click(`${card} .tc-operator`); await page.keyboard.type('Bah'); await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.click(`${card} .tc-system`);
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

  // Fractional chips in the add form; invalid chips are refused
  await center(`${card} .tc-btn-add`); await page.click(`${card} .tc-btn-add`);   // the form closed after the last add
  await page.keyboard.type('nasams'); await page.keyboard.press('Enter');   // → Quantity
  await page.keyboard.press('Enter');                                       // → Operator
  await page.keyboard.press('Enter');                                       // → Chips
  await page.keyboard.type('abc'); await page.keyboard.press('Enter');
  const stayed = await active();
  await page.keyboard.type('0.5'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  const nas = (await entries()).find(e => e.system === 'nasams');
  check(stayed.includes('tc-chips') && nas && nas.chips === 0.5, 'blue: chips accept 0.5 typed in the form; "abc" is refused and focus stays ' + JSON.stringify(nas));

  // Click-to-edit an added system's chips: Enter saves, clicking away saves, Escape cancels, bad text is refused
  const rowChip = async sys => page.evaluate(([c, s]) => { const i = window._blueState().laydown.doha.findIndex(e => e.system === s);
    return document.querySelectorAll(`${c} .tc-defense-row`)[i]?.querySelector('.tc-chips-edit')?.textContent; }, [card, sys]);
  const clickChip = async sys => { const i = (await entries()).findIndex(e => e.system === sys);
    const sel = `${card} .tc-defense-row:nth-child(${i + 1}) .tc-chips-edit`; await center(sel); await page.click(sel); };
  await clickChip('patriot');
  const editing = await page.evaluate(() => document.activeElement.className);
  await page.keyboard.type('2.5'); await page.keyboard.press('Enter');
  const ce1 = { label: await rowChip('patriot'), value: (await entries()).find(e => e.system === 'patriot').chips };
  await clickChip('patriot'); await page.keyboard.type('3'); await page.click(`${card} .target-card-name`);
  const ce2 = (await entries()).find(e => e.system === 'patriot').chips;
  await clickChip('patriot'); await page.keyboard.type('9'); await page.keyboard.press('Escape');
  const ce3 = (await entries()).find(e => e.system === 'patriot').chips;
  await clickChip('patriot'); await page.keyboard.type('-2'); await page.keyboard.press('Enter');
  const ce4 = { value: (await entries()).find(e => e.system === 'patriot').chips, label: await rowChip('patriot') };
  check(editing.includes('tc-chips-input') && ce1.value === 2.5 && ce1.label === '2.5 chips', 'blue: clicking a chip count opens it for editing; Enter saves 2.5 ' + JSON.stringify(ce1));
  check(ce2 === 3 && ce3 === 3 && ce4.value === 3 && ce4.label === '3 chips', `blue: clicking away saves (3), Escape cancels, "-2" is refused (${ce2}, ${ce3}, ${JSON.stringify(ce4)})`);
  await page.reload(); await page.waitForFunction(() => window._blueReady === true);
  const persisted = (await entries()).find(e => e.system === 'patriot').chips;
  check(persisted === 3, 'blue: an edited chip count survives a page reload (' + persisted + ')');

  // Editing a row keeps an open add form and what was typed in it
  await center(`${card} .tc-btn-add`); await page.click(`${card} .tc-btn-add`);
  await page.fill(`${card} .tc-notes`, 'keep me');
  await clickChip('nasams'); await page.keyboard.type('1.25'); await page.keyboard.press('Enter');
  const kept = await page.evaluate(c => ({ open: !document.querySelector(`${c} .tc-add-form`).classList.contains('hidden'), notes: document.querySelector(`${c} .tc-notes`).value }), card);
  check(kept.open && kept.notes === 'keep me' && (await entries()).find(e => e.system === 'nasams').chips === 1.25, 'blue: editing a row keeps the open add form ' + JSON.stringify(kept));

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
  check(ex[0].system === 'patriot' && ex[0].quantity === 4 && ex[0].operator === 'Bahrain' && ex[0].chips === 3 && ex.find(e => e.system === 'nasams').chips === 1.25,
        'blue: export carries the typed and edited chip counts (3, 1.25)');

  // Export names: blank → blue_laydown_<date>_<time> for both the file and its name; a typed name is kept
  const dlName = async () => { const [d] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-laydown')]);
    return { file: d.suggestedFilename(), name: JSON.parse(fs.readFileSync(await d.path(), 'utf8')).name }; };
  await page.fill('#laydown-name', ''); const n1 = await dlName();
  await page.fill('#laydown-name', 'Gulf Plan'); const n2 = await dlName();
  await page.fill('#laydown-name', 'Blue Laydown'); const n3 = await dlName();
  check(/^blue_laydown_\d{4}-\d\d-\d\d_\d{4}$/.test(n1.name) && n1.file === n1.name + '.json' && n2.name === 'Gulf Plan' && n2.file === 'gulf_plan_laydown.json'
        && n3.file === 'blue_laydown.json', 'blue: a blank name exports as blue_laydown_<date>_<time>; a typed name is kept, without a doubled suffix ' + JSON.stringify([n1, n2, n3]));

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

  // Export names: blank → red_attacks_<date>_<time>; a typed name is kept
  await page.selectOption(`${col} .rc-target`, 'doha');
  const dlName = async () => { const [d] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-attacks')]);
    return { file: d.suggestedFilename(), name: JSON.parse(fs.readFileSync(await d.path(), 'utf8')).name }; };
  await page.fill('#attacks-name', ''); const n1 = await dlName();
  await page.fill('#attacks-name', 'Opening Salvo'); const n2 = await dlName();
  await page.fill('#attacks-name', 'Red Attacks'); const n3 = await dlName();
  check(/^red_attacks_\d{4}-\d\d-\d\d_\d{4}$/.test(n1.name) && n1.file === n1.name + '.json' && n2.name === 'Opening Salvo' && n2.file === 'opening_salvo_attacks.json'
        && n3.file === 'red_attacks.json', 'red: a blank name exports as red_attacks_<date>_<time>; a typed name is kept, without a doubled suffix ' + JSON.stringify([n1, n2, n3]));

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
  if (!ONLY || ONLY === 'tool' || ONLY === 'water') await checkWaterCoverage(browser, base);
  if (!ONLY || ONLY === 'tool' || ONLY === 'replay') await checkOverrideReplay(browser, base);
  if (!ONLY || ONLY === 'tool' || ONLY === 'attrition') await checkAttrition(browser, base);
  if (!ONLY || ONLY === 'tool' || ONLY === 'reload') await checkReloadAndSwitching(browser, base);
  if (!ONLY || ONLY === 'tool' || ONLY === 'export') await checkLaydownExport(browser, base);
  if (!ONLY || ONLY === 'tool' || ONLY === 'patrols') await checkIndependentPatrols(browser, base);
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
